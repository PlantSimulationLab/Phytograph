import { Suspense, useEffect, useMemo } from 'react';
import { useLoader } from '@react-three/fiber';
import { OBJLoader } from 'three/examples/jsm/loaders/OBJLoader.js';
import { PLYLoader } from 'three/examples/jsm/loaders/PLYLoader.js';
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
  const yaw = headingYawQuaternion(azimuthOffsetDeg);
  const tilt = tiltQuaternion(rollDeg, pitchDeg, azimuthOffsetDeg + 90);
  return tilt.multiply(yaw);
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
}: ScannerMarkerProps) {
  const resolved = useMemo(() => getScannerModel(model), [model]);
  // Recompute only when the heading/tilt inputs change. Combines the heading yaw
  // (orient the authored +Y-forward body) with the residual tilt.
  const quaternion = useMemo(
    () => scannerOrientation(tiltRollDeg, tiltPitchDeg, azimuthOffsetDeg),
    [tiltRollDeg, tiltPitchDeg, azimuthOffsetDeg],
  );
  // Clamp to a sane positive multiplier so a stray 0/negative setting can't
  // collapse or invert every marker.
  const markerScale = scale > 0 ? scale : 1;
  return (
    <group position={[origin.x, origin.y, origin.z]} quaternion={quaternion} scale={markerScale}>
      <Suspense fallback={null}>
        {resolved.meshFormat === 'ply' ? (
          <PlyBody model={resolved} color={color} selected={selected} />
        ) : (
          <ObjBody model={resolved} color={color} selected={selected} />
        )}
      </Suspense>
    </group>
  );
}
