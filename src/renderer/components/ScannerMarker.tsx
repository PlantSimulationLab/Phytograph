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

export function ScannerMarker({ origin, heightMeters, color, selected = false }: ScannerMarkerProps) {
  return (
    <group position={[origin.x, origin.y, origin.z]} scale={heightMeters}>
      <Suspense fallback={null}>
        <ScannerObject color={color} selected={selected} />
      </Suspense>
    </group>
  );
}
