import { useRef, useMemo } from 'react';
import { useThree, useFrame } from '@react-three/fiber';
import * as THREE from 'three';

// Blender-style 3D-cursor marker for the scene origin: a camera-facing ring
// striped red/white with a fine crosshair through the center. Drawn on top
// (depthTest off) so it's never buried in the cloud, and rescaled every frame to
// a CONSTANT on-screen size — so it reads as a clean UI overlay at any zoom
// instead of a giant sphere up close / an invisible dot far away.
//
// The red/white stripe is a single line-loop with per-vertex colors alternating
// around the circle (no dashed-line distance bookkeeping needed, so it stays
// crisp under the per-frame rescale).
//
// `position` is in DISPLAY space (the parent already subtracts displayOffset), so
// this component only handles billboarding + constant-size scaling.

// Target on-screen radius of the ring, in pixels.
const PIXEL_RADIUS = 17;

export function SceneOriginMarker({ position }: { position: [number, number, number] }) {
  const groupRef = useRef<THREE.Group>(null);
  const { camera, size } = useThree();

  // Unit-radius ring with alternating red/white vertex colors (the group scale
  // sets the world size that projects to PIXEL_RADIUS).
  const ringGeom = useMemo(() => {
    const stripes = 12;            // number of red/white alternations around the ring
    const perStripe = 8;           // segments per stripe (higher = smoother arcs)
    const segments = stripes * perStripe;
    const pos: number[] = [];
    const col: number[] = [];
    const red = new THREE.Color('#ef4444');
    const white = new THREE.Color('#f8fafc');
    for (let i = 0; i <= segments; i++) {
      const a = (i / segments) * Math.PI * 2;
      pos.push(Math.cos(a), Math.sin(a), 0);
      const c = Math.floor(i / perStripe) % 2 === 0 ? red : white;
      col.push(c.r, c.g, c.b);
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
    g.setAttribute('color', new THREE.Float32BufferAttribute(col, 3));
    return g;
  }, []);

  // Crosshair: four short ticks leaving a gap at the center (like Blender's).
  const crossGeom = useMemo(() => {
    const gap = 0.35; // inner gap (unit-radius fraction)
    const ext = 1.3;  // outer extent
    const pts = [
      gap, 0, 0, ext, 0, 0,
      -gap, 0, 0, -ext, 0, 0,
      0, gap, 0, 0, ext, 0,
      0, -gap, 0, 0, -ext, 0,
    ];
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(pts, 3));
    return g;
  }, []);

  const ringMat = useMemo(() => {
    const m = new THREE.LineBasicMaterial({ vertexColors: true });
    m.depthTest = false;
    m.depthWrite = false;
    m.transparent = true;
    return m;
  }, []);
  const crossMat = useMemo(() => {
    const m = new THREE.LineBasicMaterial({ color: '#e5e7eb' });
    m.depthTest = false;
    m.depthWrite = false;
    m.transparent = true;
    m.opacity = 0.85;
    return m;
  }, []);

  useFrame(() => {
    const grp = groupRef.current;
    if (!grp) return;
    // Face the camera (billboard).
    grp.quaternion.copy(camera.quaternion);
    // Constant screen size: pick a world radius so PIXEL_RADIUS px is subtended at
    // this point's distance from the camera.
    const p = grp.position;
    let worldRadius: number;
    if ((camera as THREE.PerspectiveCamera).isPerspectiveCamera) {
      const cam = camera as THREE.PerspectiveCamera;
      const dist = cam.position.distanceTo(p);
      const worldPerPixel = (2 * Math.tan((cam.fov * Math.PI / 180) / 2) * dist) / size.height;
      worldRadius = PIXEL_RADIUS * worldPerPixel;
    } else {
      const cam = camera as THREE.OrthographicCamera;
      const worldPerPixel = (cam.top - cam.bottom) / cam.zoom / size.height;
      worldRadius = PIXEL_RADIUS * worldPerPixel;
    }
    if (isFinite(worldRadius) && worldRadius > 0) grp.scale.setScalar(worldRadius);
  });

  return (
    <group ref={groupRef} position={position} renderOrder={10000}>
      <lineLoop geometry={ringGeom} material={ringMat} />
      <lineSegments geometry={crossGeom} material={crossMat} />
    </group>
  );
}
