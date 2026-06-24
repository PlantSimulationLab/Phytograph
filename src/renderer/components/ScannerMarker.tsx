import { Suspense, useEffect, useMemo, useRef } from 'react';
import { useLoader } from '@react-three/fiber';
import { OBJLoader } from 'three/examples/jsm/loaders/OBJLoader.js';
import { PLYLoader } from 'three/examples/jsm/loaders/PLYLoader.js';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import * as THREE from 'three';
import {
  getScannerModel,
  type ScannerModel,
  type ScannerModelId,
} from '../lib/scannerModels';

interface ScannerMarkerProps {
  origin: { x: number; y: number; z: number };
  // Which instrument this scan represents. Selects the mesh and its real-world
  // render height; 'generic' draws a neutral sphere. Undefined → generic.
  model?: ScannerModelId;
  color: string;
  selected?: boolean;
  // Residual scanner tilt away from plumb, in degrees (a dual-axis
  // inclinometer's two angles). Roll is applied first (about the body lateral
  // axis), then pitch (about the body forward / heading axis). Both default
  // to 0 (level). Derived from the scan's params at render time, so editing tilt
  // in the scan panel re-orients the marker live.
  tiltRollDeg?: number;
  tiltPitchDeg?: number;
  // Initial scanner heading, in degrees, defining where the body forward axis
  // points in the world XY plane. The mesh bodies are authored forward-along-+Y,
  // so heading 0 = +Y and the body is simply yawed by the heading (CCW) about
  // world +Z. Tilt axes are built relative to the resulting forward so a tilted
  // scanner leans in the right world direction. Default 0.
  azimuthOffsetDeg?: number;
  // Global size multiplier applied uniformly on top of the model's real-world
  // fit (the user's "Scan marker size" setting). 1 = real-world scale. Applied
  // to the wrapping group, so it scales the fitted mesh as a whole.
  scale?: number;
  // World-space platform path positions for a moving-platform scan. When present
  // a polyline is drawn through them (the body marker still renders at `origin`,
  // the first pose). Undefined → static scan, no path. Positions are in the same
  // (display-offset-corrected) frame as `origin`.
  trajectory?: Array<[number, number, number]>;
  // Full per-pose samples [x, y, z, qx, qy, qz, qw] for the moving-platform
  // keypoint glyphs (a sphere + an orientation arrow at each pose). Same frame as
  // `trajectory`. Undefined → no glyphs.
  poses?: Array<[number, number, number, number, number, number, number]>;
  // First-pose platform attitude (Hamilton qx,qy,qz,qw) for a moving scan. When
  // present the marker body is oriented by this instead of the static tilt/
  // heading (which don't apply to a moving scan). Undefined → use tilt/heading.
  bodyQuaternion?: [number, number, number, number];
}

// A thin polyline through the platform trajectory positions. Drawn in world space
// (NOT inside the posed body group), so it isn't translated/rotated by the scanner
// pose. Uses the scan color so the path reads as belonging to this scan.
function TrajectoryPath({ points, color }: {
  points: Array<[number, number, number]>;
  color: string;
}) {
  // Build the path as consecutive vertex PAIRS and draw with <lineSegments>.
  // The lowercase r3f intrinsic <line> collides with the SVG/DOM `line` element
  // and silently fails to render; <lineSegments> is the working primitive used
  // elsewhere (VoxelGridOverlay, CropBox). Emitting each segment as a pair
  // (p[i], p[i+1]) makes the disjoint-pairs lineSegments draw a connected path.
  const geometry = useMemo(() => {
    const g = new THREE.BufferGeometry();
    const segCount = Math.max(points.length - 1, 0);
    const arr = new Float32Array(segCount * 2 * 3);
    for (let i = 0; i < segCount; i++) {
      const a = points[i];
      const b = points[i + 1];
      arr.set([a[0], a[1], a[2], b[0], b[1], b[2]], i * 6);
    }
    g.setAttribute('position', new THREE.BufferAttribute(arr, 3));
    // A hand-built BufferGeometry has no bounding sphere until asked; without one
    // three.js frustum-culls the whole line whenever the origin leaves the view,
    // so the path blinks out at certain angles/zooms. Compute it from the verts.
    g.computeBoundingSphere();
    return g;
  }, [points]);
  // Dispose the geometry when the points change / the path unmounts.
  useEffect(() => () => geometry.dispose(), [geometry]);
  if (points.length < 2) return null;
  return (
    <lineSegments frustumCulled={false}>
      <primitive object={geometry} attach="geometry" />
      <lineBasicMaterial color={color} linewidth={2} transparent opacity={0.9} depthTest={false} />
    </lineSegments>
  );
}

