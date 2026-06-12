import { Suspense, useEffect, useMemo } from 'react';
import { useLoader } from '@react-three/fiber';
import { OBJLoader } from 'three/examples/jsm/loaders/OBJLoader.js';
import * as THREE from 'three';
import scannerObjUrl from '../assets/models/scanner.obj?url';

interface ScannerMarkerProps {
  origin: { x: number; y: number; z: number };
  // World-space height the scanner should occupy. The bundled OBJ is exactly
  // 1 m tall in its local frame, so scale doubles as the rendered height.
  heightMeters: number;
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
}

// Build the marker's orientation quaternion from the tilt convention: with world
// +Z up, the forward (azimuth-zero) axis is (cos φ₀, sin φ₀, 0) and the lateral
// axis is forward × up = (sin φ₀, -cos φ₀, 0). Roll rotates about lateral first,
// then pitch about forward (right-hand). Composing q = pitch ∘ roll applies roll
// first. Returns null when level so the common case stays identity.
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

function ScannerObject({ color, selected }: { color: string; selected: boolean }) {
  const obj = useLoader(OBJLoader, scannerObjUrl);

  // Clone the loaded scene so each marker gets its own material instance.
  // We track the per-marker materials we create so we can dispose them when
  // color/selected changes (which builds a fresh cloned scene) or on unmount.
  // The shared geometry comes from the cached OBJLoader result and must not
  // be disposed here.
  const { scene, materials } = useMemo(() => {
    const cloned = obj.clone(true);
    // Darken the scan's swatch color for the body of the marker — bright
    // Tailwind-500s wash out against dense, bright-green foliage scans.
    // Selection adds a same-hue emissive glow on top, so the selected marker
    // reads as "the brighter version of itself".
    //
    // Darken in HSL (cap lightness, keep hue + saturation) rather than RGB
    // scalar: scalar multiplication hits already-dark channels much harder,
    // turning green-500 (R=34) almost black while leaving blue-500 readable.
    // The cap puts every palette colour in the same visibility band.
    const hsl = { h: 0, s: 0, l: 0 };
    new THREE.Color(color).getHSL(hsl);
    const bodyColor = new THREE.Color().setHSL(hsl.h, hsl.s, Math.min(hsl.l, 0.30));
    const mats: THREE.Material[] = [];
    cloned.traverse((child) => {
      const mesh = child as THREE.Mesh;
      if (mesh.isMesh) {
        const mat = new THREE.MeshStandardMaterial({
          color: bodyColor,
          metalness: 0.5,
          roughness: 0.4,
          emissive: selected ? new THREE.Color(color) : new THREE.Color(0x000000),
          emissiveIntensity: selected ? 0.55 : 0,
        });
        mesh.material = mat;
        mats.push(mat);
        mesh.castShadow = false;
        mesh.receiveShadow = false;
      }
    });
    return { scene: cloned, materials: mats };
  }, [obj, color, selected]);

  useEffect(() => () => { materials.forEach((m) => m.dispose()); }, [materials]);

  return <primitive object={scene} />;
}

export function ScannerMarker({
  origin,
  heightMeters,
  color,
  selected = false,
  tiltRollDeg = 0,
  tiltPitchDeg = 0,
  azimuthZeroDeg = 0,
}: ScannerMarkerProps) {
  // Recompute only when the tilt inputs change. A null quaternion (level) leaves
  // the group at identity orientation.
  const quaternion = useMemo(
    () => tiltQuaternion(tiltRollDeg, tiltPitchDeg, azimuthZeroDeg),
    [tiltRollDeg, tiltPitchDeg, azimuthZeroDeg],
  );
  return (
    <group
      position={[origin.x, origin.y, origin.z]}
      quaternion={quaternion}
      scale={heightMeters}
    >
      <Suspense fallback={null}>
        <ScannerObject color={color} selected={selected} />
      </Suspense>
    </group>
  );
}
