import { useEffect, useMemo, useRef } from 'react';
import { useFrame } from '@react-three/fiber';
import * as THREE from 'three';
import { SCENE_OVERLAY } from '../../../lib/sceneOverlay';
import {
  slabFromCentreline,
  slabToBox,
  centrelineIsPreviewable,
} from '../../../lib/crossSection';

// The slab you are ABOUT to create, drawn while you pick the second point.
//
// Why it exists: after the first click the only feedback was a marker and a
// rubber-band line. A line tells you the azimuth but nothing about the volume,
// so there is no way to picture the section until it snaps into existence on
// the second click — the box appears somewhere you did not expect and the view
// jumps to face it. Showing the actual box while aiming removes the guesswork.
//
// Fixed thickness, deliberately. The committed slab derives its depth from the
// drawn length, but applying that live makes the walls splay outward as the
// cursor moves — distracting to aim with, and it teaches the wrong model, since
// thickness is an independent parameter tuned in the panel afterwards. Length
// grows as you drag; width stays put.
//
// Reads the cursor from a REF and drives the matrix in useFrame rather than
// taking it as a prop. The cursor updates on every mousemove, and threading
// that through PointCloudViewer's state would re-render an 18k-line component
// at 60 Hz. Same reasoning as the hover stroke and `frameStateRef`.
export function SlabDragPreview({
  first,
  cursorRef,
  bounds,
  depth,
  displayOffset,
}: {
  /** The placed first point, world XY. */
  first: { x: number; y: number };
  /** Live cursor on the pick plane, world XY. Mutated outside React. */
  cursorRef: React.MutableRefObject<{ x: number; y: number } | null>;
  bounds: { min: THREE.Vector3; max: THREE.Vector3 };
  /** Thickness to preview at — held constant for the whole drag. */
  depth: number;
  displayOffset?: { x: number; y: number; z: number };
}) {
  const groupRef = useRef<THREE.Group>(null);
  const boxRef = useRef<THREE.LineSegments>(null);
  const fillRef = useRef<THREE.Mesh>(null);

  const geometry = useMemo(
    () => new THREE.EdgesGeometry(new THREE.BoxGeometry(1, 1, 1)),
    [],
  );
  const fillGeometry = useMemo(() => new THREE.BoxGeometry(1, 1, 1), []);
  const offsetMatrix = useMemo(() => new THREE.Matrix4().makeTranslation(
    -(displayOffset?.x ?? 0), -(displayOffset?.y ?? 0), -(displayOffset?.z ?? 0),
  ), [displayOffset?.x, displayOffset?.y, displayOffset?.z]);

  const scratch = useMemo(() => new THREE.Matrix4(), []);

  // Clear the seam on unmount. useFrame stops when this component goes away, so
  // without this the last published value survives — a committed section would
  // leave `visible: true` behind and any later reader would see a preview box
  // that is not on screen.
  useEffect(() => () => {
    (globalThis as any).__slabDragPreview = { visible: false };
  }, []);

  useFrame(() => {
    const cursor = cursorRef.current;
    const group = groupRef.current;
    if (!group) return;

    // Hide rather than render a degenerate box: at the instant of the first
    // click `a` and `b` coincide, the tangent is unstable, and a zero-width
    // flicker at the click point reads as a glitch.
    if (!cursor || !centrelineIsPreviewable(first, cursor, bounds)) {
      group.visible = false;
      (globalThis as any).__slabDragPreview = { visible: false };
      return;
    }
    group.visible = true;

    const slab = slabFromCentreline(first, cursor, bounds, depth);
    // E2E seam: the box is GPU-side geometry the DOM cannot show, so publish
    // the narrow facts a test needs — that it is drawn, and the dimensions it
    // is drawn at. Mirrors __labelOverlay / __slabDraw.
    (globalThis as any).__slabDragPreview = {
      visible: true,
      depth: slab.depth,
      length: Math.hypot(slab.b.x - slab.a.x, slab.b.y - slab.a.y),
    };
    scratch.copy(slabToBox(slab).matrix).premultiply(offsetMatrix);
    for (const node of [boxRef.current, fillRef.current]) {
      if (!node) continue;
      node.matrix.copy(scratch);
      node.matrixWorldNeedsUpdate = true;
    }
  });

  return (
    <group ref={groupRef} {...SCENE_OVERLAY} visible={false}>
      {/* A translucent fill as well as edges: drawn from top view — where the
          section is placed — the box's vertical edges are nearly degenerate, so
          a wireframe alone reads as an empty outline. The fill makes the
          footprint legible at the angle the user is actually looking from. */}
      <mesh ref={fillRef} geometry={fillGeometry} matrixAutoUpdate={false} renderOrder={9997}>
        <meshBasicMaterial
          color="#38bdf8"
          transparent
          opacity={0.12}
          depthTest={false}
          side={THREE.DoubleSide}
        />
      </mesh>
      <lineSegments ref={boxRef} geometry={geometry} matrixAutoUpdate={false} renderOrder={9998}>
        <lineBasicMaterial color="#38bdf8" transparent opacity={0.8} depthTest={false} />
      </lineSegments>
    </group>
  );
}
