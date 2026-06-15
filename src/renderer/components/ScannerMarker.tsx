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
  // axis), then pitch (about the body forward / azimuth-zero axis). Both default
  // to 0 (level). Derived from the scan's params at render time, so editing tilt
  // in the scan panel re-orients the marker live.
  tiltRollDeg?: number;
  tiltPitchDeg?: number;
  // Azimuth-zero direction (phiMin), in degrees, defining the body forward axis
  // in the world XY plane. The tilt axes are built relative to it so a tilted
  // scanner leans in the right world direction regardless of its azimuth sweep.
  azimuthZeroDeg?: number;
  // Global size multiplier applied uniformly on top of the model's real-world
  // fit (the user's "Scan marker size" setting). 1 = real-world scale. Applied
  // to the wrapping group, so it scales the fitted mesh as a whole.
  scale?: number;
}

// Build the marker's orientation quaternion from the tilt convention: with world
// +Z up, the forward (azimuth-zero) axis is (cos φ₀, sin φ₀, 0) and the lateral
// axis is forward × up = (sin φ₀, -cos φ₀, 0). Roll rotates about lateral first,
// then pitch about forward (right-hand). Composing q = pitch ∘ roll applies roll
// first. Returns identity when level so the common case stays cheap.
function tiltQuaternion(
  rollDeg: number,
  pitchDeg: number,
  azimuthZeroDeg: number,
): THREE.Quaternion {
  // Identity when level — always return a concrete quaternion (never null) so
  // that editing tilt back to 0/0 actively resets the group's orientation
  // rather than leaving the previous tilt baked in.
  if (rollDeg === 0 && pitchDeg === 0) return new THREE.Quaternion();
  const phi0 = (azimuthZeroDeg * Math.PI) / 180;
  const forward = new THREE.Vector3(Math.cos(phi0), Math.sin(phi0), 0);
  const lateral = new THREE.Vector3(Math.sin(phi0), -Math.cos(phi0), 0);
  const qRoll = new THREE.Quaternion().setFromAxisAngle(lateral, (rollDeg * Math.PI) / 180);
  const qPitch = new THREE.Quaternion().setFromAxisAngle(forward, (pitchDeg * Math.PI) / 180);
  return qPitch.multiply(qRoll);
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
  azimuthZeroDeg = 0,
  scale = 1,
}: ScannerMarkerProps) {
  const resolved = useMemo(() => getScannerModel(model), [model]);
  // Recompute only when the tilt inputs change. Identity (level) leaves the
  // group at its default orientation.
  const quaternion = useMemo(
    () => tiltQuaternion(tiltRollDeg, tiltPitchDeg, azimuthZeroDeg),
    [tiltRollDeg, tiltPitchDeg, azimuthZeroDeg],
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
