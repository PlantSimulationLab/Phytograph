import { useMemo } from 'react';
import * as THREE from 'three';
import { SCENE_OVERLAY } from '../../../lib/sceneOverlay';
import type { Measurement, MeasureVertex } from '../../../lib/measure';

// The in-scene half of the measurement tool: vertex markers and the lines
// between them.
//
// Modelled on SlabCentrelinePreview, which is the same "markers plus a
// connecting line" shape, and it carries four conventions that are each load-
// bearing:
//
//   * <group {...SCENE_OVERLAY}> — marks this as UI, not data. Without it
//     zoom-to-cursor's DepthProbe raycasts the measurement line and anchors the
//     camera on it (see lib/sceneOverlay.ts for the crop-box bug this exists
//     for).
//   * <lineSegments>, NEVER <line> — the lowercase r3f <line> intrinsic collides
//     with the SVG/DOM `line` element and silently fails to render. A polyline
//     is emitted as DUPLICATED consecutive vertex pairs, since lineSegments
//     draws disjoint pairs.
//   * renderOrder + depthTest={false} — a measurement has to stay readable
//     through the cloud it is measuring, not disappear inside it.
//   * positions come from `local` MINUS displayOffset — the scene renders at
//     (local − displayOffset), and a cloud's worldShift is already baked into
//     local. Using `world` here is invisible until a UTM-scale import.

// Drawn above the point cloud but below the transform gizmos, which a user may
// need to grab while a measurement is on screen.
const RENDER_ORDER = 9997;

// Committed measurements; the one being placed is drawn in the accent colour so
// it reads as "in progress".
const COMMITTED_COLOR = '#a3e635';   // lime, matching the picker's leader lines
const PENDING_COLOR = '#fbbf24';     // amber, matching the panel's armed state

// Vertex marker radius as a FRACTION of the measurement's own extent, so a
// marker is proportionate on a 2 cm seedling and on a 100 m stand alike. A
// fixed world radius would be either invisible or a beach ball.
const MARKER_EXTENT_FRAC = 0.012;
// Floor and ceiling in world units, for the degenerate cases: a zero-length
// measurement (two clicks on one point) would otherwise get a zero-size marker,
// and a single very long segment an absurd one.
const MARKER_MIN = 0.004;
const MARKER_MAX = 0.6;

function markerRadius(vertices: MeasureVertex[]): number {
  if (vertices.length === 0) return MARKER_MIN;
  const lo = [Infinity, Infinity, Infinity];
  const hi = [-Infinity, -Infinity, -Infinity];
  for (const v of vertices) {
    for (let i = 0; i < 3; i++) {
      if (v.local[i] < lo[i]) lo[i] = v.local[i];
      if (v.local[i] > hi[i]) hi[i] = v.local[i];
    }
  }
  const extent = Math.hypot(hi[0] - lo[0], hi[1] - lo[1], hi[2] - lo[2]);
  return Math.min(Math.max(extent * MARKER_EXTENT_FRAC, MARKER_MIN), MARKER_MAX);
}

// Consecutive vertices as the disjoint PAIRS lineSegments wants: a 3-vertex
// polyline becomes (v0,v1),(v1,v2), i.e. the middle vertex appears twice.
function pairedPositions(
  vertices: MeasureVertex[],
  offset: { x: number; y: number; z: number },
): Float32Array | null {
  if (vertices.length < 2) return null;
  const out = new Float32Array((vertices.length - 1) * 6);
  let k = 0;
  for (let i = 1; i < vertices.length; i++) {
    const a = vertices[i - 1].local;
    const b = vertices[i].local;
    out[k++] = a[0] - offset.x; out[k++] = a[1] - offset.y; out[k++] = a[2] - offset.z;
    out[k++] = b[0] - offset.x; out[k++] = b[1] - offset.y; out[k++] = b[2] - offset.z;
  }
  return out;
}

function MeasureGeometry({
  vertices,
  color,
  displayOffset,
}: {
  vertices: MeasureVertex[];
  color: string;
  displayOffset: { x: number; y: number; z: number };
}) {
  const ox = displayOffset.x;
  const oy = displayOffset.y;
  const oz = displayOffset.z;

  // Keyed on the actual coordinates so a carried-along measurement (one whose
  // cloud was transformed under it) rebuilds, while an unrelated re-render does
  // not. JSON of the local coords is cheap here — a measurement is a handful of
  // vertices, never a point cloud.
  const key = useMemo(
    () => vertices.map((v) => v.local.join(',')).join(';'),
    [vertices],
  );

  const geometry = useMemo(() => {
    const pos = pairedPositions(vertices, { x: ox, y: oy, z: oz });
    if (!pos) return null;
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    return g;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key, ox, oy, oz]);

  const radius = useMemo(() => markerRadius(vertices), [key]); // eslint-disable-line react-hooks/exhaustive-deps

  return (
    <>
      {vertices.map((v, i) => (
        <mesh
          key={i}
          position={[v.local[0] - ox, v.local[1] - oy, v.local[2] - oz]}
          renderOrder={RENDER_ORDER}
          // Markers must never be raycast targets: the picker resolves the next
          // vertex against the cloud, and a marker sitting exactly on a picked
          // point would otherwise shadow it.
          raycast={() => null}
        >
          <sphereGeometry args={[radius, 12, 12]} />
          <meshBasicMaterial color={color} depthTest={false} transparent opacity={0.95} />
        </mesh>
      ))}
      {geometry && (
        <lineSegments geometry={geometry} renderOrder={RENDER_ORDER} raycast={() => null}>
          <lineBasicMaterial color={color} depthTest={false} transparent opacity={0.9} />
        </lineSegments>
      )}
    </>
  );
}

export function MeasureLines({
  measurements,
  pending,
  displayOffset,
}: {
  /** Committed measurements, drawn in the settled colour. */
  measurements: Measurement[];
  /** Vertices of the measurement currently being placed, if any. */
  pending: MeasureVertex[];
  /** The scene renders at (local − displayOffset). */
  displayOffset: { x: number; y: number; z: number };
}) {
  if (measurements.length === 0 && pending.length === 0) return null;

  return (
    <group {...SCENE_OVERLAY}>
      {measurements.map((m) => (
        <MeasureGeometry
          key={m.id}
          vertices={m.vertices}
          color={COMMITTED_COLOR}
          displayOffset={displayOffset}
        />
      ))}
      {pending.length > 0 && (
        <MeasureGeometry
          vertices={pending}
          color={PENDING_COLOR}
          displayOffset={displayOffset}
        />
      )}
    </group>
  );
}
