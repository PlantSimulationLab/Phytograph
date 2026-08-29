// QSM export serializers. Pure functions that turn a built QSMEntry into a file
// payload string. No DOM / IPC here so the logic stays unit-testable; the actual
// save-to-disk lives in PointCloudViewer (native dialog + fs via preload IPC).
//
// Three formats:
//   - csv : SimpleForest-compatible per-cylinder table. The de-facto
//           TreeQSM-interoperable interchange — rTwig (import_qsm) and aRchi
//           (read_QSM model="simpleforest") read this layout. Readers ignore
//           unknown trailing columns, so the surf-cov / mad quality columns are
//           safe extras beyond the SimpleForest core.
//   - obj : triangulated tube mesh (with normals), for Blender / CloudCompare /
//           MeshLab.
//   - ply : same geometry as OBJ, ASCII, with per-face branch_order + radius
//           so downstream viewers can color by branching order.
//
// The OBJ/PLY geometry is built by the SHARED tube builder in ./qsmTube, the same
// one the viewport renderer uses — so the exported mesh is the mesh the user saw.
// Previously these exporters emitted an independent capped cylinder per cylinder
// (world-referenced ring frames, unreconciled joints, stepped radii), which read as
// a pile of disjoint cylinders in Blender while the viewport showed a smooth tube.

import type { QSMEntry } from './pointCloudTypes';
import {
  DEFAULT_TEXTURE_TILE_SIZE,
  buildShootPolylines,
  cylinderAxis,
  cylinderLength,
  sweepTube,
} from './qsmTube';
import type { Vec3 } from './qsmTube';
import {
  decodeBase64,
  imageExtFromBytes,
  resolveMaterials,
  type MeshExportFile,
} from './meshExport';
import {
  rankColorRgb,
  shootColorSrgb,
  hexToRgb,
  linearToSrgb,
  type QSMColorMode,
} from './qsmColors';

export type QSMExportFormat = 'csv' | 'obj' | 'ply';

// Radial segments per exported tube ring. Higher than the viewport's default 8:
// the viewport trades roundness for interactive framerate on a whole tree, while an
// export is written once and then lives in Blender/CloudCompare, where the extra
// fidelity is worth the file size.
const TUBE_SEGMENTS = 12;

// Re-exported for callers that already import these from here.
export { cylinderAxis, cylinderLength };

export function qsmExtForFormat(fmt: QSMExportFormat): string {
  return fmt; // 'csv' | 'obj' | 'ply' all double as the extension
}

// Strip characters that are unsafe in filenames across macOS/Windows, collapse
// whitespace, and trim. Also drops a trailing source extension (labels are often
// a source file name like 'tree.xyz', and the export appends its own .csv/.obj/
// .ply — so keeping it would suggest 'tree.xyz.csv'). Empty result falls back to
// 'qsm'.
export function sanitizeQsmFilename(name: string): string {
  return sanitizeQsmStem(name.replace(/\.[A-Za-z0-9]{1,5}$/, '')); // drop source ext
}

/**
 * Filesystem-sanitize a stem that is ALREADY a stem — the part of a path the user
 * typed, with its extension removed by the caller.
 *
 * Deliberately does NOT strip a trailing `.xyz`, unlike sanitizeQsmFilename: a user
 * who saves as `tree.v2.obj` means the stem `tree.v2`, and eating the `.v2` would
 * make the OBJ's `mtllib tree.mtl` name a file we never wrote — a dangling
 * reference that loads as untextured grey, the very bug the MTL exists to fix.
 * Inner dots are kept for that reason; only leading/trailing ones are trimmed.
 */
