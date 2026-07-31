import { useRef, useMemo, useState, useEffect } from 'react';
import { useThree, useFrame, ThreeEvent } from '@react-three/fiber';
import * as THREE from 'three';
import { LineSegments2 } from 'three/examples/jsm/lines/LineSegments2.js';
import { LineSegmentsGeometry } from 'three/examples/jsm/lines/LineSegmentsGeometry.js';
import { LineMaterial } from 'three/examples/jsm/lines/LineMaterial.js';
import { worldPerPixel } from '../../../lib/screenScale';
import { SCENE_OVERLAY } from '../../../lib/sceneOverlay';

// Blender-style 3D-cursor marker for the scene origin: a camera-facing ring
// striped red/white with a fine crosshair through the center. Drawn on top
// (depthTest off) so it's never buried in the cloud, and rescaled every frame to
// a CONSTANT on-screen size — so it reads as a clean UI overlay at any zoom
// instead of a giant sphere up close / an invisible dot far away.
//
// Every line is a LineSegments2 (three's instanced-quad thick lines), NOT a
// plain lineLoop/lineSegments: `LineBasicMaterial.linewidth` is silently
// clamped to 1px by every WebGL implementation we ship on, and a 1px marker
// disappears into a dense point cloud. LineMaterial's `linewidth` is real, and
// with the default `worldUnits: false` it is in CSS pixels — which composes
// exactly right with the constant-screen-size group scale below (both the
// radius and the stroke are specified in pixels). The catch is `resolution`:
// LineMaterial expands the quads in clip space, so it must be told the drawing
// buffer size or the lines render at the wrong thickness (and stretch on
// resize) — kept in sync in useFrame.
//
// The red/white stripe is per-segment instance colors around the circle (no
// dashed-line distance bookkeeping needed, so it stays crisp under the
// per-frame rescale).
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
// Stroke widths, in CSS pixels (LineMaterial with worldUnits: false). Chosen so
// the marker stays legible on top of a dense cloud without growing in extent —
// this is thickness only; PIXEL_RADIUS still owns the overall size.
const RING_WIDTH = 2.25;
const CROSS_WIDTH = 1.5;
const HALO_WIDTH = 1.75;
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

  // Unit-radius ring with alternating red/white stripes (the group scale sets
  // the world size that projects to PIXEL_RADIUS). LineSegmentsGeometry wants
  // an explicit start/end pair per segment, and `setColors` likewise wants a
  // colour per endpoint, so the circle is emitted as discrete segments rather
  // than a loop.
  const ringGeom = useMemo(() => {
    const stripes = 12;            // number of red/white alternations around the ring
    const perStripe = 8;           // segments per stripe (higher = smoother arcs)
    const segments = stripes * perStripe;
    const pos: number[] = [];
    const col: number[] = [];
    const red = new THREE.Color('#ef4444');
    const white = new THREE.Color('#f8fafc');
    const at = (i: number) => {
      const a = (i / segments) * Math.PI * 2;
      return [Math.cos(a), Math.sin(a), 0];
    };
    for (let i = 0; i < segments; i++) {
      pos.push(...at(i), ...at(i + 1));
      const c = Math.floor(i / perStripe) % 2 === 0 ? red : white;
      col.push(c.r, c.g, c.b, c.r, c.g, c.b);
    }
    const g = new LineSegmentsGeometry();
    g.setPositions(pos);
    g.setColors(col);
    return g;
  }, []);

  // Crosshair: four short ticks leaving a gap at the center (like Blender's).
  const crossGeom = useMemo(() => {
    const gap = 0.35; // inner gap (unit-radius fraction)
    const ext = 1.3;  // outer extent
    const g = new LineSegmentsGeometry();
    g.setPositions([
      gap, 0, 0, ext, 0, 0,
      -gap, 0, 0, -ext, 0, 0,
      0, gap, 0, 0, ext, 0,
      0, -gap, 0, 0, -ext, 0,
    ]);
    return g;
  }, []);

  // Plain circle used for the hover/selection halo (drawn at a larger radius via
  // its own scale).
  const haloGeom = useMemo(() => {
    const segments = 64;
    const pos: number[] = [];
    for (let i = 0; i < segments; i++) {
      const a0 = (i / segments) * Math.PI * 2;
      const a1 = ((i + 1) / segments) * Math.PI * 2;
      pos.push(Math.cos(a0), Math.sin(a0), 0, Math.cos(a1), Math.sin(a1), 0);
    }
    const g = new LineSegmentsGeometry();
    g.setPositions(pos);
    return g;
  }, []);

  const ringMat = useMemo(() => {
    const m = new LineMaterial({ vertexColors: true, linewidth: RING_WIDTH });
    m.depthTest = false;
    m.depthWrite = false;
    m.transparent = true;
    return m;
  }, []);
  const crossMat = useMemo(() => {
    const m = new LineMaterial({ color: 0xe5e7eb, linewidth: CROSS_WIDTH });
    m.depthTest = false;
    m.depthWrite = false;
    m.transparent = true;
    m.opacity = 0.85;
    return m;
  }, []);
  const haloMat = useMemo(() => {
    const m = new LineMaterial({ color: 0xf59e0b, linewidth: HALO_WIDTH });
    m.depthTest = false;
    m.depthWrite = false;
    m.transparent = true;
    return m;
  }, []);

  // LineMaterial needs the drawing-buffer size to expand its quads correctly.
  useEffect(() => {
    const w = size.width * gl.getPixelRatio();
    const h = size.height * gl.getPixelRatio();
    for (const m of [ringMat, crossMat, haloMat]) m.resolution.set(w, h);
  }, [size.width, size.height, gl, ringMat, crossMat, haloMat]);

  // Free the GPU buffers these own — unlike the shared r3f-managed primitives,
  // nothing else disposes an imperatively-constructed geometry/material.
  useEffect(() => () => {
    for (const g of [ringGeom, crossGeom, haloGeom]) g.dispose();
    for (const m of [ringMat, crossMat, haloMat]) m.dispose();
  }, [ringGeom, crossGeom, haloGeom, ringMat, crossMat, haloMat]);

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

  // LineSegments2 isn't in r3f's catalogue, so each line is built imperatively
  // and mounted via <primitive>. `computeLineDistances` is only needed for
  // dashing, which we don't use.
  const ringLine = useMemo(() => new LineSegments2(ringGeom, ringMat), [ringGeom, ringMat]);
  const crossLine = useMemo(() => new LineSegments2(crossGeom, crossMat), [crossGeom, crossMat]);
  const haloLine = useMemo(() => {
    const l = new LineSegments2(haloGeom, haloMat);
    l.scale.setScalar(1.45);
    return l;
  }, [haloGeom, haloMat]);
  haloMat.opacity = selected ? 0.95 : 0.5;

  return (
    // UI overlay, not content — see lib/sceneOverlay.ts.
    <group {...SCENE_OVERLAY} ref={groupRef} position={position} renderOrder={10000}>
      <primitive object={ringLine} />
      <primitive object={crossLine} />
      {/* Amber halo: solid once selected, faint on hover — the only cue that
          the marker is grabbable / currently owns the gizmo. */}
      {halo && <primitive object={haloLine} />}
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
