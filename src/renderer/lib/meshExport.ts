// Mesh export serializers. Pure functions that turn a MeshEntry's geometry +
// materials into the file payloads a user saves. No DOM / IPC here so the logic
// stays unit-testable; the actual save-to-disk lives in PointCloudViewer (native
// dialog + fs via preload IPC), mirroring how ./qsmExport is wired.
//
// The reason this module exists: an OBJ carrying `usemtl` groups is only half a
// model. Without the sibling `.mtl` (and the images it names) a generated plant
// re-imports as untextured grey geometry — the export doesn't round-trip. So the
// OBJ writer here emits the whole bundle: geometry + material library + texture
// images, all cross-referenced by name.

import type { MeshData, PlantMaterialDef } from './pointCloudTypes';

// One file in an export bundle. Text files carry a string; texture images carry
// raw bytes (already base64-decoded) so the caller writes them binary-exact.
export interface MeshExportFile {
  name: string;
  // Exactly one of these is set.
  text?: string;
  bytes?: Uint8Array;
}

// Strip characters that are unsafe in filenames across macOS/Windows and in an
// MTL material name (which is whitespace-delimited). Empty result falls back to
// `fallback`.
export function sanitizeMeshName(name: string, fallback = 'mesh'): string {
  const cleaned = name
    .replace(/[/\\:*?"<>|]/g, '_') // path separators + Windows-reserved chars
    .replace(/\s+/g, '_')
    .replace(/_+/g, '_')
    .replace(/^[_.]+|[_.]+$/g, '')
    .trim();
  return cleaned.length > 0 ? cleaned : fallback;
}

/**
 * File extension matching an image buffer's magic number.
 *
 * Never trust a material's flags or its original name for this: the same trap
 * that made bark textures ship as `.png` when the bytes were JPEG. Downstream
 * readers (Helios, Blender, three.js) pick a decoder from the suffix, so a
 * mismatch is a hard load error. Returns null for anything we can't identify —
 * the caller then writes the material's flat colour and skips `map_Kd` rather
 * than naming a file no reader can open.
 */
export function imageExtFromBytes(bytes: Uint8Array): string | null {
  if (bytes.length >= 8 &&
      bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47 &&
      bytes[4] === 0x0d && bytes[5] === 0x0a && bytes[6] === 0x1a && bytes[7] === 0x0a) {
    return '.png';
  }
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) {
    return '.jpg';
  }
  return null;
}

// Decode a base64 texture payload to bytes. Materials carry their image as
// base64 (that's how it crosses the HTTP boundary from the backend); the export
// has to hand real bytes to fs.writeBinary. Returns null on malformed input so a
// single bad material can't abort the whole export.
export function decodeBase64(data: string): Uint8Array | null {
  try {
    const bin = atob(data);
    const out = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
    return out;
  } catch {
    return null;
  }
}

// A material resolved for writing: its sanitized (unique) MTL name, its colour,
// and — when it carries a usable image — the texture file to write beside the OBJ.
interface ResolvedMaterial {
  mtlName: string;
  color?: [number, number, number];
  hasAlpha: boolean;
  textureFile?: MeshExportFile;
  triangleIndices: number[];
}

// Quantisation for grouping untextured triangles by vertex colour. Colours come
// from float arrays, so exact equality would split visually identical organs into
// separate materials on a float wobble; 1/1000 is far finer than the eye (and
// than an 8-bit channel) while still collapsing that noise.
const COLOR_KEY_SCALE = 1000;

function colorKey(r: number, g: number, b: number): string {
  return `${Math.round(r * COLOR_KEY_SCALE)},${Math.round(g * COLOR_KEY_SCALE)},${Math.round(b * COLOR_KEY_SCALE)}`;
}

/**
 * Build materials for the triangles no supplied material claims, grouping them by
 * their vertex colour.
 *
 * Why this is needed: on a generated plant, only textured organs (leaves) get a
 * material — the backend deliberately leaves flat-coloured organs (petioles,
 * internodes, stems, flowers) out of `material_groups` because they render from
 * vertex colours. On a bean that is ~72% of the triangles. OBJ has no portable
 * per-vertex colour (the `v x y z r g b` extension is an unofficial dialect our
 * own importer doesn't read), and the importer reconstructs colour from each
 * triangle's material `Kd` — so `Kd` via `usemtl` is the only channel that
 * actually round-trips. Writing these under one flat grey `default` was what made
 * petioles and internodes come back the wrong colour.
 *
 * Real plants use a handful of distinct organ colours (3 on a 20-day bean), so
 * this stays compact. Returns [] when there are no vertex colours to group by,
 * leaving the caller's `default` fallback in charge.
 */
function materialsForUnclaimed(
  data: MeshData,
  claimed: Uint8Array,
  usedNames: Set<string>,
): ResolvedMaterial[] {
  const { vertexColors, indices, triangleCount } = data;
  if (!vertexColors || vertexColors.length < data.vertexCount * 3) return [];

  const byColor = new Map<string, { color: [number, number, number]; tris: number[] }>();
  for (let t = 0; t < triangleCount; t++) {
    if (claimed[t]) continue;
    // Flat-shaded organs carry one colour across the triangle, so the first
    // vertex is representative (this is exactly how the importer rebuilds it).
    const v = indices[t * 3];
    const r = vertexColors[v * 3], g = vertexColors[v * 3 + 1], b = vertexColors[v * 3 + 2];
    const key = colorKey(r, g, b);
    const entry = byColor.get(key);
    if (entry) entry.tris.push(t);
    else byColor.set(key, { color: [r, g, b], tris: [t] });
  }
  if (byColor.size === 0) return [];

  return [...byColor.values()].map(({ color, tris }, i) => {
    let mtlName = `color_${i}`;
    let n = 2;
    while (usedNames.has(mtlName)) mtlName = `color_${i}_${n++}`;
    usedNames.add(mtlName);
    return { mtlName, color, hasAlpha: false, triangleIndices: tris };
  });
}

/**
 * The mean vertex colour over a material's triangles, or undefined when the mesh
 * carries no usable vertex colours.
 *
 * Used as the `Kd` for a material that declares no colour of its own. Generated
 * plants set `color` only on UNtextured materials — a textured leaf arrives with
 * `color: null` — so without this the leaf materials would be written as the grey
 * 0.8 fallback, and re-import grey.
 *
 * Note we deliberately do NOT write the conventional `Kd 1 1 1` for a textured
 * material (the "let map_Kd pass through unmodified" idiom, since renderers
 * multiply the two). Our importer copies `Kd` straight into per-vertex colours
 * whether or not the material is textured (see `/api/mesh/import` in main.py), and
 * those vertex colours are the viewer's fallback when a texture isn't applied — so
 * `1 1 1` would round-trip every leaf as WHITE. What this value has to answer is
 * "what colour is this organ when you can't see its texture", and the geometry
 * already knows.
 *
 * Sampling the first vertex of each triangle matches how the importer reconstructs
 * colour. Mean rather than mode: for every material we actually emit, all triangles
 * share one flat colour, so the two agree — and where they wouldn't, an average is
 * a better answer than one arbitrarily-chosen triangle's colour. The pass is one
 * read of three floats per triangle: ~0.04 ms for a 15k-triangle plant, ~2 ms at a
 * million, against tens of ms of string building in the writer below.
 */
function meanTriangleColor(
  data: MeshData,
  triangleIndices: number[],
): [number, number, number] | undefined {
  const { vertexColors, indices, triangleCount } = data;
  if (!vertexColors || vertexColors.length < data.vertexCount * 3) return undefined;
  let r = 0, g = 0, b = 0, n = 0;
  for (const t of triangleIndices) {
    if (t < 0 || t >= triangleCount) continue;
    const v = indices[t * 3];
    r += vertexColors[v * 3]; g += vertexColors[v * 3 + 1]; b += vertexColors[v * 3 + 2];
    n++;
  }
  return n > 0 ? [r / n, g / n, b / n] : undefined;
}

/**
 * Resolve each material to a unique MTL name and (when its texture bytes decode
 * to a format readers understand) a texture filename derived from that name.
 *
 * Texture names are synthesized rather than preserved: the import path keeps only
 * the decoded image, not the filename it came from, so there's nothing to
 * preserve. Deriving `<material>.<ext>` keeps the bundle self-consistent and
 * collision-free.
 */
function resolveMaterials(
  materials: PlantMaterialDef[],
  baseName: string,
  used: Set<string>,
  data: MeshData,
): ResolvedMaterial[] {
  return materials.map((mat, idx) => {
    let mtlName = sanitizeMeshName(mat.name || `material_${idx}`, `material_${idx}`);
    if (used.has(mtlName)) {
      let n = 2;
      while (used.has(`${mtlName}_${n}`)) n++;
      mtlName = `${mtlName}_${n}`;
    }
    used.add(mtlName);

    let textureFile: MeshExportFile | undefined;
    if (mat.textureData) {
      const bytes = decodeBase64(mat.textureData);
      const ext = bytes ? imageExtFromBytes(bytes) : null;
      // Both must hold: undecodable data or an unrecognised format means we
      // write the flat colour instead of pointing map_Kd at an unreadable file.
      if (bytes && ext) {
        textureFile = { name: `${baseName}_${mtlName}${ext}`, bytes };
      }
    }

    const triangleIndices = mat.triangleIndices ?? [];
    return {
      mtlName,
      // Fall back to the material's own geometry when it declares no colour.
      color: mat.color ?? meanTriangleColor(data, triangleIndices),
      hasAlpha: mat.hasAlpha,
      textureFile,
      triangleIndices,
    };
  });
}

// Format a float the way the OBJ/MTL writers do everywhere else in the app.
const f6 = (n: number): string => (Number.isFinite(n) ? n : 0).toFixed(6);

/**
 * Serialize a mesh to an OBJ bundle: the `.obj` itself, plus — when the mesh
 * carries materials — a sibling `.mtl` and one image file per textured material.
 *
 * `baseName` is the stem of the user's chosen filename; every file in the bundle
 * is named from it, and the OBJ's `mtllib` / the MTL's `map_Kd` reference those
 * names relatively, so the bundle stays valid wherever the user drops it.
 *
 * Geometry notes:
 *  - UVs are written back V-flipped (`1 - v`). The importer flips OBJ's V-down
 *    space into three.js's V-up on the way in (see qsm/obj_loader.py), so the
 *    export must undo it or every texture lands upside down on re-import.
 *  - Faces are emitted grouped by material (`usemtl` per group). Triangles no
 *    supplied material claims are grouped by their VERTEX COLOUR into generated
 *    materials, because `Kd` is the only colour channel that survives the OBJ
 *    round-trip — see materialsForUnclaimed. Anything still unaccounted for goes
 *    in a trailing `default` group, so no triangle is ever lost.
 */
export function serializeMeshObj(
  data: MeshData,
  opts: {
    baseName: string;
    materials?: PlantMaterialDef[];
    // Provenance comment lines (e.g. the Helios plant type/age), written after
    // the banner.
    comments?: string[];
  },
): MeshExportFile[] {
  const { vertices, indices, normals, uvCoordinates, vertexCount, triangleCount } = data;
  const baseName = sanitizeMeshName(opts.baseName);

  // Material names must be unique across BOTH sets (supplied + colour-derived),
  // since they share one MTL namespace.
  const usedNames = new Set<string>();

  // A material list is only usable if at least one material actually claims
  // triangles — otherwise it tells us nothing about which face gets what.
  const supplied = (opts.materials ?? []).some(m => (m.triangleIndices?.length ?? 0) > 0)
    ? resolveMaterials(opts.materials ?? [], baseName, usedNames, data)
    : [];

  // Which triangles the supplied materials actually cover. First claim wins, so
  // overlapping groups can't duplicate a face.
  const claimed = new Uint8Array(triangleCount);
  for (const mat of supplied) {
    for (const t of mat.triangleIndices) {
      if (t >= 0 && t < triangleCount) claimed[t] = 1;
    }
  }

  // Everything else gets a material derived from its vertex colour, so flat-
  // coloured organs come back the right colour instead of a flat grey.
  const colorMaterials = materialsForUnclaimed(data, claimed, usedNames);
  const resolved = [...supplied, ...colorMaterials];

  // UVs are per-vertex; a length mismatch means they don't map to this geometry,
  // so drop them rather than emit garbage vt indices.
  const hasUVs = !!uvCoordinates && uvCoordinates.length === vertexCount * 2;
  const textureFiles = resolved
    .map(m => m.textureFile)
    .filter((f): f is MeshExportFile => !!f);

  const lines: string[] = [
    '# Mesh exported from Phytograph',
    `# ${vertexCount} vertices, ${triangleCount} triangles`,
    ...(opts.comments ?? []).map(c => `# ${c}`),
  ];
  if (resolved.length > 0) lines.push(`mtllib ${baseName}.mtl`);

  for (let i = 0; i < vertexCount; i++) {
    lines.push(`v ${f6(vertices[i * 3])} ${f6(vertices[i * 3 + 1])} ${f6(vertices[i * 3 + 2])}`);
  }
  if (hasUVs) {
    for (let i = 0; i < vertexCount; i++) {
      // Undo the importer's V-flip so the OBJ is in OBJ's own V-down space.
      lines.push(`vt ${f6(uvCoordinates![i * 2])} ${f6(1 - uvCoordinates![i * 2 + 1])}`);
    }
  }
  if (normals) {
    for (let i = 0; i < vertexCount; i++) {
      lines.push(`vn ${f6(normals[i * 3])} ${f6(normals[i * 3 + 1])} ${f6(normals[i * 3 + 2])}`);
    }
  }

  // One face line. OBJ indices are 1-based, and a v/vt/vn triple must omit the
  // slots the file doesn't carry (`v//vn` when there are normals but no UVs).
  const faceLine = (tri: number): string => {
    const parts: string[] = [];
    for (let k = 0; k < 3; k++) {
      const i = indices[tri * 3 + k] + 1;
      if (hasUVs && normals) parts.push(`${i}/${i}/${i}`);
      else if (hasUVs) parts.push(`${i}/${i}`);
      else if (normals) parts.push(`${i}//${i}`);
      else parts.push(`${i}`);
    }
    return `f ${parts.join(' ')}`;
  };

  // Whether the OBJ ends up emitting a `usemtl default` group — the MTL must
  // then declare it, since an OBJ naming a material its library doesn't define
  // loads with a warning (or a black surface) in some readers.
  let usedDefault = false;

  if (resolved.length === 0) {
    for (let t = 0; t < triangleCount; t++) lines.push(faceLine(t));
  } else {
    // Group faces under their material. First claim wins, so overlapping
    // material groups can't duplicate a face. Triangles no material claims are
    // still written — silently dropping them would shrink the mesh on export.
    const written = new Uint8Array(triangleCount);
    for (const mat of resolved) {
      const tris = mat.triangleIndices.filter(t => t >= 0 && t < triangleCount && !written[t]);
      if (tris.length === 0) continue;
      lines.push(`usemtl ${mat.mtlName}`);
      for (const t of tris) {
        written[t] = 1;
        lines.push(faceLine(t));
      }
    }
    // Only reachable when the mesh has no vertex colours to derive a material
    // from (colour grouping otherwise covers every unclaimed triangle).
    const orphans: number[] = [];
    for (let t = 0; t < triangleCount; t++) if (!written[t]) orphans.push(t);
    if (orphans.length > 0) {
      usedDefault = true;
      lines.push('usemtl default');
      for (const t of orphans) lines.push(faceLine(t));
    }
  }

  const files: MeshExportFile[] = [{ name: `${baseName}.obj`, text: lines.join('\n') }];
  if (resolved.length > 0) {
    files.push({ name: `${baseName}.mtl`, text: serializeMtl(resolved, usedDefault) });
    files.push(...textureFiles);
  }
  return files;
}

/**
 * Serialize the material library. Each material gets a diffuse colour (`Kd`) and,
 * when it has a usable image, `map_Kd`. Alpha-carrying textures also get `map_d`
 * pointing at the same image plus `d 1.0`, which is how OBJ readers pick up a
 * cutout mask — without it a leaf re-imports as an opaque quad.
 */
function serializeMtl(materials: ResolvedMaterial[], includeDefault: boolean): string {
  const lines: string[] = ['# Material library exported from Phytograph', ''];
  for (const mat of materials) {
    const c = mat.color ?? [0.8, 0.8, 0.8];
    lines.push(`newmtl ${mat.mtlName}`);
    lines.push(`Ka ${f6(c[0])} ${f6(c[1])} ${f6(c[2])}`);
    lines.push(`Kd ${f6(c[0])} ${f6(c[1])} ${f6(c[2])}`);
    lines.push('Ks 0.000000 0.000000 0.000000');
    lines.push('d 1.000000');
    lines.push('illum 1');
    if (mat.textureFile) {
      lines.push(`map_Kd ${mat.textureFile.name}`);
      // A PNG with real alpha is a leaf cutout; point the dissolve map at it so
      // the mask survives the round-trip.
      if (mat.hasAlpha) lines.push(`map_d ${mat.textureFile.name}`);
    }
    lines.push('');
  }
  if (includeDefault) {
    lines.push('newmtl default');
    lines.push('Ka 0.800000 0.800000 0.800000');
    lines.push('Kd 0.800000 0.800000 0.800000');
    lines.push('Ks 0.000000 0.000000 0.000000');
    lines.push('d 1.000000');
    lines.push('illum 1');
    lines.push('');
  }
  return lines.join('\n');
}

/** Serialize a mesh to ASCII PLY (geometry only — PLY carries no materials). */
export function serializeMeshPly(
  data: MeshData,
  opts: { comments?: string[] } = {},
): string {
  const { vertices, indices, vertexCount, triangleCount } = data;
  const lines: string[] = [
    'ply',
    'format ascii 1.0',
    'comment Mesh exported from Phytograph',
    ...(opts.comments ?? []).map(c => `comment ${c}`),
    `element vertex ${vertexCount}`,
    'property float x',
    'property float y',
    'property float z',
    `element face ${triangleCount}`,
    'property list uchar int vertex_indices',
    'end_header',
  ];
  for (let i = 0; i < vertexCount; i++) {
    lines.push(`${f6(vertices[i * 3])} ${f6(vertices[i * 3 + 1])} ${f6(vertices[i * 3 + 2])}`);
  }
  for (let i = 0; i < triangleCount; i++) {
    lines.push(`3 ${indices[i * 3]} ${indices[i * 3 + 1]} ${indices[i * 3 + 2]}`);
  }
  return lines.join('\n');
}

/** Serialize a mesh to ASCII STL, with per-facet normals computed from winding. */
export function serializeMeshStl(data: MeshData): string {
  const { vertices, indices, triangleCount } = data;
  const lines: string[] = ['solid mesh'];
  for (let i = 0; i < triangleCount; i++) {
    const i0 = indices[i * 3], i1 = indices[i * 3 + 1], i2 = indices[i * 3 + 2];
    const v0 = [vertices[i0 * 3], vertices[i0 * 3 + 1], vertices[i0 * 3 + 2]];
    const v1 = [vertices[i1 * 3], vertices[i1 * 3 + 1], vertices[i1 * 3 + 2]];
    const v2 = [vertices[i2 * 3], vertices[i2 * 3 + 1], vertices[i2 * 3 + 2]];
    const u = [v1[0] - v0[0], v1[1] - v0[1], v1[2] - v0[2]];
    const v = [v2[0] - v0[0], v2[1] - v0[1], v2[2] - v0[2]];
    const n = [u[1] * v[2] - u[2] * v[1], u[2] * v[0] - u[0] * v[2], u[0] * v[1] - u[1] * v[0]];
    const len = Math.sqrt(n[0] * n[0] + n[1] * n[1] + n[2] * n[2]) || 1;
    lines.push(`  facet normal ${f6(n[0] / len)} ${f6(n[1] / len)} ${f6(n[2] / len)}`);
    lines.push('    outer loop');
    lines.push(`      vertex ${f6(v0[0])} ${f6(v0[1])} ${f6(v0[2])}`);
    lines.push(`      vertex ${f6(v1[0])} ${f6(v1[1])} ${f6(v1[2])}`);
    lines.push(`      vertex ${f6(v2[0])} ${f6(v2[1])} ${f6(v2[2])}`);
    lines.push('    endloop');
    lines.push('  endfacet');
  }
  lines.push('endsolid mesh');
  return lines.join('\n');
}