// A small sphere at each trajectory pose plus a short arrow showing the platform
// orientation there. The individual sample positions read as distinct keypoints
// (not just a continuous line) and the arrows show which way the scanner was
// facing. Both are instanced for cheap render of many poses, sized to the
// trajectory extent so they're visible on a 50 m drone pass and not oversized on
// a 1 m path. This is the reusable keypoint glyph the future viewport trajectory
// editor will build on.
//
// Used as the neutral keypoint glyph (generic scan, or any path with no real
// instrument selected). When a manufacturer model IS selected, `TrajectoryPosesObj`
// renders that instrument's mesh at each pose instead — see ScannerMarker.
//
// `poses` are [x, y, z, qx, qy, qz, qw] per sample (Hamilton, body->world). The
// arrow points along the platform's forward body axis (+Y, matching the marker
// meshes) rotated by each pose's quaternion.
function TrajectoryPoses({ poses, color }: {
  poses: Array<[number, number, number, number, number, number, number]>;
  color: string;
}) {
  const sphereRef = useRef<THREE.InstancedMesh>(null);
  const arrowRef = useRef<THREE.InstancedMesh>(null);

  // Depend on the POSE COUNT + a cheap content hash, not the array identity —
  // the parent passes a freshly-mapped array every render, so depending on
  // `poses` directly would rebuild this GPU geometry on every frame (a steady
  // GPU-memory leak that can OOM the renderer). The hash changes only when the
  // path actually changes.
  const posesKey = useMemo(
    () => poses.length + ':' + (poses[0]?.join(',') ?? '') + ':' +
      (poses[poses.length - 1]?.join(',') ?? ''),
    [poses],
  );

  // Glyph size scales to the path's diagonal extent. The sphere radius was
  // shrunk 40% (1.2% → 0.72% of the diagonal); the arrow length is a few sphere
  // radii so it reads as a direction indicator. Geometry is built here (passed
  // via args, matching LADVoxelGrid) so it rebuilds with the size + is disposed
  // on unmount.
  const { sphereGeo, arrowGeo, arrowLen } = useMemo(() => {
    const min = [Infinity, Infinity, Infinity];
    const max = [-Infinity, -Infinity, -Infinity];
    for (const p of poses) {
      for (let i = 0; i < 3; i++) {
        if (p[i] < min[i]) min[i] = p[i];
        if (p[i] > max[i]) max[i] = p[i];
      }
    }
    const diag = Math.hypot(max[0] - min[0], max[1] - min[1], max[2] - min[2]);
    const radius = Math.max(diag * 0.0072, 0.03);   // 40% smaller than before
    const len = radius * 2.5;                         // arrow length (50% shorter)
    // Cone authored along +Y (apex up), its base at the origin so it grows from
    // the pose outward; per-pose quaternion then aims it along the body forward.
    const arrow = new THREE.ConeGeometry(radius * 0.6, len, 10);
    arrow.translate(0, len / 2, 0);
    return {
      sphereGeo: new THREE.SphereGeometry(radius, 12, 8),
      arrowGeo: arrow,
      arrowLen: len,
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [posesKey]);
  useEffect(() => () => { sphereGeo.dispose(); arrowGeo.dispose(); },
    [sphereGeo, arrowGeo]);

  // Write one instance matrix per pose, then recompute bounding volumes. Without
  // explicit bounds three.js keeps the default (origin-centered, tiny) bounding
  // sphere and frustum-culls the whole instanced mesh once the world origin
  // leaves view — making the glyphs vanish at certain angles/zooms.
  useEffect(() => {
    const sphere = sphereRef.current;
    const arrow = arrowRef.current;
    if (!sphere || !arrow) return;
    const m = new THREE.Matrix4();
    const q = new THREE.Quaternion();
    const pos = new THREE.Vector3();
    const one = new THREE.Vector3(1, 1, 1);
    poses.forEach((p, i) => {
      pos.set(p[0], p[1], p[2]);
      m.makeTranslation(p[0], p[1], p[2]);
      sphere.setMatrixAt(i, m);
      // Arrow: same position, rotated by the pose's body->world quaternion so the
      // cone (authored +Y) points along the platform forward axis.
      q.set(p[3], p[4], p[5], p[6]).normalize();
      m.compose(pos, q, one);
      arrow.setMatrixAt(i, m);
    });
    sphere.instanceMatrix.needsUpdate = true;
    arrow.instanceMatrix.needsUpdate = true;
    sphere.computeBoundingSphere();
    sphere.computeBoundingBox();
    arrow.computeBoundingSphere();
    arrow.computeBoundingBox();
  }, [poses, sphereGeo, arrowGeo, arrowLen]);

  if (poses.length === 0) return null;
  return (
    <>
      <instancedMesh
        ref={sphereRef}
        key={'s' + poses.length}
        args={[sphereGeo, undefined, poses.length]}
        frustumCulled={false}
      >
        <meshBasicMaterial color={color} transparent opacity={0.95} depthTest={false} />
      </instancedMesh>
      <instancedMesh
        ref={arrowRef}
        key={'a' + poses.length}
        args={[arrowGeo, undefined, poses.length]}
        frustumCulled={false}
      >
        <meshBasicMaterial color={color} transparent opacity={0.85} depthTest={false} />
      </instancedMesh>
    </>
  );
}

// The manufacturer instrument mesh rendered at every trajectory pose. Replaces the
// neutral sphere+arrow glyph (TrajectoryPoses) when a real scanner model is
// selected: each pose shows the actual instrument body, posed by that sample's
// position and orientation, so a moving-platform path reads as the scanner flown
// along it. The body is drawn at its full real-world-fitted size — the same size
// as the static marker — so a moving scan's bodies match a static scan's marker.
//
// One InstancedMesh over the OBJ's merged geometry, so N poses cost one draw call.
// The real-world FIT (scale to heightMeters + recentre on the body's bbox centre)
// is baked into the merged geometry once; each instance matrix then only carries
// the pose's translation, rotation, and the user's size multiplier — so the body
// rotates and scales about its own centre at the pose point, matching the static
// marker's centring.
const POSE_MODEL_SCALE = 1; // Full real-world-fitted size (same as the static body).

function TrajectoryPosesObj({ poses, model, color, selected, markerScale }: {
  poses: Array<[number, number, number, number, number, number, number]>;
  model: ScannerModel;
  color: string;
  selected: boolean;
  // The user's "Scan marker size" multiplier, same as the static body. The per-
  // pose bodies are drawn at full real-world size × this multiplier so the global
  // size setting still applies and a moving scan's bodies track the size of a
  // static scan's marker.
  markerScale: number;
}) {
  const obj = useLoader(OBJLoader, model.meshUrl);
  const meshRef = useRef<THREE.InstancedMesh | null>(null);

  // Merge every child mesh of the OBJ into a single fitted, body-centred geometry.
  // Keep only position+normal (drop uv/other attrs) so heterogeneous OBJ groups
  // merge cleanly — the standard material needs nothing else. Built once per
  // (obj, model); disposed on unmount.
  const geometry = useMemo(() => {
    const parts: THREE.BufferGeometry[] = [];
    // Ensure each child's matrixWorld is current before baking it into the geometry
    // (OBJLoader leaves them stale at identity until asked).
    obj.updateMatrixWorld(true);
    obj.traverse((child) => {
      const mesh = child as THREE.Mesh;
      if (!mesh.isMesh || !mesh.geometry) return;
      let g = mesh.geometry.clone();
      // Bake the child's own transform so multi-part OBJs assemble correctly.
      g.applyMatrix4(mesh.matrixWorld);
      // Normalise to NON-indexed + position/normal only, so heterogeneous OBJ
      // groups (some indexed, some not, varying attribute sets) all merge cleanly
      // — mergeGeometries() requires a uniform layout or returns null.
      if (g.index) g = g.toNonIndexed();
      if (!g.getAttribute('normal')) g.computeVertexNormals();
      const trimmed = new THREE.BufferGeometry();
      trimmed.setAttribute('position', g.getAttribute('position'));
      trimmed.setAttribute('normal', g.getAttribute('normal'));
      parts.push(trimmed);
      g.dispose();
    });
    const merged =
      parts.length === 0
        ? null
        : parts.length === 1
          ? parts[0]
          : mergeGeometries(parts, false);
    // Degenerate OBJ (no meshes, or a failed merge): fall back to a tiny sphere so
    // the path still shows keypoints rather than crashing on a null geometry.
    if (!merged) return new THREE.SphereGeometry(0.05, 8, 6);
    // Fit to real-world height + recentre the body on the origin, exactly as the
    // static ObjBody does, then bake it into the vertices so the instance matrix
    // only has to carry pose + the 50% factor.
    const box = new THREE.Box3().setFromObject(obj);
    const { scale, offset } = fitTransform(box, model);
    merged.scale(scale, scale, scale);
    merged.translate(offset.x, offset.y, offset.z);
    // Keep the parts' authored normals (uniform scale + translate preserve their
    // direction) so shading matches the static ObjBody; don't recompute to flat.
    return merged;
  }, [obj, model]);
  useEffect(() => () => geometry.dispose(), [geometry]);

  const material = useMemo(
    () => makeBodyMaterial(color, selected),
    [color, selected],
  );
  useEffect(() => () => material.dispose(), [material]);

  // Write one instance matrix per pose (the cheap part: CPU matrix math + a
  // buffer-dirty flag, no GPU reallocation — only the GEOMETRY rebuild above is
  // expensive and gated). Factored out so it can be driven from BOTH a ref
  // callback and an effect (below).
  const writeMatrices = (inst: THREE.InstancedMesh | null) => {
    if (!inst) return;
    const m = new THREE.Matrix4();
    const q = new THREE.Quaternion();
    const pos = new THREE.Vector3();
    const f = (markerScale > 0 ? markerScale : 1) * POSE_MODEL_SCALE;
    const s = new THREE.Vector3(f, f, f);
    poses.forEach((p, i) => {
      pos.set(p[0], p[1], p[2]);
      q.set(p[3], p[4], p[5], p[6]).normalize();
      m.compose(pos, q, s);
      inst.setMatrixAt(i, m);
    });
    inst.instanceMatrix.needsUpdate = true;
    // Explicit bounds, or three.js culls the whole instanced mesh once the world
    // origin leaves view (same trap as TrajectoryPoses).
    inst.computeBoundingSphere();
    inst.computeBoundingBox();
  };

  // The ref callback is the load-bearing fix for the "all bodies snap to the
  // origin" bug: r3f RECONSTRUCTS the InstancedMesh whenever an `args` element
  // changes identity — and our `args` carries the merged `geometry`, which is
  // rebuilt (new object) whenever the OBJ or model resolves anew (e.g. after
  // another object is added to the scene and the marker subtree re-renders). A
  // freshly-constructed instanced mesh starts with IDENTITY matrices — every body
  // collapsed onto the group origin. A dep-gated useEffect can skip rewriting them
  // (deps unchanged), but the ref callback fires with the NEW instance on every
  // (re)mount, so matrices are always written onto whatever object is live.
  const setMeshRef = (inst: THREE.InstancedMesh | null) => {
    meshRef.current = inst;
    writeMatrices(inst);
  };

  // Also rewrite when the pose data / size / geometry changes WITHOUT a remount
  // (the ref callback doesn't fire then). Together the two cover every case.
  useEffect(() => {
    writeMatrices(meshRef.current);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [poses, geometry, markerScale]);

  if (poses.length === 0) return null;
  return (
    <instancedMesh
      ref={setMeshRef}
      key={geometry.uuid + ':' + poses.length}
      args={[geometry, material, poses.length]}
      frustumCulled={false}
    />
  );
}

// Tilt component of the marker orientation. With world +Z up and the body forward
// (heading) axis at world azimuth φ₀ (measured CCW-from-+X), the forward axis is
// (cos φ₀, sin φ₀, 0) and the lateral axis is forward × up = (sin φ₀, -cos φ₀, 0).
// Roll rotates about lateral first, then pitch about forward (right-hand). Composing
// q = pitch ∘ roll applies roll first. Identity when level.
//
// φ₀ here is the *world* forward azimuth, NOT the user's heading field — the meshes
// are authored forward-along-+Y, so a heading of `a` points forward to +Y rotated by
// `a`, i.e. world azimuth φ₀ = a + 90°. scannerOrientation() does that conversion.
function tiltQuaternion(
  rollDeg: number,
  pitchDeg: number,
  forwardAzimuthDeg: number,
): THREE.Quaternion {
  if (rollDeg === 0 && pitchDeg === 0) return new THREE.Quaternion();
  const phi0 = (forwardAzimuthDeg * Math.PI) / 180;
  const forward = new THREE.Vector3(Math.cos(phi0), Math.sin(phi0), 0);
  const lateral = new THREE.Vector3(Math.sin(phi0), -Math.cos(phi0), 0);
  const qRoll = new THREE.Quaternion().setFromAxisAngle(lateral, (rollDeg * Math.PI) / 180);
  const qPitch = new THREE.Quaternion().setFromAxisAngle(forward, (pitchDeg * Math.PI) / 180);
  return qPitch.multiply(qRoll);
}

// Heading (yaw) component: the mesh bodies are authored with their forward axis
// along +Y and heading 0 = that default, so a heading of `a` is simply a yaw of `a`
// (CCW) about world +Z — it rotates +Y to (-sin a, cos a, 0). Generic spheres are
// rotationally symmetric so this is visually a no-op for them, but applying it
// uniformly keeps one code path.
function headingYawQuaternion(azimuthOffsetDeg: number): THREE.Quaternion {
  const yaw = (azimuthOffsetDeg * Math.PI) / 180;
  return new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 0, 1), yaw);
}

// Compose a heading yaw with a roll/pitch tilt — q = tilt ∘ yaw, so the yaw is
// applied first and the tilt leans about world axes. `tiltForwardAzimuthDeg` is
// the world azimuth (CCW from +X) of the forward axis roll/pitch lean about.
function composeOrientation(
  rollDeg: number,
  pitchDeg: number,
  yawDeg: number,
  tiltForwardAzimuthDeg: number,
): THREE.Quaternion {
  const yaw = headingYawQuaternion(yawDeg);
  const tilt = tiltQuaternion(rollDeg, pitchDeg, tiltForwardAzimuthDeg);
  return tilt.multiply(yaw);
}

// Full marker orientation: yaw the authored +Y-forward body to the heading first,
// then apply tilt about the (now correctly-oriented) world axes — q = tilt ∘ yaw.
// The body forward after the yaw sits at world azimuth (heading + 90°), so tilt is
// built about that same axis to lean in the right direction. Returns a concrete
// quaternion (never null) so resetting heading/tilt actively re-orients the group
// rather than leaving a stale rotation baked in.
export function scannerOrientation(
  rollDeg: number,
  pitchDeg: number,
  azimuthOffsetDeg: number,
): THREE.Quaternion {
  return composeOrientation(rollDeg, pitchDeg, azimuthOffsetDeg, azimuthOffsetDeg + 90);
}

// Orientation for the coverage SHELL (ScanPatternWireframe), whose vertices already
// sit at their true phi (phi from +Y; see ScanPatternWireframe.sph). The shell is
// yawed by the heading offset ONLY — phiMin is baked into the geometry, not the
// yaw — and the roll/pitch tilt leans about the phiMin scan direction AFTER that
// yaw: world azimuth (azimuthOffset + 90 − phiMin). That is the same body-forward
// axis the backend tilts its rays about (LiDAR.cpp), so the shell leans with the
// real scan. For phiMin = 0 this is identical to scannerOrientation().
export function scanShellOrientation(
  rollDeg: number,
  pitchDeg: number,
  azimuthOffsetDeg: number,
  phiMinDeg: number,
): THREE.Quaternion {
  return composeOrientation(
    rollDeg,
    pitchDeg,
    azimuthOffsetDeg,
    azimuthOffsetDeg + 90 - phiMinDeg,
  );
}

// Per-marker MeshStandardMaterial built from the scan's swatch colour. Darken in
// HSL (cap lightness, keep hue + saturation) rather than RGB scalar so every
// palette colour lands in the same visibility band against bright foliage; a
// same-hue emissive glow marks selection.
function makeBodyMaterial(color: string, selected: boolean): THREE.MeshStandardMaterial {
  const hsl = { h: 0, s: 0, l: 0 };
  new THREE.Color(color).getHSL(hsl);
  const bodyColor = new THREE.Color().setHSL(hsl.h, hsl.s, Math.min(hsl.l, 0.3));
  return new THREE.MeshStandardMaterial({
    color: bodyColor,
    metalness: 0.5,
    roughness: 0.4,
    emissive: selected ? new THREE.Color(color) : new THREE.Color(0x000000),
    emissiveIntensity: selected ? 0.55 : 0,
  });
}

// Uniform scale + translation that fits an object of bounding box `box` to the
// model's real-world height, centred on the scan origin. The bundled meshes are
// authored in inconsistent units (some metres, the RIEGL mesh millimetres) and
// with varying local origins, so we never trust the raw coordinates: scale by
// (targetHeight / boxHeight) and then re-centre.
//
// Every model (instrument OR sphere) is centred on the scan point — its bounding
// box centre maps to the origin. That makes the scan origin the pivot for the
// global size multiplier: cranking "Scan marker size" up enlarges the marker
// symmetrically *in place* about the scan point, rather than growing it upward
// from a pinned base. (The scan origin is the instrument's optical centre, which
// sits roughly mid-body, so centring is also the more faithful anchor.)
function fitTransform(
  box: THREE.Box3,
  model: ScannerModel,
): { scale: number; offset: THREE.Vector3 } {
  const size = new THREE.Vector3();
  const center = new THREE.Vector3();
  box.getSize(size);
  box.getCenter(center);
  const srcHeight = size.z > 1e-9 ? size.z : 1;
  const scale = model.heightMeters / srcHeight;
  // Shift the scaled mesh so its bounding-box centre lands on the origin.
  const offset = new THREE.Vector3(
    -center.x * scale,
    -center.y * scale,
    -center.z * scale,
  );
  return { scale, offset };
}

// Instrument body loaded from an OBJ. Clones the cached geometry, applies the
// per-marker material, and fits it to the model's real-world size.
function ObjBody({
  model,
  color,
  selected,
}: {
  model: ScannerModel;
  color: string;
  selected: boolean;
}) {
  const obj = useLoader(OBJLoader, model.meshUrl);

  const { scene, materials } = useMemo(() => {
    const cloned = obj.clone(true);
    const mats: THREE.Material[] = [];
    cloned.traverse((child) => {
      const mesh = child as THREE.Mesh;
      if (mesh.isMesh) {
        const mat = makeBodyMaterial(color, selected);
        mesh.material = mat;
        mats.push(mat);
        mesh.castShadow = false;
        mesh.receiveShadow = false;
      }
    });
    const box = new THREE.Box3().setFromObject(cloned);
    const { scale, offset } = fitTransform(box, model);
    cloned.scale.setScalar(scale);
    cloned.position.copy(offset);
    return { scene: cloned, materials: mats };
  }, [obj, model, color, selected]);

  useEffect(() => () => { materials.forEach((m) => m.dispose()); }, [materials]);

  return <primitive object={scene} />;
}

// Generic marker loaded from a PLY (a sphere). PLYLoader yields a BufferGeometry,
// so we own the mesh and dispose both geometry and material on unmount.
function PlyBody({
  model,
  color,
  selected,
}: {
  model: ScannerModel;
  color: string;
  selected: boolean;
}) {
  const geometry = useLoader(PLYLoader, model.meshUrl);

  const { object, material } = useMemo(() => {
    const geo = geometry.clone();
    geo.computeVertexNormals();
    const mat = makeBodyMaterial(color, selected);
    const mesh = new THREE.Mesh(geo, mat);
    mesh.castShadow = false;
    mesh.receiveShadow = false;
    const box = new THREE.Box3().setFromBufferAttribute(
      geo.getAttribute('position') as THREE.BufferAttribute,
    );
    const { scale, offset } = fitTransform(box, model);
    mesh.scale.setScalar(scale);
    mesh.position.copy(offset);
    return { object: mesh, material: mat };
  }, [geometry, model, color, selected]);

  useEffect(
    () => () => {
      material.dispose();
      object.geometry.dispose();
    },
    [material, object],
  );

  return <primitive object={object} />;
}

export function ScannerMarker({
  origin,
  model,
  color,
  selected = false,
  tiltRollDeg = 0,
  tiltPitchDeg = 0,
  azimuthOffsetDeg = 0,
  scale = 1,
  trajectory,
  poses,
  bodyQuaternion,
}: ScannerMarkerProps) {
  const resolved = useMemo(() => getScannerModel(model), [model]);
  // Orientation: for a moving scan, use the platform's first-pose attitude
  // (the static tilt/heading don't apply). Otherwise combine the heading yaw
  // (orient the authored +Y-forward body) with the residual tilt.
  const quaternion = useMemo(
    () =>
      bodyQuaternion
        ? new THREE.Quaternion(bodyQuaternion[0], bodyQuaternion[1],
            bodyQuaternion[2], bodyQuaternion[3]).normalize()
        : scannerOrientation(tiltRollDeg, tiltPitchDeg, azimuthOffsetDeg),
    [bodyQuaternion, tiltRollDeg, tiltPitchDeg, azimuthOffsetDeg],
  );
  // Clamp to a sane positive multiplier so a stray 0/negative setting can't
  // collapse or invert every marker.
  const markerScale = scale > 0 ? scale : 1;
  // A real manufacturer model renders its OBJ body at each pose; the generic
  // sphere keeps the neutral sphere+arrow glyph (it has no instrument silhouette
  // worth instancing).
  const useObjPoses = resolved.meshFormat === 'obj';
  return (
    <>
      {trajectory && trajectory.length >= 2 && (
        <TrajectoryPath points={trajectory} color={color} />
      )}
      {poses && poses.length >= 1 && (
        useObjPoses ? (
          <Suspense fallback={null}>
            <TrajectoryPosesObj
              poses={poses}
              model={resolved}
              color={color}
              selected={selected}
              markerScale={markerScale}
            />
          </Suspense>
        ) : (
          <TrajectoryPoses poses={poses} color={color} />
        )
      )}
      {/* The full-size static body. Suppressed for a moving scan rendered with
          per-pose OBJ instances — those already draw the instrument at every pose
          (including the first), so the static body would just double up on pose 0. */}
      {!(useObjPoses && poses && poses.length >= 1) && (
        <group position={[origin.x, origin.y, origin.z]} quaternion={quaternion} scale={markerScale}>
          <Suspense fallback={null}>
            {resolved.meshFormat === 'ply' ? (
              <PlyBody model={resolved} color={color} selected={selected} />
            ) : (
              <ObjBody model={resolved} color={color} selected={selected} />
            )}
          </Suspense>
        </group>
      )}
    </>
  );
}

// Wrapper that derives the ScannerMarker props from a scan's ScanParameters and
// How many scanner glyphs/OBJ instances to draw along a trajectory at most. The
// PATH LINE always uses every pose (it's cheap and defines the true route), but the
// posed instruments are decimated to this many evenly-spaced samples (first + last
// always kept). Hundreds of overlapping OBJ instruments otherwise read as one blob
// and multiply the primitive count by N. An origin-derived trajectory (one pose per
// pulse → thousands) and a dense interpolated trajectory file both hit this, so the
// decimation lives here on the shared display path rather than at import.
export const MAX_DISPLAY_POSES = 24;

// Evenly subsample `poses` to at most `max` entries, always keeping the first and
// last so the drawn instruments still span the whole path. Returns the same array
// reference when no decimation is needed (so the downstream memo key is stable).
export function decimatePosesForDisplay<T>(poses: T[], max = MAX_DISPLAY_POSES): T[] {
  const n = poses.length;
  if (n <= max) return poses;
  const out: T[] = [];
  // Stride across [0, n-1] in `max` steps so the last index lands on n-1.
  for (let i = 0; i < max; i++) {
    out.push(poses[Math.round((i * (n - 1)) / (max - 1))]);
  }
  return out;
}

// MEMOIZES the trajectory-derived arrays on the stable `params.trajectory`
// reference. Without this, the parent's inline `.map()` produced a fresh
// positions array every render, rebuilding the trajectory marker's GPU geometry
// each frame — a steady GPU-memory leak that froze and OOM-crashed the renderer.
export function ScanMarkerEntry({
  params,
  color,
  selected,
  markerScale,
}: {
  params: import('../lib/scanParameters').ScanParameters;
  color: string;
  selected: boolean;
  markerScale: number;
}) {
  const traj = params.trajectory;
  const trajectory = useMemo(
    () => traj?.poses.map(p => [p.x, p.y, p.z] as [number, number, number]),
    [traj],
  );
  // The PATH LINE (`trajectory`) uses every pose; the posed instruments/glyphs are
  // decimated to MAX_DISPLAY_POSES so a dense path (e.g. an origin-derived trajectory
  // with one pose per pulse) doesn't draw hundreds of overlapping models.
  const poses = useMemo(
    () => decimatePosesForDisplay(
      (traj?.poses ?? []).map(p =>
        [p.x, p.y, p.z, p.qx, p.qy, p.qz, p.qw] as
          [number, number, number, number, number, number, number])),
    [traj],
  );
  const bodyQuaternion = useMemo<[number, number, number, number] | undefined>(
    () => (traj
      ? [traj.poses[0].qx, traj.poses[0].qy, traj.poses[0].qz, traj.poses[0].qw]
      : undefined),
    [traj],
  );
  return (
    <ScannerMarker
      origin={params.origin}
      model={params.scannerModel}
      color={color}
      selected={selected}
      tiltRollDeg={params.tiltRollDeg}
      tiltPitchDeg={params.tiltPitchDeg}
      azimuthOffsetDeg={params.azimuthOffsetDeg}
      scale={markerScale}
      trajectory={trajectory}
      poses={poses}
      bodyQuaternion={bodyQuaternion}
    />
  );
}
