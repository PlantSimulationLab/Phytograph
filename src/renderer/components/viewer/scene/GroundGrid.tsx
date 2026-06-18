import { useRef } from 'react';
import { useFrame } from '@react-three/fiber';
import { Grid } from '@react-three/drei';
import * as THREE from 'three';

interface GroundGridProps {
  // Grid plane center (display space). For z-up the grid sits at the scene
  // floor z; for y-up at the floor y.
  position: [number, number, number];
  rotation: [number, number, number];
  cellSize: number;
  sectionSize: number;
  // Lower bound for the faded radius — the real scene extent, so the grid is
  // always at least scene-sized even when the camera is close.
  baseFadeDistance: number;
}

// How much of the camera→target distance the faded radius spans. ~1.5 keeps the
// lit area filling the viewport at typical (~50°) fields of view, so the grid
// reads as an infinite ground plane at any zoom instead of a fixed disk.
const FADE_DISTANCE_FACTOR = 1.5;

// Target on-screen size of one grid cell, in CSS pixels. The per-frame LOD picks
// whichever world cell size lands a cell closest to this on screen, so cells stay
// legible at every zoom instead of packing tighter than a pixel (moiré, then a
// solid white wash) as the camera pulls back.
const TARGET_CELL_PX = 36;

// Snap a positive world length to the nearest value in the 1-2-5 decade sequence
// (… 0.1, 0.2, 0.5, 1, 2, 5, 10, 20 …). Stepping the grid resolution along this
// sequence keeps lines anchored to round world coordinates and changes density in
// gentle ~2–2.5× steps, instead of sliding continuously (lines drift under the
// camera) or jumping a jarring 10× per decade.
function snap125(x: number): number {
  const exp = Math.floor(Math.log10(x));
  const decade = Math.pow(10, exp);
  const frac = x / decade; // in [1, 10)
  const mantissa = frac < 1.5 ? 1 : frac < 3.5 ? 2 : frac < 7.5 ? 5 : 10;
  return mantissa * decade;
}

// drei's <Grid> fades each cell by its in-plane distance from the point under
// the camera, clamped at a *constant* fadeDistance — so a static value yields a
// fixed-radius disk that shrinks to nothing as you orbit/zoom out. We instead
// rescale fadeDistance every frame from the camera's distance to its orbit
// target, so the visible patch grows with viewing distance.
//
// The cell/section *world* sizes are likewise driven per frame: drei's Grid bakes
// them as material uniforms, so a fixed size means the cells shrink on screen as
// you pull back until the lines moiré and then merge into a solid white plane. We
// pick a world cell size each frame (snapped to the 1-2-5 sequence) so a cell
// stays ~TARGET_CELL_PX on screen at any zoom. The `cellSize`/`sectionSize` props
// are the *reference* sizes — only their ratio (sections every N cells) is kept;
// the absolute size is overridden by the LOD. All of this is a handful of uniform
// writes per frame, so it costs nothing at frame time.
export function GroundGrid({
  position,
  rotation,
  cellSize,
  sectionSize,
  baseFadeDistance,
}: GroundGridProps) {
  // drei's Grid forwards its ref to the underlying mesh, so ref.current.material
  // is the GridMaterial whose fadeDistance uniform we drive each frame.
  const ref = useRef<THREE.Mesh>(null);

  useFrame((state) => {
    const grid = ref.current;
    if (!grid) return;
    const controls = state.controls as { target?: THREE.Vector3 } | undefined;
    const target = controls?.target;
    const dist = target
      ? state.camera.position.distanceTo(target)
      : state.camera.position.length();
    const fade = Math.max(baseFadeDistance, dist * FADE_DISTANCE_FACTOR);
    const mat = grid.material as THREE.ShaderMaterial;
    const uniform = mat?.uniforms?.fadeDistance;
    if (uniform) uniform.value = fade;

    // Resolution LOD: choose a world cell size that projects to ~TARGET_CELL_PX.
    // worldPerPx is the world length one screen pixel spans at the orbit target;
    // for a perspective camera that's the view-plane height (2·dist·tan(fov/2))
    // divided by the viewport height in pixels. Multiply by the target pixel size
    // to get the desired world cell, then snap to the 1-2-5 sequence.
    const cam = state.camera as THREE.PerspectiveCamera;
    const cellU = mat?.uniforms?.cellSize;
    const sectionU = mat?.uniforms?.sectionSize;
    if (cam.isPerspectiveCamera && cellU && sectionU && dist > 0) {
      const viewportPx = state.size.height;
      const worldPerPx =
        (2 * dist * Math.tan((cam.fov * Math.PI) / 180 / 2)) / viewportPx;
      const cell = snap125(TARGET_CELL_PX * worldPerPx);
      // Preserve the caller's sections-every-N-cells cadence from the props.
      const ratio = sectionSize / cellSize;
      cellU.value = cell;
      sectionU.value = cell * ratio;
    }
    // drei's GridMaterial is transparent but leaves depthWrite at its default
    // (true). When the grid is snapped to z=0 it's coplanar with a created
    // ground plane (also at z=0); two depth-writing transparent surfaces at the
    // same depth flip draw order as the camera orbits → z-fighting/flicker that
    // settles when the drag stops. A reference grid should never write depth, so
    // the coplanar plane composites over it cleanly. depthTest stays on, so the
    // grid is still correctly occluded by geometry above it.
    if (mat && mat.depthWrite) mat.depthWrite = false;
    // Keep the grid behind everything coplanar at z=0 — a created ground plane,
    // and scan points that land on a z=0 patch in a single-return ground scan —
    // via two complementary mechanisms:
    //
    // 1. polygonOffset (push the grid's tested depth AWAY from the camera). This
    //    beats the scan POINTS. A depthFunc tie-break alone is not enough against
    //    points: the grid is one huge perspective-projected quad, so its
    //    interpolated depth at a pixel differs from a coincident point's vertex
    //    depth by sub-ULP rasterization noise — not a bit-exact tie. That noise
    //    straddles zero, so an equal-depth test flips per pixel/frame and the grid
    //    lines fight the points. A definite offset margin pushes the grid past it.
    // 2. depthFunc=LessDepth (lose every exact tie). This beats the PLANE, which
    //    carries the same +1 offset and DOES write depth; without LessDepth the
    //    grid would pass the equal-depth test at the plane's biased depth and
    //    paint over it. LessDepth also covers the orthographic crop-tool path,
    //    where polygon offset behaves differently.
    //
    // depthTest stays on, so real geometry above the grid still occludes it.
    if (mat && !mat.polygonOffset) {
      mat.polygonOffset = true;
      mat.polygonOffsetFactor = 1;
      mat.polygonOffsetUnits = 1;
    }
    if (mat && mat.depthFunc !== THREE.LessDepth) mat.depthFunc = THREE.LessDepth;
  });

  return (
    <Grid
      ref={ref}
      args={[100, 100]}
      cellSize={cellSize}
      cellThickness={0.5}
      cellColor="#404040"
      sectionSize={sectionSize}
      sectionThickness={1}
      sectionColor="#525252"
      position={position}
      rotation={rotation}
      fadeDistance={baseFadeDistance}
      infiniteGrid
      side={THREE.DoubleSide}
      // Draw before coplanar (renderOrder 0) transparent geometry like a z=0
      // ground plane, so the plane deterministically composites on top of the
      // grid instead of the two racing on per-frame transparent sort distance.
      renderOrder={-1}
    />
  );
}