export function sanitizeQsmStem(name: string): string {
  const cleaned = name
    .replace(/[/\\:*?"<>|]/g, '_') // path separators + Windows-reserved chars
    .replace(/\s+/g, '_')
    .replace(/_+/g, '_')
    .replace(/^[_.]+|[_.]+$/g, '') // no leading/trailing dots or underscores
    .trim();
  return cleaned.length > 0 ? cleaned : 'qsm';
}

// --- geometry ---------------------------------------------------------------

/**
 * One shoot's swept tube, plus the per-ring attributes the PLY needs. Rings map
 * 1:1 to polyline nodes, so a face's attributes come from the ring it starts on.
 */
interface ShootTube {
  positions: Vec3[];
  normals: Vec3[];
  /** Tile-unit texture coordinates, parallel to `positions` (see qsmTube). */
  uvs: [number, number][];
  faces: [number, number, number][];
  ringStride: number;
  shootId: number;
  rank: number;
  /** Per-node radius, indexed by ring. */
  radii: number[];
}

/**
 * Build the export geometry for a whole QSM: one continuous tube per shoot, via the
 * same shared builder the viewport renders. Shoots whose polyline is too short to
 * sweep are skipped.
 */
export function buildQsmTubes(
  qsm: QSMEntry,
  segments = TUBE_SEGMENTS,
  tileSize = DEFAULT_TEXTURE_TILE_SIZE,
): ShootTube[] {
  const out: ShootTube[] = [];
  for (const poly of buildShootPolylines(qsm.cylinders, qsm.shoots)) {
    const swept = sweepTube(poly.nodes, poly.radii, segments, [0, 0, 0], tileSize);
    if (!swept) continue;
    out.push({
      positions: swept.positions,
      normals: swept.normals,
      uvs: swept.uvs,
      faces: swept.faces,
      ringStride: swept.ringStride,
      shootId: poly.shootId,
      rank: poly.rank,
      radii: poly.radii,
    });
  }
  return out;
}

// --- CSV --------------------------------------------------------------------

// SimpleForest column layout. Verified against rTwig's importer source
// (standardise_qsm / update_cylinders, SimpleForest branch): its detection gate
// needs ID/parentID/branchID/branchOrder, and its FIRST mutate unconditionally
// references segmentID + parentSegmentID — so those two are REQUIRED, not
// optional, for the file to load. segmentID maps to our continuous shoot, and
// parentSegmentID to that shoot's parent shoot (-1 for the trunk), matching the
// root convention in rTwig's bundled QSM.csv (root parentID = parentSegmentID =
// -1). growthLength / reverseBranchOrder are derived by rTwig when absent, so we
// leave them out. surfaceCoverage / meanAbsDeviation are our own quality extras
// (readers ignore unknown trailing columns).
const CSV_HEADER =
  'ID,parentID,branchID,branchOrder,segmentID,parentSegmentID,' +
  'startX,startY,startZ,endX,endY,endZ,' +
  'axisX,axisY,axisZ,radius,length,surfaceCoverage,meanAbsDeviation';

function num(x: number): string {
  // Compact but lossless enough for downstream tools; trims trailing zeros.
  return Number.isFinite(x) ? String(x) : '';
}

export function qsmToCylinderCsv(qsm: QSMEntry): string {
  // Parent-shoot lookup for parentSegmentID: each cylinder's shoot -> its parent
  // shoot id (-1 for the trunk / a root shoot).
  const parentShootByShoot = new Map<number, number>();
  for (const s of qsm.shoots) parentShootByShoot.set(s.shoot_id, s.parent_shoot_id);

  const lines: string[] = [CSV_HEADER];
  for (const c of qsm.cylinders) {
    const axis = cylinderAxis(c) ?? [0, 0, 0];
    const len = cylinderLength(c);
    const parentSegment = parentShootByShoot.has(c.shoot_id)
      ? parentShootByShoot.get(c.shoot_id)!
      : -1;
    lines.push(
      [
        c.cyl_id,
        c.parent_id,
        c.shoot_id,        // branchID
        c.rank,            // branchOrder
        c.shoot_id,        // segmentID — our continuous shoot is the segment
        parentSegment,     // parentSegmentID
        num(c.start[0]), num(c.start[1]), num(c.start[2]),
        num(c.end[0]), num(c.end[1]), num(c.end[2]),
        num(axis[0]), num(axis[1]), num(axis[2]),
        num(c.radius),
        num(len),
        c.surf_cov == null ? '' : num(c.surf_cov),
        c.mad == null ? '' : num(c.mad),
      ].join(','),
    );
  }
  return lines.join('\n') + '\n';
}

// --- OBJ --------------------------------------------------------------------

/**
 * Appearance the OBJ should reproduce — the same settings driving the viewport,
 * so the exported bundle looks like what the user is looking at. Omitted entirely
 * (the default) means 'rank' with the standard palette, which is the viewer's own
 * default.
 */
export interface QSMObjAppearance {
  colorMode?: QSMColorMode;
  /** Flat tree color for colorMode='color' (hex, e.g. '#8b6f47'). */
  solidColor?: string;
  /** Base64 bark image + its MIME type, for colorMode='texture'. */
  barkTexture?: { data: string; mime: string } | null;
  /** World-space edge length (m) of one bark tile. Defaults to Helios' 0.25 m. */
  textureTileSize?: number;
}

// Fallback bark brown, mirroring the viewport's BARK_FALLBACK — used when texture
// mode is selected but the image is missing/undecodable, so the tree exports a
// plausible wood colour rather than white.
const BARK_FALLBACK: [number, number, number] = hexToRgb('#8b6f47');

const f6 = (n: number): string => (Number.isFinite(n) ? n : 0).toFixed(6);

// One material the OBJ groups faces under, plus the shoots it claims.
interface QsmMaterial {
  mtlName: string;
  color: [number, number, number];
  /** Texture image to write beside the OBJ, when this material is textured. */
  textureFile?: MeshExportFile;
  /**
   * Whether the texture carries a real alpha channel, i.e. it's a CUTOUT. True
   * only for leaves; bark tiles opaquely. Drives `map_d` in the MTL — without it
   * a leaf re-imports as an opaque rectangle instead of a leaf-shaped one.
   */
  hasAlpha?: boolean;
  /**
   * Whether `color` is in three.js's LINEAR working space and must be encoded to
   * sRGB before it is written to `Kd`.
   *
   * The two sources genuinely differ, so this can't be assumed either way: the
   * tube colours come from lib/qsmColors, which defines the palette directly in
   * **sRGB** (the space a hex swatch and a `Kd` are both written in), while the
   * leaf colours come from meshExport's resolveMaterials, which reads them off
   * `MeshData.vertexColors` — held **linear**, because that is what three.js
   * requires of a `color` BufferAttribute. Getting this wrong is invisible in
   * geometry and shows up only as a wrong shade.
   */
  colorIsLinear?: boolean;
}

/**
 * Assign a material to every shoot tube, per color mode.
 *
 * 'rank' / 'shoot' encode DATA as hue, so they produce one material per distinct
 * rank / per shoot — that's what makes the structure readable in Blender. 'color'
 * and 'texture' are appearance modes and collapse to a single material for the
 * whole tree.
 *
 * Exhaustive switch, not a chain of ifs: the `never` check makes the compiler
 * reject a newly-added QSMColorMode that forgets a case here, rather than
 * silently exporting everything as rank colours.
 */
function materialsForTubes(
  tubes: ShootTube[],
  appearance: QSMObjAppearance,
  baseName: string,
): { materials: QsmMaterial[]; materialOfTube: number[] } {
  const mode: QSMColorMode = appearance.colorMode ?? 'rank';
  const materials: QsmMaterial[] = [];
  const materialOfTube: number[] = new Array(tubes.length).fill(0);
  // Key -> index into `materials`, so shoots sharing a rank share one material.
  const byKey = new Map<string, number>();
  const claim = (key: string, make: () => QsmMaterial): number => {
    const existing = byKey.get(key);
    if (existing !== undefined) return existing;
    const idx = materials.length;
    materials.push(make());
    byKey.set(key, idx);
    return idx;
  };

  switch (mode) {
    case 'rank':
      tubes.forEach((t, i) => {
        materialOfTube[i] = claim(`rank_${t.rank}`, () => ({
          mtlName: `rank_${t.rank}`,
          color: rankColorRgb(t.rank),
        }));
      });
      break;
    case 'shoot':
      tubes.forEach((t, i) => {
        materialOfTube[i] = claim(`shoot_${t.shootId}`, () => ({
          mtlName: `shoot_${t.shootId}`,
          color: shootColorSrgb(t.shootId),
        }));
      });
      break;
    case 'color': {
      const idx = claim('solid', () => ({
        mtlName: 'qsm_color',
        color: hexToRgb(appearance.solidColor ?? '#8b6f47'),
      }));
      materialOfTube.fill(idx);
      break;
    }
    case 'texture': {
      // Decode the bark image so the bundle ships the actual file the MTL names.
      // Extension comes from the MAGIC BYTES, never the declared mime/name — a
      // JPEG written as .png is a hard load error in Blender/three.js (the same
      // trap that bit the plant-mesh textures). An undecodable image degrades to
      // the flat bark colour rather than naming a file no reader can open.
      const bytes = appearance.barkTexture?.data
        ? decodeBase64(appearance.barkTexture.data)
        : null;
      const ext = bytes ? imageExtFromBytes(bytes) : null;
      const textureFile: MeshExportFile | undefined =
        bytes && ext ? { name: `${baseName}_bark${ext}`, bytes } : undefined;
      const idx = claim('bark', () => ({
        mtlName: 'bark',
        // White under a diffuse map so the image shows its true colours (Kd
        // multiplies map_Kd); the fallback brown only when there is no map.
        color: textureFile ? [1, 1, 1] : BARK_FALLBACK,
        textureFile,
      }));
      materialOfTube.fill(idx);
      break;
    }
    default: {
      const _exhaustive: never = mode;
      void _exhaustive;
      tubes.forEach((t, i) => {
        materialOfTube[i] = claim(`rank_${t.rank}`, () => ({
          mtlName: `rank_${t.rank}`,
          color: rankColorRgb(t.rank),
        }));
      });
    }
  }
  return { materials, materialOfTube };
}

/** Serialize the QSM material library. */
function serializeQsmMtl(materials: QsmMaterial[]): string {
  const lines: string[] = ['# Material library exported from Phytograph', ''];
  for (const mat of materials) {
    // `Kd` is always sRGB; encode only the sources that are held linear.
    const c = mat.colorIsLinear
      ? (mat.color.map(linearToSrgb) as [number, number, number])
      : mat.color;
    lines.push(`newmtl ${mat.mtlName}`);
    lines.push(`Ka ${f6(c[0])} ${f6(c[1])} ${f6(c[2])}`);
    lines.push(`Kd ${f6(c[0])} ${f6(c[1])} ${f6(c[2])}`);
    lines.push('Ks 0.000000 0.000000 0.000000');
    lines.push('d 1.000000');
    lines.push('illum 1');
    if (mat.textureFile) {
      lines.push(`map_Kd ${mat.textureFile.name}`);
      // `map_d` ONLY for a real alpha cutout (leaves). Bark tiles opaquely across
      // the tube, so pointing a dissolve map at it would punch holes in the trunk
      // wherever the photo happened to carry an alpha channel.
      if (mat.hasAlpha) lines.push(`map_d ${mat.textureFile.name}`);
    }
    lines.push('');
  }
  return lines.join('\n');
}

/**
 * Serialize a QSM's tube mesh to an OBJ bundle: the `.obj`, a sibling `.mtl`, and
 * — in texture mode — the bark image the MTL names.
 *
 * Why a bundle and not just the OBJ: an OBJ carries no colour of its own. Without
 * the MTL the tree arrived in Blender/CloudCompare as untextured grey geometry, so
 * every distinction the user set up in the viewport — rank palette, per-shoot hues,
 * their chosen tree colour, the bark photo — was silently dropped on export. `Kd`
 * via `usemtl` is the only colour channel that portably survives OBJ.
 *
 * Leaves, when the QSM has them, are appended as a final `o leaves` group with
 * their own textured (alpha-cutout) materials — the viewport draws them as part of
 * the tree, so an export without them hands the user a bare winter skeleton.
 *
 * Each shoot stays its own `o shoot_<id>_rank_<n>` group (separable objects in
 * Blender) and additionally gets a `usemtl`. Vertex normals are written (`vn`)
 * because they're the smooth swept normals from the tube frame — without them a
 * viewer computes flat per-face normals and the tube looks faceted. UVs (`vt`) are
 * written only in texture mode, where they're what makes the bark tile; they're
 * V-flipped on the way out to undo the importer's V-up convention, matching
 * serializeMeshObj.
 */
export function qsmToCylinderMeshObjBundle(
  qsm: QSMEntry,
  opts: { baseName: string } & QSMObjAppearance,
): MeshExportFile[] {
  const baseName = sanitizeQsmStem(opts.baseName);
  const textured = (opts.colorMode ?? 'rank') === 'texture';
  const tubes = buildQsmTubes(
    qsm,
    TUBE_SEGMENTS,
    opts.textureTileSize && opts.textureTileSize > 0
      ? opts.textureTileSize
      : DEFAULT_TEXTURE_TILE_SIZE,
  );
  const { materials, materialOfTube } = materialsForTubes(tubes, opts, baseName);

  const lines: string[] = [
    `# Phytograph QSM tube mesh`,
    `# one continuous tube per shoot (matches the Phytograph viewport)`,
    `# cylinders: ${qsm.cylinders.length}  shoots: ${tubes.length}`,
  ];
  // `mtllib` must precede the first `usemtl`, so it is emitted here — before the
  // leaves pass appends its own materials to `materials`. Safe because the tube
  // materials are never empty (every color mode yields at least one), so the
  // library is always written; the leaves only ever ADD to it.
  if (materials.length > 0) lines.push(`mtllib ${baseName}.mtl`);

  // OBJ keeps THREE INDEPENDENT 1-based index spaces (v, vt, vn) that each count
  // only the lines of their own kind. For the tubes alone one counter sufficed,
  // because every ring vertex emits a v, a vn and (in texture mode) a vt in
  // lockstep. It stops being true once leaves join: the tubes skip `vt` entirely
  // outside texture mode, so a leaf's UV indices would be offset by the tube
  // vertex count that never wrote any. Hence a separate vt counter.
  let vOffset = 0;
  let vtOffset = 0;
  tubes.forEach((t, ti) => {
    lines.push(`o shoot_${t.shootId}_rank_${t.rank}`);
    for (const p of t.positions) lines.push(`v ${p[0]} ${p[1]} ${p[2]}`);
    if (textured) {
      // Undo the importer's V-flip so the OBJ is in OBJ's own V-down space.
      for (const uv of t.uvs) lines.push(`vt ${f6(uv[0])} ${f6(1 - uv[1])}`);
    }
    for (const nrm of t.normals) lines.push(`vn ${nrm[0]} ${nrm[1]} ${nrm[2]}`);
    const mat = materials[materialOfTube[ti]];
    if (mat) lines.push(`usemtl ${mat.mtlName}`);
    for (const f of t.faces) {
      const a = f[0] + 1 + vOffset;
      const b = f[1] + 1 + vOffset;
      const c = f[2] + 1 + vOffset;
      lines.push(
        textured
          ? `f ${a}/${a}/${a} ${b}/${b}/${b} ${c}/${c}/${c}`
          : `f ${a}//${a} ${b}//${b} ${c}//${c}`,
      );
    }
    vOffset += t.positions.length;
    if (textured) vtOffset += t.uvs.length;
  });

  // --- leaves -----------------------------------------------------------------
  // A QSM with foliage added (the Add Leaves tool) renders leaves in the viewport
  // as part of the tree, so an export that dropped them handed the user a bare
  // winter skeleton. The leaf mesh is already built in the SAME world frame as the
  // cylinders (both sit under one group in the viewer, and the render-only
  // displayOffset is applied inside the tube build, never baked into the data), so
  // the vertices append as-is with no frame conversion.
  //
  // Materials come from meshExport's resolveMaterials — the same resolver the
  // plant-mesh OBJ export uses — rather than a second copy of the texture-decode
  // and alpha rules here. Leaf textures are alpha CUTOUTS, so they need `map_d`
  // (handled via hasAlpha above); without it every leaf re-imports as an opaque
  // rectangle.
  const leaves = qsm.leaves;
  if (leaves && leaves.data.triangleCount > 0) {
    const d = leaves.data;
    const leafMats = resolveMaterials(
      leaves.plantMaterials ?? [],
      baseName,
      // Share the tube materials' name set so a leaf material can't collide with
      // (and silently override) a `rank_0` / `bark` already in the library.
      new Set(materials.map(m => m.mtlName)),
      d,
    );
    const hasLeafUVs = !!d.uvCoordinates && d.uvCoordinates.length === d.vertexCount * 2;
    const hasLeafNormals = !!d.normals && d.normals.length === d.vertexCount * 3;

    lines.push(`o leaves`);
    for (let i = 0; i < d.vertexCount; i++) {
      lines.push(`v ${d.vertices[i * 3]} ${d.vertices[i * 3 + 1]} ${d.vertices[i * 3 + 2]}`);
    }
    if (hasLeafUVs) {
      // V-flipped on the way out, matching serializeMeshObj: the importer flips
      // OBJ's V-down space into three.js's V-up, so the export must undo it or
      // every leaf texture lands upside down on re-import.
      for (let i = 0; i < d.vertexCount; i++) {
        lines.push(`vt ${f6(d.uvCoordinates![i * 2])} ${f6(1 - d.uvCoordinates![i * 2 + 1])}`);
      }
    }
    if (hasLeafNormals) {
      for (let i = 0; i < d.vertexCount; i++) {
        lines.push(`vn ${f6(d.normals![i * 3])} ${f6(d.normals![i * 3 + 1])} ${f6(d.normals![i * 3 + 2])}`);
      }
    }

    // One face line, in whichever v/vt/vn combination this mesh actually carries —
    // a triple naming a slot the file never wrote is a parse error in strict
    // readers. Each index space gets its OWN offset (see above).
    const leafFace = (tri: number): string => {
      const parts: string[] = [];
      for (let k = 0; k < 3; k++) {
        const li = d.indices[tri * 3 + k];
        const v = li + 1 + vOffset;
        const vt = li + 1 + vtOffset;
        const vn = li + 1 + vOffset;
        if (hasLeafUVs && hasLeafNormals) parts.push(`${v}/${vt}/${vn}`);
        else if (hasLeafUVs) parts.push(`${v}/${vt}`);
        else if (hasLeafNormals) parts.push(`${v}//${vn}`);
        else parts.push(`${v}`);
      }
      return `f ${parts.join(' ')}`;
    };

    // Group faces under their material, first claim winning so overlapping groups
    // can't duplicate a face. Anything unclaimed still gets written under a
    // `leaf_default` material — silently dropping triangles would shrink the mesh.
    const written = new Uint8Array(d.triangleCount);
    for (const m of leafMats) {
      const tris = m.triangleIndices.filter(
        t => t >= 0 && t < d.triangleCount && !written[t],
      );
      if (tris.length === 0) continue;
      materials.push({
        mtlName: m.mtlName,
        // resolveMaterials reads MeshData.vertexColors, which are LINEAR.
        color: m.color ?? [0.35, 0.6, 0.25], // a leaf green, not a grey
        colorIsLinear: true,
        textureFile: m.textureFile,
        hasAlpha: m.hasAlpha,
      });
      lines.push(`usemtl ${m.mtlName}`);
      for (const t of tris) {
        written[t] = 1;
        lines.push(leafFace(t));
      }
    }
    const orphans: number[] = [];
    for (let t = 0; t < d.triangleCount; t++) if (!written[t]) orphans.push(t);
    if (orphans.length > 0) {
      materials.push({ mtlName: 'leaf_default', color: [0.35, 0.6, 0.25], colorIsLinear: true });
      lines.push('usemtl leaf_default');
      for (const t of orphans) lines.push(leafFace(t));
    }
  }

  const files: MeshExportFile[] = [{ name: `${baseName}.obj`, text: lines.join('\n') + '\n' }];
  if (materials.length > 0) {
    files.push({ name: `${baseName}.mtl`, text: serializeQsmMtl(materials) });
    for (const m of materials) if (m.textureFile) files.push(m.textureFile);
  }
  return files;
}

/**
 * The OBJ text alone. Kept for callers (and tests) that only want the geometry
 * file; the material library it references comes from qsmToCylinderMeshObjBundle.
 */
export function qsmToCylinderMeshObj(qsm: QSMEntry, appearance: QSMObjAppearance = {}): string {
  const files = qsmToCylinderMeshObjBundle(qsm, { baseName: 'qsm', ...appearance });
  return files[0].text!;
}

// --- PLY --------------------------------------------------------------------

export function qsmToCylinderMeshPly(qsm: QSMEntry): string {
  const tubes = buildQsmTubes(qsm);
  const allPositions: Vec3[] = [];
  const allNormals: Vec3[] = [];
  // Each face carries the branch order of its shoot + the radius at the ring it
  // starts on. Radius is now per-node (it varies continuously along a shoot), so
  // unlike the old per-cylinder export there is no single radius for a whole tube.
  const allFaces: { tri: [number, number, number]; order: number; radius: number }[] = [];
  let vOffset = 0;
  for (const t of tubes) {
    for (const p of t.positions) allPositions.push(p);
    for (const nrm of t.normals) allNormals.push(nrm);
    for (const f of t.faces) {
      // Faces are emitted ring-pair by ring-pair; the lowest vertex index of a
      // triangle always lies on its starting ring.
      const ring = Math.floor(Math.min(f[0], f[1], f[2]) / t.ringStride);
      allFaces.push({
        tri: [f[0] + vOffset, f[1] + vOffset, f[2] + vOffset],
        order: t.rank,
        radius: t.radii[Math.min(ring, t.radii.length - 1)],
      });
    }
    vOffset += t.positions.length;
  }

  const header = [
    'ply',
    'format ascii 1.0',
    'comment Phytograph QSM tube mesh',
    'comment one continuous tube per shoot (matches the Phytograph viewport)',
    `element vertex ${allPositions.length}`,
    'property float x',
    'property float y',
    'property float z',
    'property float nx',
    'property float ny',
    'property float nz',
    `element face ${allFaces.length}`,
    'property list uchar int vertex_indices',
    'property uchar branch_order',
    'property float radius',
    'end_header',
  ];
  const body: string[] = [];
  for (let i = 0; i < allPositions.length; i++) {
    const p = allPositions[i];
    const nrm = allNormals[i];
    body.push(`${p[0]} ${p[1]} ${p[2]} ${nrm[0]} ${nrm[1]} ${nrm[2]}`);
  }
  for (const f of allFaces) {
    // branch_order is a uchar; clamp to [0,255] defensively.
    const order = Math.max(0, Math.min(255, Math.round(f.order)));
    body.push(`3 ${f.tri[0]} ${f.tri[1]} ${f.tri[2]} ${order} ${f.radius}`);
  }
  return header.concat(body).join('\n') + '\n';
}

/**
 * Dispatch helper used by the export handler. Returns the FILE BUNDLE, since an
 * OBJ is more than one file — the caller writes each entry (text or bytes) beside
 * the others so the `mtllib` / `map_Kd` references resolve.
 *
 * `baseName` names the bundle; CSV/PLY ignore it (they're single files whose name
 * the caller already chose) but OBJ needs it for its sibling filenames.
 */
export function serializeQsm(
  qsm: QSMEntry,
  fmt: QSMExportFormat,
  opts: { baseName: string } & QSMObjAppearance = { baseName: 'qsm' },
): MeshExportFile[] {
  switch (fmt) {
    case 'csv':
      return [{ name: `${opts.baseName}.csv`, text: qsmToCylinderCsv(qsm) }];
    case 'obj':
      return qsmToCylinderMeshObjBundle(qsm, opts);
    case 'ply':
      return [{ name: `${opts.baseName}.ply`, text: qsmToCylinderMeshPly(qsm) }];
  }
}
