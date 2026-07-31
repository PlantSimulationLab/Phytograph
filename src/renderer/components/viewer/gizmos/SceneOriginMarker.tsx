import { useRef, useMemo, useState, useEffect } from 'react';
import { useThree, useFrame, ThreeEvent } from '@react-three/fiber';
import * as THREE from 'three';
import { worldPerPixel } from '../../../lib/screenScale';
import { SCENE_OVERLAY } from '../../../lib/sceneOverlay';

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
// The marker is also a PICK TARGET: an invisible sphere inside the billboard
// group (so it inherits the constant-size scale) turns a click into `onSelect`,
// which the viewer uses to show a translation gizmo on the origin. The sphere is
// `transparent opacity={0}` rather than `visible={false}` — the same
// invisible-raycast-target idiom as OriginPicker / BoxDrawRaycaster.
//
// `position` is in DISPLAY space (the parent already subtracts displayOffset), so
// this component only handles billboarding + constant-size scaling.

// Target on-screen radius of the ring, in pixels.
const PIXEL_RADIUS = 12;
// Pick target: an ANNULUS around the ring, not a disc. The origin defaults to
// the scene center, which is usually dead-center in the viewport, so a filled
// hit target would steal the clicks that select whatever is under it. Leaving
// the middle open keeps those clicks passing through while the visible ring
// (and a little either side of it) stays grabbable.
const HIT_INNER = 0.55;
const HIT_OUTER = 1.45;

interface SceneOriginMarkerProps {
  position: [number, number, number];
  /** True while the origin is selected (its translation gizmo is showing). */
  selected?: boolean;
  /** When false the marker is display-only and swallows no pointer events. */
  interactive?: boolean;
  onSelect?: () => void;
}

export function SceneOriginMarker({
  position, selected = false, interactive = false, onSelect,
}: SceneOriginMarkerProps) {
  const groupRef = useRef<THREE.Group>(null);
  const { camera, size, gl } = useThree();
  const [hovered, setHovered] = useState(false);

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

  // Plain circle used for the hover/selection halo (drawn at a larger radius via
  // the group scale on its own mesh).
  const haloGeom = useMemo(() => {
    const segments = 64;
    const pts: number[] = [];
    for (let i = 0; i <= segments; i++) {
      const a = (i / segments) * Math.PI * 2;
      pts.push(Math.cos(a), Math.sin(a), 0);
    }
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
  const haloMat = useMemo(() => {
    const m = new THREE.LineBasicMaterial({ color: '#f59e0b' });
    m.depthTest = false;
    m.depthWrite = false;
    m.transparent = true;
    return m;
  }, []);

  const worldPos = useRef(new THREE.Vector3()).current;
  useFrame(() => {
    const grp = groupRef.current;
    if (!grp) return;
    // Face the camera (billboard).
    grp.quaternion.copy(camera.quaternion);
    // Constant screen size: pick a world radius so PIXEL_RADIUS px is subtended at
    // this point's distance from the camera. Must use the WORLD position, not the
    // local one — the parent group cancels displayOffset, so on a georeferenced
    // scene `grp.position` is a UTM coordinate while the camera lives in display
    // space, and the distance (hence the scale) would be wildly wrong.
    grp.getWorldPosition(worldPos);
    const scale = PIXEL_RADIUS * worldPerPixel(camera, camera.position, size.height, worldPos);
    if (scale > 0) grp.scale.setScalar(scale);
  });

  const handleClick = (e: ThreeEvent<MouseEvent>) => {
    // Reject the tail of a camera orbit that happened to end on the marker (the
    // same 4px guard the mesh picker uses).
    if (e.delta > 4) return;
    e.stopPropagation();
    onSelect?.();
  };

  const hoveredRef = useRef(false);
  const setCursor = (hover: boolean) => {
    hoveredRef.current = hover;
    setHovered(hover);
    gl.domElement.style.cursor = hover ? 'pointer' : 'auto';
  };

  // Release the pointer cursor if the hit target disappears from under the mouse
  // (marker hidden, tool opened, unmount) — pointerOut never fires for an
  // unmounted object, so the cursor would otherwise stay a hand forever. Only
  // touched when WE set it, so an armed OriginPicker keeps its crosshair.
  useEffect(() => {
    if (interactive) return;
    if (hoveredRef.current) setCursor(false);
  }, [interactive]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => () => { if (hoveredRef.current) gl.domElement.style.cursor = 'auto'; }, [gl]);

  const halo = selected || hovered;

  return (
    // UI overlay, not content — see lib/sceneOverlay.ts.
    <group {...SCENE_OVERLAY} ref={groupRef} position={position} renderOrder={10000}>
      <lineLoop geometry={ringGeom} material={ringMat} />
      <lineSegments geometry={crossGeom} material={crossMat} />
      {halo && (
        // Amber halo: solid once selected, faint on hover — the only cue that
        // the marker is grabbable / currently owns the gizmo.
        <lineLoop
          geometry={haloGeom}
          material={haloMat}
          scale={1.45}
          material-opacity={selected ? 0.95 : 0.5}
        />
      )}
      {interactive && (
        <mesh
          onClick={handleClick}
          onPointerOver={(e) => { e.stopPropagation(); setCursor(true); }}
          onPointerOut={(e) => { e.stopPropagation(); setCursor(false); }}
        >
          <ringGeometry args={[HIT_INNER, HIT_OUTER, 32]} />
          <meshBasicMaterial transparent opacity={0} depthWrite={false} depthTest={false} side={THREE.DoubleSide} />
        </mesh>
      )}
    </group>
  );
}
