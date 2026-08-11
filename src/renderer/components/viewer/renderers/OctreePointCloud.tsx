import { useEffect, useMemo, useRef, useState } from 'react';
import { useThree } from '@react-three/fiber';
import { PointCloudOctree, PointColorType, PointSizeType, ClipMode, createClipBox } from 'potree-core';
import * as THREE from 'three';
import { ColormapName, sampleColormap } from '../../../lib/colormaps';
import { categoricalSchemeForRange, buildCategoricalGradientStops } from '../../../lib/classification';
import type { PointCloudData } from '../../../lib/pointCloudTypes';
import { ORIG_INTENSITY_ATTRIBUTE } from '../../../lib/pointPick';
import { getPotreeManager, OctreeRequestManager, registerOctreeForFrame } from '../potreeManager';
import { applyOctreePose } from './octreePose';
import {
  applyCropMaskToVisibleNodes,
  clearCropMaskFromVisibleNodes,
  publishCropMaskStats,
} from './octreeCropMask';
import {
  applyLabelOverlayToVisibleNodes,
  clearLabelOverlayFromVisibleNodes,
  type LabelOverlayState,
} from './octreeLabelOverlay';

// =====================================================================
// Octree streaming (0.3.0+)
// =====================================================================
// Renders a point cloud whose source of truth is an on-disk Potree 2.0
// octree (metadata.json + hierarchy.bin + octree.bin in the backend's
// cache dir). Tiles stream into the GPU via the `app://octree/...`
// protocol registered in src/main/octreeProtocol.ts. This replaces the
// flat-Float32Array path for any cloud large enough to hit V8's heap
// limit — the renderer never holds more than the visible point set
// (capped by pointBudget).

// Silence potree-core's "loaded node with 0 bytes: rN" console.warn.
// PotreeConverter legitimately writes zero-byte hierarchy entries (octants
// whose points all landed in children after subsampling, or empty leaves
// kept for structure — a 13 M-point scan has hundreds of them), and
// potree-core handles them correctly (empty geometry, renders nothing) but
// warns unconditionally for each one, flooding the dev console on import.
// The warn is buried in its bundle with no opt-out, so filter that exact
// message and pass everything else through untouched. The marker keeps the
// wrapper from stacking when Vite HMR re-evaluates this module.
const POTREE_WARN_FILTER = Symbol.for('phytograph.potreeWarnFilter');
if (!(console.warn as unknown as Record<symbol, boolean>)[POTREE_WARN_FILTER]) {
  const originalWarn = console.warn.bind(console);
  const filtered = (...args: unknown[]) => {
    if (typeof args[0] === 'string' && args[0].startsWith('loaded node with 0 bytes:')) return;
    originalWarn(...args);
  };
  (filtered as unknown as Record<symbol, boolean>)[POTREE_WARN_FILTER] = true;
  console.warn = filtered;
}

export interface OctreePointCloudProps {
  data: PointCloudData;  // must have data.octree set
  pointSize?: number;
  colorMode?: 'rgb' | 'intensity' | 'height' | 'single' | 'scalar';
  // When colorMode is 'scalar', the on-disk attribute slug to colour by
  // (e.g. 'Reflectance_dB'). Matches a key in data.octree.attributeRanges and
  // a named THREE.Float32 BufferAttribute on each loaded tile geometry.
  selectedScalarField?: string;
  singleColor?: string;
  // Active colormap selected in the UI (viridis, plasma, etc.). When
  // colorMode is 'height' or 'intensity' we build a potree-core
  // IGradient from this and assign it to the material — without this,
  // the cloud uses potree-core's default rainbow gradient instead of
  // matching the toolbar selection (and the colorbar overlay).
  colormap?: ColormapName;
  // User-overridden colorbar range (toolbar's Min/Max inputs). When
  // set, override the data-derived heightMin/Max + intensityRange so
  // the on-screen gradient sweeps over the user's chosen window
  // instead of the cloud's natural extrema.
  rangeMin?: number;
  rangeMax?: number;
  // Optional AABB clip volume. When set, points outside the box are
  // discarded by the shader on the GPU — no re-fetch, no re-mount, runs
  // at frame rate. Used for the live crop preview while the user drags
  // the gizmo. Apply still goes through the backend re-conversion so the
  // final cropped octree is full-resolution. `invert=true` flips the
  // semantic to "discard points INSIDE the box" so the preview matches
  // the Crop tool's invert checkbox.
  clipBox?: {
    min: THREE.Vector3;
    max: THREE.Vector3;
    invert?: boolean;
  } | null;
  // Optional clip-box volumes — the live erase-brush preview. Each entry is the
  // world→box transform of an oriented box (camera-aligned, square cross-section,
  // extruded deep along the view axis) so painting a square stamp removes the
  // points behind it. potree-core's shader ORs all boxes together (a point is
  // "inside" if it falls within ANY box); under CLIP_INSIDE it culls them on the
  // GPU at frame rate, matching the screen-space squares the strokes commit on
  // Apply (crop_octree squares_union region). Mutually exclusive with `clipBox`
  // — the material has one `clipMode`, so the two are resolved into a single
  // `clipState` (crop box wins) by the clip-arbitration memo below, which is
  // the ONLY place clipMode is written. We take the box transform matrix and
  // derive the inverse the shader needs there, keeping potree-core's IClipBox
  // detail out of the parent.
  clipBoxes?: Array<{ matrix: THREE.Matrix4 }> | null;
  // Exact per-point crop preview for a SCREEN-SPACE region (freeform polygon,
  // or a rect drawn from an arbitrary camera). Those regions aren't boxes, so
  // the GPU clip volume above can't express them and potree's material has no
  // per-point discard to drive — the predicate runs on the CPU over the loaded
  // tiles instead, and rejected points are hidden with an index buffer (see
  // octreeCropMask.ts). Box crops keep using `clipBox`: it's exact for an AABB
  // and runs on the GPU at frame rate, which matters while the gizmo drags.
  //
  // `predicate` takes WORLD coordinates and returns "inside the region";
  // `invert` flips it for Keep-Outside. `key` changes whenever the region
  // changes and is what triggers a re-mask — pass a stable string.
  cropMask?: {
    predicate: (wx: number, wy: number, wz: number) => boolean;
    invert: boolean;
    key: string;
  } | null;
  /**
   * Live manual-labelling preview, read through a REF.
   *
   * A label change cannot be shown the way a deletion can: deletions are a GPU
   * clip volume, but class values are baked into octree.bin at conversion time,
   * so a repaint is invisible until a rebuild (minutes). The overlay paints a
   * per-tile label column client-side instead — see octreeLabelOverlay.ts.
   *
   * A ref, not a prop value, because the hover/stroke list changes far more
   * often than this 900-line component should re-render — the same reason
   * `frameStateRef` exists.
   */
  labelOverlayRef?: React.MutableRefObject<LabelOverlayState | null> | null;
  /** Octree attribute holding COMMITTED labels, so a post-commit tile starts
   *  from the baked values rather than blank. */
  labelCommittedSlug?: string | null;
  /** Categorical scheme for the overlay's dense INDEX values, so the points and
   *  the legend agree while previewing. Null when not labelling. */
  labelIndexScheme?: { attribute: string; classes: Array<{ value: number; label: string; color: [number, number, number] }> } | null;
  /**
   * Cross-section slab, as world-space half-space planes (see
   * lib/crossSection.ts `slabToPlanes`). When set, points outside the slab are
   * culled on the GPU so the user works in a thin, unoccluded section.
   *
   * Planes rather than a clip BOX on purpose: they AND-intersect and can only
   * clear `insideAny`, so they compose with the rest of the clip system instead
   * of fighting it — and, unlike a box, they do not trip the crop preview's
   * LOD/point-budget reduction. A section must render at FULL resolution: the
   * whole argument for the workflow is that the slab already bounds the point
   * count (this is what ArcGIS does), so degrading it would defeat the purpose.
   */
  slabPlanes?: THREE.Plane[] | null;
  // World-space translation for this cloud (the Translate tool / T-modal value).
  // The PointCloudOctree is attached directly to the scene root (not inside the
  // parent's React `<group position>`), so the group transform does NOT reach it
  // — we have to set the offset on the octree object itself. Defaults to origin.
  translation?: { x: number; y: number; z: number };
  // World-space draft ROTATION (Euler XYZ, DEGREES) from the Transformation tool,
  // applied about `pivot`. Like `translation` it's a render-only preview baked on
  // OK. Because the octree lives on the scene root we compose it into the object's
  // matrix (position alone can't carry a pivot rotation). Defaults to no rotation.
  rotation?: { x: number; y: number; z: number };
  // World-space pivot the rotation turns about (scene origin, or the cloud's bbox
  // center when none is set). Ignored when rotation is zero. Defaults to origin.
  pivot?: { x: number; y: number; z: number };
  // Render-only display offset (Layer 2 precision safety net). The whole scene
  // renders at (world − displayOffset) so large UTM coordinates land near the
  // origin. The octree attaches to the scene root, so — like `translation` — the
  // offset must be applied to pco.position directly. potree node-local positions
  // are already small float32 (re-origined server-side before tiling), so this is
  // a pure float64 placement: no buffer rewrite, no precision concern. Defaults
  // to origin (small-coord scenes are unaffected).
  displayOffset?: { x: number; y: number; z: number };
  // Fired once, the first time LOD tiles have actually streamed in for this
  // mount. The parent uses it to force a single fresh-material remount so a
  // cloud that mounted directly into a gradient colour mode recompiles its
  // shader with geometry present (see octreePaintGen in PointCloudViewer).
  onFirstTilesReady?: () => void;
  // Hands the live PointCloudOctree to the parent (and null on unmount) so the
  // erase-brush gizmo can call octree.pick(...) to anchor the brush to the
  // hovered surface point. The instance lives inside this component's load
  // effect; this is the narrowest way to expose it without plumbing the potree
  // manager's internals through React.
  onOctreeReady?: (octree: PointCloudOctree | null) => void;
  // Called when the octree files can't be loaded because they're absent on disk
  // (the app:// protocol handler 404s and the loader rejects). The parent owns
  // recovery: rebuild the octree from the source descriptor or surface an
  // actionable message. Invoked at most once per cacheId (guarded here) so a
  // genuinely unrecoverable cloud can't spin a rebuild loop.
  onOctreeMissing?: () => void;
}

// Point a tile geometry's `intensity` attribute at the named scalar
// attribute's buffer so the INTENSITY_GRADIENT shader path colours by it.
// The Potree 2.0 loader decodes every non-builtin octree attribute into a
// named Float32 BufferAttribute (geometry.attributes[field]); aliasing it
// into `intensity` is a zero-copy reference swap. Idempotent — re-running on
// an already-swapped geometry is a no-op (same buffer reference). Returns
// true if the geometry had the field (so callers can detect missing data).
//
// Before the first swap the REAL intensity buffer is re-registered under
// ORIG_INTENSITY_ATTRIBUTE. potree's picker reports a point's value for every
// named attribute on the geometry, so without this the point picker would read
// the aliased scalar and label it "intensity". It's another zero-copy
// reference (no second upload — three.js only uploads attributes the active
// shader program actually binds).
function swapScalarIntoIntensity(geometry: any, field: string): boolean {
  const src = geometry?.attributes?.[field];
  if (!src) return false;
  if (geometry.attributes.intensity !== src) {
    if (!geometry.attributes[ORIG_INTENSITY_ATTRIBUTE] && geometry.attributes.intensity) {
      geometry.setAttribute(ORIG_INTENSITY_ATTRIBUTE, geometry.attributes.intensity);
    }
    geometry.setAttribute('intensity', src);
  }
  return true;
}

// Walk an octree's currently-loaded tiles and apply the scalar→intensity
// buffer swap to each. Tiles stream in asynchronously, so this is called both
// from the material effect (already-loaded tiles) and per-frame (newly
// arrived tiles).
function applyScalarSwapToVisibleNodes(octree: any, field: string): void {
  const visible = octree?.visibleNodes;
  if (!Array.isArray(visible)) return;
  for (const node of visible) {
    const geom = node?.sceneNode?.geometry;
    if (geom) swapScalarIntoIntensity(geom, field);
  }
}

// Octree LOD level cap applied WHILE a crop box is previewing. Limiting the
// preview by point budget alone makes potree refine the highest-priority nodes
// deeply and leave the rest coarse — visibly uneven density (a sparse "notch"
// beside dense blobs). Capping the level instead makes potree render every
// region at one consistent level, so the reduced preview is uniform. Tunable:
// higher = denser/uniform but heavier; lower = sparser/lighter. Removed on exit.
const CROP_PREVIEW_MAX_LEVEL = 4;

// True when the crop clip box provably yields an EMPTY result for this cloud —
// so the per-frame LOD update can be skipped and the cloud simply hidden.
//
// Why this matters: potree fills its point budget from UN-clipped nodes only
// (a node whose bbox misses the clip box is `continue`d before its points are
// counted). When the box excludes the whole cloud the budget never fills, which
// defeats the LOD early-out — potree keeps descending and streaming the region
// to try to reach the budget. On a large cloud that's the "ultra laggy the
// moment the crop box leaves the points" bug. Skipping the update kills it.
//
// Conservative by construction: returns true only when emptiness is CERTAIN
// from the AABBs (box disjoint from the cloud for keep-inside; box fully
// containing the cloud for keep-outside), so it can never hide points that
// should be visible. The clip box and the cloud's bounds share the
// (data-bounds + translation) world frame — display/base offsets are render-only
// and cancel in the shader, so they're irrelevant to this test.
function cropClipsEverything(
  clipBox: { min: THREE.Vector3; max: THREE.Vector3; invert?: boolean },
  bounds: { min: THREE.Vector3; max: THREE.Vector3 },
  translation: { x: number; y: number; z: number },
): boolean {
  const { x: tx, y: ty, z: tz } = translation;
  const bminx = bounds.min.x + tx, bminy = bounds.min.y + ty, bminz = bounds.min.z + tz;
  const bmaxx = bounds.max.x + tx, bmaxy = bounds.max.y + ty, bmaxz = bounds.max.z + tz;
  const { min, max } = clipBox;
  if (clipBox.invert) {
    // keep-outside (CLIP_INSIDE): empty iff the box fully contains the cloud.
    return min.x <= bminx && max.x >= bmaxx &&
           min.y <= bminy && max.y >= bmaxy &&
           min.z <= bminz && max.z >= bmaxz;
  }
  // keep-inside (CLIP_OUTSIDE): empty iff the box is disjoint from the cloud.
  return max.x < bminx || min.x > bmaxx ||
         max.y < bminy || min.y > bmaxy ||
         max.z < bminz || min.z > bmaxz;
}

export function OctreePointCloud({
  data,
  pointSize = 2,
  colorMode = 'rgb',
  selectedScalarField,
  singleColor = '#a1a1aa',
  colormap = 'viridis',
  rangeMin,
  rangeMax,
  clipBox = null,
  clipBoxes = null,
  labelOverlayRef = null,
  labelCommittedSlug = null,
  labelIndexScheme = null,
  slabPlanes = null,
  cropMask = null,
  translation,
  rotation,
  pivot,
  displayOffset,
  onFirstTilesReady,
  onOctreeReady,
  onOctreeMissing,
}: OctreePointCloudProps) {
  const [octree, setOctree] = useState<PointCloudOctree | null>(null);
  const firstTilesFiredRef = useRef(false);
  // Tracks the last crop-empty/hidden state so the E2E hook (__octreeCropHidden)
  // is only written on transition, not every frame.
  const cropHiddenRef = useRef<boolean | null>(null);
  // Ticks every time the material effect recreates the material. The
  // ClipBox effect depends on this so it re-applies the clip volume to
  // the fresh material instance — otherwise toggling color mode while a
  // crop preview is active would drop the ClipBox.
  const [materialVersion, setMaterialVersion] = useState(0);
  const manager = getPotreeManager();
  const { scene } = useThree();

  // Keep the latest onOctreeReady in a ref so the load effect (keyed on
  // cacheId) doesn't re-run when the parent passes a new callback identity.
  const onOctreeReadyRef = useRef(onOctreeReady);
  onOctreeReadyRef.current = onOctreeReady;

  // Same ref pattern for the missing-octree callback, so the cacheId-keyed loader
  // effect doesn't re-run when the parent passes a new callback identity.
  const onOctreeMissingRef = useRef(onOctreeMissing);
  onOctreeMissingRef.current = onOctreeMissing;

  // The cacheId we've already reported as missing, so a load failure fires the
  // recovery callback at most once per octree — even if React re-runs the effect.
  // A rebuild produces a new mount (bumped paint generation) with a working
  // octree, so this guard never blocks a legitimate retry.
  const reportedMissingRef = useRef<string | null>(null);

  // Latest translation in a ref so the cacheId-keyed loader effect can seed the
  // initial position without taking `translation` as a dependency (which would
  // tear down and reload the whole octree on every drag tick).
  const translationRef = useRef(translation);
  translationRef.current = translation;

  // Same ref pattern for the draft rotation + pivot, so the loader effect seeds
  // the initial matrix without reloading the octree on every rotation tick.
  const rotationRef = useRef(rotation);
  rotationRef.current = rotation;
  const pivotRef = useRef(pivot);
  pivotRef.current = pivot;

  // Same pattern for the render-only display offset, so the cacheId-keyed loader
  // seeds the initial position with the offset already applied (no streaming jump)
  // without reloading the octree when the offset recomputes.
  const displayOffsetRef = useRef(displayOffset);
  displayOffsetRef.current = displayOffset;

  // The position potree-core assigns the cloud at load time. PotreeConverter
  // stores points relative to a per-cloud offset (usually the bounding-box min),
  // and potree-core bakes that offset into pco.position so the cloud lands in
  // world space. Our Translate offset must be ADDED on top of this base — setting
  // pco.position outright would wipe the loader's offset and slam the cloud's
  // min-corner to the origin. Captured once per load.
  const basePositionRef = useRef<THREE.Vector3>(new THREE.Vector3());

  // Load on cacheId change, then attach the resulting PointCloudOctree
  // directly to the scene. `<primitive object={...}/>` works but is fiddly
  // when the same Potree manager has multiple clouds — explicit scene.add /
  // scene.remove is what the potree-core README recommends and gives us a
  // predictable lifecycle.
  useEffect(() => {
    if (!data.octree) return;
    const url = `app://octree/${data.octree.cacheId}/metadata.json`;
    let cancelled = false;
    let pcoForCleanup: PointCloudOctree | null = null;
    manager
      .loadPointCloud(url, OctreeRequestManager)
      .then((pco) => {
        if (cancelled) {
          pco.dispose();
          return;
        }
        // Snapshot the loader's base offset, then seed our transform (translation
        // + rotation about the pivot) on top of it before the first frame so the
        // cloud streams in at its transformed pose (no visible jump). Kept live by
        // the effect below as the user drags a gizmo / types a value.
        basePositionRef.current.copy(pco.position);
        applyOctreePose(
          pco, basePositionRef.current,
          translationRef.current, rotationRef.current, pivotRef.current, displayOffsetRef.current,
        );
        scene.add(pco);
        pcoForCleanup = pco;
        setOctree(pco);
        onOctreeReadyRef.current?.(pco);
      })
      .catch((err) => {
        if (cancelled) return;
        console.error(`Octree load failed for ${data.octree?.cacheId}:`, err);
        // A load rejection here means the octree files are unavailable on disk:
        // the app:// protocol handler 404s and potree-core throws (a JSON-parse
        // error on the 404 body). Don't string-match the message — any failure to
        // load is treated as "octree missing" and handed to the parent for
        // recovery (rebuild from source / actionable toast). Guard so it fires at
        // most once per cacheId.
        const id = data.octree?.cacheId;
        if (id && reportedMissingRef.current !== id) {
          reportedMissingRef.current = id;
          onOctreeMissingRef.current?.();
        }
      });
    return () => {
      cancelled = true;
      onOctreeReadyRef.current?.(null);
      if (pcoForCleanup) {
        scene.remove(pcoForCleanup);
        pcoForCleanup.dispose();
      }
    };
  }, [data.octree?.cacheId, manager, scene]);

  // Keep the octree's world pose in sync with the Transformation tool. The cloud
  // is attached to the scene root, so the parent's `<group position>` doesn't
  // reach it — we set position (pure translation) or the full matrix (rotation
  // about the pivot) on the octree object directly. Runs at frame rate via React
  // state, which is plenty for a gizmo drag.
  useEffect(() => {
    if (!octree) return;
    const base = basePositionRef.current;
    applyOctreePose(octree, base, translation, rotation, pivot, displayOffset);
    // E2E hook: expose the live octree's net translation (offset from its base
    // load position) keyed by cacheId. Tests assert on THIS (the three.js object
    // state) rather than React state, because the translate bug was precisely
    // that React state was correct while the rendered object ignored it. For a
    // pure translation `octree.position` equals base + t − offset, so net/world
    // read exactly as before; with a rotation active `position` also carries the
    // rotation's translation term (no existing test reads net mid-rotation).
    // Cleaned up on unmount.
    const cacheId = data.octree?.cacheId;
    if (cacheId) {
      const reg = ((window as any).__octreePositions ??= {});
      const off = displayOffset ?? { x: 0, y: 0, z: 0 };
      reg[cacheId] = {
        net: {
          x: octree.position.x - base.x + off.x,
          y: octree.position.y - base.y + off.y,
          z: octree.position.z - base.z + off.z,
        },
        world: {
          x: octree.position.x + off.x,
          y: octree.position.y + off.y,
          z: octree.position.z + off.z,
        },
        displayOffset: { x: off.x, y: off.y, z: off.z },
      };
    }
  }, [octree, translation?.x, translation?.y, translation?.z, rotation?.x, rotation?.y, rotation?.z, pivot?.x, pivot?.y, pivot?.z, displayOffset?.x, displayOffset?.y, displayOffset?.z, data.octree?.cacheId]);

  // Drop the E2E position + crop-hidden hooks for this cloud on unmount.
  useEffect(() => {
    const cacheId = data.octree?.cacheId;
    return () => {
      if (cacheId && (window as any).__octreePositions) {
        delete (window as any).__octreePositions[cacheId];
      }
      if (cacheId && (window as any).__octreeCropHidden) {
        delete (window as any).__octreeCropHidden[cacheId];
      }
    };
  }, [data.octree?.cacheId]);

  // Material settings.
  //
  // Three coordinates have to land together for octree colour to look right:
  //
  //   1. `newFormat` is mutually exclusive with non-RGB modes. The shader's
  //      POINT COLOR SELECTION starts with `#ifdef new_format → vColor = rgba`,
  //      which short-circuits every pointColorType-keyed branch that comes
  //      after. So `newFormat=true` only for colorMode==='rgb'; every other
  //      mode needs newFormat=false so `#elif defined color_type_color /
  //      height / intensity` can fire. newFormat is a plain instance field
  //      (no @J() decorator), so changing it doesn't auto-trigger
  //      updateShaderSource — we call it explicitly below.
  //
  //   2. `inputColorEncoding = LINEAR (0)` and `outputColorEncoding = LINEAR (0)`.
  //      potree-core's defaults (input=sRGB, output=LINEAR) trigger a
  //      `vColor = fromLinear(vColor)` at the bottom of the fragment shader.
  //      That re-encodes the display-encoded uint8 RGB PotreeConverter wrote
  //      into the cloud, collapsing every channel toward grayscale — the
  //      "mostly white with random colour flecks" symptom. Matching them at
  //      LINEAR makes the conditional fall through and vColor flows
  //      untouched.
  //
  //   3. Component re-mount on colorMode change. The dispatch below keys
  //      `<OctreePointCloud key={`octree-${colorMode}`}>` so React unmounts
  //      and remounts when the mode changes. That gives us a fresh
  //      PointCloudMaterial from potree-core's loader, fresh BindingStates
  //      for every per-tile sceneNode, and a clean WebGLProgram compile.
  //      Without the re-mount, three.js's BindingState cache keeps the old
  //      attribute slot mapping (e.g. position@0 only) and the new attribute
  //      (rgba@8 in newFormat=true mode) goes unbound — symptom: cloud
  //      renders effectively black after a mode change. Re-mount cost on
  //      the cached octree is ~10 ms (the octree.bin tiles stay in
  //      potree-core's PCOGeometry cache; only the GPU material/program
  //      gets rebuilt).
  useEffect(() => {
    if (!octree) return;

    // Why dispose + recreate the material instead of mutating in place:
    // three.js's WebGLPrograms cache is keyed on the material instance.
    // potree-core's pointColorType setter rewrites the shader source
    // string and flips `needsUpdate=true`, but in practice three.js
    // continues serving the previously compiled program — toggling
    // colour modes after the first frame leaves JS state matching the
    // new mode while the GPU keeps drawing the old one. Replacing the
    // material outright forces a fresh program compile on the next draw.
    //
    // Tile propagation: per-tile sceneNodes (created by potree-core's
    // toTreeNode as the LOD streamer loads each node) capture the cloud
    // material at construction time. The cloud's `set material(m)`
    // setter only updates `octree._material` — it does NOT push the new
    // material to existing tile.material refs. We walk the scene graph
    // after the swap and overwrite each Points.material so tiles that
    // were already loaded see the new instance. Tiles streamed AFTER
    // this effect runs will see the new octree.material at their own
    // construction time, so forward propagation is automatic.
    // newFormat is mutually exclusive with non-RGB modes (the shader's
    // POINT COLOR SELECTION starts with `#ifdef new_format → vColor =
    // rgba`, short-circuiting every pointColorType-keyed branch). So
    // newFormat only for colorMode==='rgb'.
    const isRgbMode = colorMode === 'rgb';
    // Scalar mode is active only when a field is selected AND the octree
    // actually carries a range for it (i.e. the attribute survived import).
    // When inactive, scalar falls back to a solid colour like 'single'.
    const scalarRange =
      colorMode === 'scalar' && selectedScalarField
        ? data.octree?.attributeRanges?.[selectedScalarField]
        : undefined;
    // The labelling overlay supplies its own range (dense palette indices), and
    // it must work BEFORE the first commit — at which point the octree carries
    // no `manual_class` attribute at all, so attributeRanges has no entry and
    // the check above would leave scalar mode inactive, silently falling back to
    // a solid colour with the painted classes invisible.
    const scalarActive = !!scalarRange || !!labelIndexScheme;
    const m = octree.material;

    // Mutate newFormat directly. potree-core doesn't expose a setter for
    // this — it's a plain instance field read at shader-compile time —
    // so we have to force a shader rebuild after changing it.
    (m as any).newFormat = isRgbMode;
    // Force the shader to do linear→sRGB on its output so the framebuffer
    // bytes match the user-intended display colour. Three.js's
    // RawShaderMaterial bypasses the renderer's outputColorSpace conversion
    // — whatever the shader writes goes to the framebuffer as raw bytes.
    // potree-core's conditional that calls fromLinear() (linear→sRGB) is
    // gated on `output_color_encoding_linear && input_color_encoding_sRGB`.
    // That's the combination we want active.
    // No shader-side conversion. Three.js's RawShaderMaterial bypasses
    // the renderer's outputColorSpace conversion, so the shader's output
    // bytes land in the framebuffer unchanged. To get a sRGB-display-
    // correct render, we feed the shader uColor / gradient stops / rgba
    // pre-encoded in sRGB (uniforms are stored in linear-as-sRGB-bytes,
    // so `new THREE.Color(hex)` followed by `convertLinearToSRGB()` keeps
    // them in [0,1] but with sRGB-encoded values that the shader passes
    // straight to the framebuffer).
    (m as any).inputColorEncoding = 0;
    (m as any).outputColorEncoding = 0;
    m.pointSizeType = PointSizeType.FIXED;
    m.size = pointSize;

    // Height: getElevation() in the shader is
    //   w = (world.z - heightMin) / (heightMax - heightMin)
    // and samples a gradient texture at (w, 1-w). Without setting
    // heightMin/heightMax, the cloud's `set material` setter would have
    // populated them from the tight bounding box — but only when the
    // setter fires, which we bypass by mutating the existing material in
    // place.
    //
    // When the user has explicitly set Min/Max in the Color By panel
    // (rangeMin / rangeMax), honour those values directly. Otherwise
    // derive from data.bounds.z and pad by 20% on each end so the top
    // and bottom of the cloud aren't pinned exactly at the gradient
    // texture's edge texels (mirrors potree-core's own setter).
    if (rangeMin !== undefined && rangeMax !== undefined && rangeMax > rangeMin) {
      (m as any).heightMin = rangeMin;
      (m as any).heightMax = rangeMax;
    } else {
      const zMin = data.bounds.min.z;
      const zMax = data.bounds.max.z;
      const zPad = 0.2 * Math.max(zMax - zMin, 1e-6);
      (m as any).heightMin = zMin - zPad;
      (m as any).heightMax = zMax + zPad;
    }

    // Intensity: getIntensity() does
    //   w = (intensity - intensityRange.x) / (intensityRange.y - intensityRange.x)
    // potree-core's default is [0, 65000], but PotreeConverter's
    // metadata carries the actual per-attribute extrema. For the typical
    // BPPtree workflow `intensity = reflectance × 256` clamped to
    // [0, 65535] — so a typical reflectance 0-255 maps to 0-65280 — but
    // the actual range PotreeConverter saw is in the metadata.
    // Without setting this, every point maps to roughly w ≈ 0 because
    // [0, 65000] is much wider than typical input, and the cloud
    // renders as the gradient's "low" texel — a uniform colour.
    // The shader's getIntensity() reads the geometry attribute named
    // `intensity` and maps it through intensityRange → gradient. Scalar mode
    // reuses this exact pipeline by (a) pointing intensityRange at the
    // selected attribute's extrema here, and (b) copying the selected
    // attribute's buffer into each tile's `intensity` slot below.
    const gradientRange = scalarActive
      ? scalarRange
      : data.octree?.attributeRanges?.intensity;
    // The effective [min,max] the SHADER uses to normalise each value into the
    // gradient's 0..1 sample coordinate (t = (value - min) / (max - min)). The
    // categorical step gradient below MUST be built against this SAME range, not
    // the raw attribute range — otherwise the class bands and the sampled t land
    // in different value spaces. For a constant column (e.g. an all-hits is_miss,
    // range [0,0]) the widened [min-1, min+1] makes every point sample t=0.5; if
    // the bands were laid out on the raw [0,0] that midpoint falls on the seam
    // and every point picks up the wrong class (all "Miss"). Keeping them in sync
    // makes t=0.5 land squarely inside the single present class's band.
    let effectiveRange: [number, number] | undefined;
    if (rangeMin !== undefined && rangeMax !== undefined && rangeMax > rangeMin) {
      // User-overridden range from the Color By panel — use it directly.
      // The backend backs this with the actual intensity (reflectance ×
      // 256) so the user's UI values are in the same units as the
      // gradient sweep.
      effectiveRange = [rangeMin, rangeMax];
    } else if (gradientRange && gradientRange.min.length > 0 && gradientRange.max.length > 0) {
      const iMin = gradientRange.min[0];
      const iMax = gradientRange.max[0];
      // Guard against a zero-width range (constant values) — set
      // [min-1, min+1] so the divisor isn't zero and the cloud renders
      // as the middle of the gradient instead of NaN.
      effectiveRange = iMax > iMin ? [iMin, iMax] : [iMin - 1, iMin + 1];
    }
    if (effectiveRange) {
      (m as any).intensityRange = effectiveRange;
    }
    // The labelling overlay writes DENSE PALETTE INDICES into the intensity
    // slot, so the shader's value space must be [0, n-1] to match. Without this
    // the stops are laid out over the palette's index range while the shader
    // maps each index against the OCTREE attribute's range — every point then
    // samples the wrong part of the gradient (in practice: the whole cloud
    // renders as one flat colour, usually the unclassified grey, no matter what
    // was painted).
    if (labelIndexScheme) {
      const n = Math.max(1, labelIndexScheme.classes.length - 1);
      (m as any).intensityRange = [0, n];
    }

    switch (colorMode) {
      case 'rgb': m.pointColorType = PointColorType.RGB; break;
      case 'intensity':
        // INTENSITY_GRADIENT samples the cloud's gradient texture; the
        // plain INTENSITY mode writes vColor=vec3(w) which renders as
        // grayscale and is hard to distinguish from background. Use
        // gradient by default — matches what the flat-array PointCloud
        // dispatch does via its sampleColormap path.
        m.pointColorType = PointColorType.INTENSITY_GRADIENT;
        break;
      case 'height': m.pointColorType = PointColorType.HEIGHT; break;
      case 'scalar':
        if (scalarActive) {
          // Reuse the intensity gradient pipeline; the selected attribute's
          // buffer is swapped into `intensity` below so getIntensity()
          // samples the chosen scalar. Range + gradient set above/below.
          m.pointColorType = PointColorType.INTENSITY_GRADIENT;
        } else {
          // No usable attribute (unknown field, or octree predates this
          // feature) — render a solid colour like 'single'.
          m.pointColorType = PointColorType.COLOR;
          m.color = new THREE.Color(singleColor ?? '#a1a1aa').convertLinearToSRGB();
        }
        break;
      case 'single':
        m.pointColorType = PointColorType.COLOR;
        // Pre-encode the swatch as sRGB. THREE.Color('#hex') parses the
        // hex as sRGB and stores it linearised (ColorManagement default
        // since r152). The shader passes uColor straight to the
        // framebuffer (potree-core's RawShaderMaterial bypasses
        // three.js's outputColorSpace conversion), so we have to put
        // sRGB-encoded values in the uniform ourselves —
        // convertLinearToSRGB() takes the linear THREE.Color and
        // applies the linear→sRGB encode so the bytes written by the
        // shader display as the swatch the user picked.
        m.color = new THREE.Color(singleColor ?? '#a1a1aa').convertLinearToSRGB();
        break;
      default: m.pointColorType = PointColorType.RGB;
    }

    // Gradient texture for height / intensity_gradient modes. sampleColormap
    // returns sRGB display values directly — exactly what we want the
    // shader to output. We feed those values into THREE.Color via the
    // setRGB(...) overload WITHOUT a colorSpace argument, so THREE
    // treats them as linear and stores them unchanged. The shader then
    // passes the stop bytes straight to the framebuffer (RawShaderMaterial
    // bypasses the renderer's outputColorSpace conversion), so the
    // colormap on screen exactly matches what the colourbar overlay
    // shows from the same sampleColormap call.
    if (colorMode === 'height' || colorMode === 'intensity' || scalarActive) {
      // Categorical scalar (e.g. ground_class): build a STEP gradient so each
      // class renders as a flat distinct colour rather than a position along a
      // continuous ramp. Reuses the same INTENSITY_GRADIENT pipeline — only the
      // stop array differs — so no shader change. The intensityRange set above
      // (the attribute's [min,max]) is the value space the stops map against.
      // Resolve the scheme from the RAW attribute range (it picks the class
      // LIST — e.g. how many tree-instance classes exist), but lay the bands out
      // against `effectiveRange` (the shader's actual t-mapping). They differ
      // only for a constant column, where effectiveRange is widened to avoid a
      // zero divisor; using it here keeps the sampled t inside the right band.
      // While the labelling overlay is active it OWNS the intensity slot and
      // writes dense palette indices, so the gradient must be built from the
      // palette's index scheme over [0, n-1] — not from the octree attribute's
      // own range, which describes the (stale) committed column.
      const labelScheme = labelIndexScheme ?? null;
      const bandRange = labelScheme
        ? [0, Math.max(0, labelScheme.classes.length - 1)] as [number, number]
        : effectiveRange ?? (scalarRange ? [scalarRange.min[0], scalarRange.max[0]] : null);
      const categorical = labelScheme ?? (scalarActive && scalarRange
        ? categoricalSchemeForRange(selectedScalarField, [scalarRange.min[0], scalarRange.max[0]])
        : null);
      if (categorical && bandRange) {
        const stops = buildCategoricalGradientStops(categorical, [bandRange[0], bandRange[1]]);
        (m as any).gradient = stops.map(([t, [r, g, b]]) => [t, new THREE.Color(r, g, b)]);
      } else {
        const stopCount = 32;
        const gradient: Array<[number, THREE.Color]> = [];
        for (let i = 0; i < stopCount; i++) {
          const t = i / (stopCount - 1);
          const [r, g, b] = sampleColormap(colormap, t);
          gradient.push([t, new THREE.Color(r, g, b)]);
        }
        (m as any).gradient = gradient;
      }
    }

    // Scalar mode: alias the selected attribute's buffer into `intensity` on
    // every already-loaded tile. Tiles that arrive later get swapped in the
    // per-frame loop below. (selectedScalarField is in the re-mount key, so
    // changing fields gives a fresh material + a fresh pass here.)
    if (scalarActive && selectedScalarField) {
      applyScalarSwapToVisibleNodes(octree, selectedScalarField);
    }

    // Force shader source rebuild (newFormat is a plain field with no
    // setter that calls updateShaderSource for us).
    if (typeof (m as any).updateShaderSource === 'function') {
      (m as any).updateShaderSource();
    }
    m.needsUpdate = true;

    // E2E seam: what the material was ACTUALLY configured with. Published here,
    // from inside the material effect, rather than by the parent — a seam that
    // echoes the parent's intent is self-confirming and cannot detect the very
    // bug it exists for (labels written into the intensity slot while the
    // shader is in an RGB mode that never samples it).
    if (data.octree?.cacheId) {
      ((globalThis as any).__octreeRenderMode ??= {})[data.octree.cacheId] = {
        colorMode,
        pointColorType: (m as any).pointColorType,
        scalarField: scalarActive ? (selectedScalarField ?? null) : null,
      };
    }

    setMaterialVersion(v => v + 1);
  }, [octree, pointSize, colorMode, selectedScalarField, singleColor, colormap, rangeMin, rangeMax, labelIndexScheme]);

  // ── Clip arbitration ──────────────────────────────────────────────────────
  //
  // ONE effect owns the material's clip state. This is not tidiness: the
  // material has exactly ONE `clipMode` uniform, and its volume lists combine
  // as (boxes ∪ spheres) ∩ planes. Two independent effects writing `clipMode`
  // can only ever race, and each has to defensively guess what the other is
  // doing (the old erase effect literally checked `!clipBox` before clearing).
  //
  // So the props are resolved into a single discriminated `clipState` here, and
  // the effect below is the only place that calls setClipBoxes / writes
  // clipMode. Adding a new clip volume kind (e.g. a cross-section slab on clip
  // PLANES) means adding a variant here — a type error if you forget a case —
  // rather than bolting on a fourth effect that fights the other three.
  //
  // Precedence: crop box wins over the erase/delete union. They belong to
  // different edit modes and never legitimately coexist, but a stale prop
  // during a mode switch must resolve deterministically rather than by
  // whichever effect happened to run last.
  type ClipState =
    | { mode: 'none' }
    | { mode: 'crop-box'; boxes: any[]; invert: boolean }
    | { mode: 'delete-union'; boxes: any[] }
    | { mode: 'slab'; planes: THREE.Plane[] };

  // Identity key for the oriented-box union, so the effect re-runs only when
  // the boxes actually move (matrices are new objects every parent render).
  const clipBoxesKey = (clipBoxes ?? [])
    .map(b => b.matrix.elements.map(e => e.toFixed(4)).join(','))
    .join('|');
  // Same idea for the slab: planes are new objects each render, so key on value.
  const slabPlanesKey = (slabPlanes ?? [])
    .map(p => `${p.normal.x.toFixed(6)},${p.normal.y.toFixed(6)},${p.normal.z.toFixed(6)},${p.constant.toFixed(6)}`)
    .join('|');

  const clipState = useMemo<ClipState>(() => {
    if (slabPlanes && slabPlanes.length > 0) {
      // Planes AND-intersect in the shader, which is exactly a slab, and they
      // can only ever CLEAR `insideAny` — so under CLIP_OUTSIDE with no volumes
      // present the planes alone decide and out-of-slab points are culled.
      //
      // The planes are world-space but the cloud renders at world − displayOffset,
      // so translate each plane into the display frame (a plane shifts by
      // subtracting normal·offset from its constant). Same round trip the crop
      // box does above.
      const dx = displayOffset?.x ?? 0;
      const dy = displayOffset?.y ?? 0;
      const dz = displayOffset?.z ?? 0;
      const planes = slabPlanes.map((pl) => {
        const p = pl.clone();
        p.constant += p.normal.x * dx + p.normal.y * dy + p.normal.z * dz;
        return p;
      });
      return { mode: 'slab', planes };
    }
    if (clipBox) {
      // `createClipBox(size, position)` takes a SIZE vector (not min/max) and a
      // CENTER; the box renders as a unit cube transformed by (scale=size,
      // translate=position). Converting here keeps the prop API symmetric with
      // the rest of the codebase's crop-box state.
      const size = new THREE.Vector3(
        clipBox.max.x - clipBox.min.x,
        clipBox.max.y - clipBox.min.y,
        clipBox.max.z - clipBox.min.z,
      );
      // clipBox is in WORLD coords, but the octree renders at world − displayOffset
      // (its pco.position carries −offset). potree clip volumes are world-space, so
      // shift the box center into the same display frame the cloud renders in.
      const center = new THREE.Vector3(
        (clipBox.min.x + clipBox.max.x) / 2 - (displayOffset?.x ?? 0),
        (clipBox.min.y + clipBox.max.y) / 2 - (displayOffset?.y ?? 0),
        (clipBox.min.z + clipBox.max.z) / 2 - (displayOffset?.z ?? 0),
      );
      return {
        mode: 'crop-box',
        boxes: [createClipBox(size, center)],
        invert: !!clipBox.invert,
      };
    }
    if (clipBoxes && clipBoxes.length > 0) {
      // Erase-brush / committed-delete preview: camera-aligned, view-extruded
      // boxes. The shader maps a world point into each box's unit cube via the
      // box's INVERSE matrix, so derive it here and keep potree-core's IClipBox
      // shape out of the parent. Only `inverse.elements` is read by
      // setClipBoxes; the rest is bookkeeping.
      const boxes = (clipBoxes ?? []).map(b => {
        const matrix = b.matrix.clone();
        const inverse = matrix.clone().invert();
        const position = new THREE.Vector3().setFromMatrixPosition(matrix);
        return {
          box: new THREE.Box3(
            new THREE.Vector3(-0.5, -0.5, -0.5), new THREE.Vector3(0.5, 0.5, 0.5),
          ),
          inverse, matrix, position,
        };
      });
      return { mode: 'delete-union', boxes };
    }
    return { mode: 'none' };
    // clipBoxesKey stands in for the clipBoxes array identity; the individual
    // clipBox scalars are listed so a gizmo drag re-derives the volume.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [clipBox?.min.x, clipBox?.min.y, clipBox?.min.z,
      clipBox?.max.x, clipBox?.max.y, clipBox?.max.z, clipBox?.invert,
      clipBoxesKey, slabPlanesKey,
      displayOffset?.x, displayOffset?.y, displayOffset?.z]);

  useEffect(() => {
    if (!octree) return;
    const m = octree.material as any;
    if (clipState.mode === 'none') {
      // Only clear when there's actually something to clear. Calling
      // setClipBoxes([]) on a material that already has zero clip boxes
      // unconditionally triggers updateShaderSource() (the `t` flag in its body
      // fires when going 0↔non-zero), which thrashes the shader cache for no
      // reason and can leave per-tile draw calls binding a freshly-recompiling
      // program that hasn't finished — symptom: the cloud disappears entirely.
      if (m.numClipBoxes > 0 || m.clipMode !== ClipMode.DISABLED) {
        m.setClipBoxes([]);
        m.clipMode = ClipMode.DISABLED;
      }
      if (m.clippingPlanes?.length) m.clippingPlanes = [];
      return;
    }
    if (clipState.mode === 'slab') {
      // potree has no public setClipPlanes: its material reads the INHERITED
      // three.js `clippingPlanes` property in syncClippingPlanes(), which
      // updateMaterial() calls every frame — so assigning it is enough, and the
      // shader define flips on as soon as the count goes non-zero.
      //
      // Any box volume must be cleared: boxes OR into `insideAny`, so leaving a
      // stale one would REVEAL points outside the slab rather than hide them.
      if (m.numClipBoxes > 0) m.setClipBoxes([]);
      m.clippingPlanes = clipState.planes;
      // CLIP_OUTSIDE with no volumes present: `hasVolumeClip` is false, so
      // `insideAny` starts true and the planes alone decide. Points failing any
      // plane are culled — exactly a slab.
      m.clipMode = ClipMode.CLIP_OUTSIDE;
      return;
    }
    // Leaving slab mode: drop the planes or they keep culling.
    if (m.clippingPlanes?.length) m.clippingPlanes = [];
    m.setClipBoxes(clipState.boxes);
    // crop-box: CLIP_OUTSIDE keeps what's inside the box; `invert` flips it to
    // "discard what's inside", matching the Crop tool's Keep-Outside checkbox.
    // delete-union: always CLIP_INSIDE — a point inside ANY painted box is
    // culled (the shader ORs the volumes).
    m.clipMode = clipState.mode === 'crop-box'
      ? (clipState.invert ? ClipMode.CLIP_INSIDE : ClipMode.CLIP_OUTSIDE)
      : ClipMode.CLIP_INSIDE;
    // materialVersion: the material is recreated on colour/size changes, so the
    // clip state has to be re-applied to the new one.
  }, [octree, materialVersion, clipState]);

  // Exact per-point preview for a screen-space crop region. Masks the tiles
  // that are already loaded; tiles that stream in afterwards are caught by the
  // per-frame afterUpdate below (same pattern as the scalar→intensity swap).
  // Keyed on cropMask.key so redrawing the polygon re-masks and clearing it
  // restores full density. The cleanup runs on unmount and on every key change,
  // which is what un-hides points when the region changes rather than leaving
  // an earlier polygon's mask behind.
  const cropMaskKey = cropMask ? `${cropMask.key}|${cropMask.invert}` : '';
  useEffect(() => {
    if (!octree) return;
    if (!cropMask) {
      clearCropMaskFromVisibleNodes(octree);
      return;
    }
    applyCropMaskToVisibleNodes(
      octree, displayOffset, cropMask.predicate, cropMask.invert, cropMaskKey,
    );
    return () => clearCropMaskFromVisibleNodes(octree);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [octree, cropMaskKey, displayOffset?.x, displayOffset?.y, displayOffset?.z]);

  // Cap the octree LOD level while a crop box is previewing so potree spreads
  // the (reduced) budget across a shallower, cheaper, more even part of the tree
  // instead of deeply refining a few high-priority nodes and leaving others
  // coarse. Density still varies with the view (potree streams by camera
  // distance) — the accepted tradeoff for a responsive preview; the applied crop
  // re-renders at full resolution. `cropPreviewActive` is a stable boolean so
  // this fires only on enter/exit, not on every box move. Restored to unlimited
  // (Infinity) when the box clears.
  // Deliberately keyed on `clipBox` ALONE, not on `cropMask`. The cap pays for
  // itself when the BOX gizmo is dragging: the volume changes every frame, so
  // potree is re-deciding visibility continuously and a shallower tree keeps
  // that responsive. A screen-space region is closed and frozen — it re-masks
  // once, not per frame — so the cap buys nothing there and costs a lot: it
  // dropped this cloud from 42 loaded tiles to 3 (722k points to 143k), which
  // reads as the crop having eaten ~80% of the cloud that it never touched.
  // The masking work is bounded by the point budget regardless of depth.
  // Keyed on `clipBox` ONLY — deliberately not on the slab.
  //
  // A crop preview trades detail for responsiveness while a gizmo drags. A
  // cross-section must NOT: the entire argument for the workflow (and what
  // ArcGIS does) is that the slab already bounds the point count, so the
  // section renders at full resolution. Implementing the slab as a clip BOX
  // would have silently inherited this cap and rendered every section sparse.
  const cropPreviewActive = !!clipBox;
  useEffect(() => {
    if (!octree) return;
    (octree as any).maxLevel = cropPreviewActive ? CROP_PREVIEW_MAX_LEVEL : Infinity;
  }, [octree, cropPreviewActive]);

  // Per-frame LOD work. The potree update itself is NOT driven here — the point
  // budget and node LRU are global to the shared manager, so one cloud updating
  // alone claims the whole budget and evicts the other clouds' nodes (see
  // potreeManager). Instead we register this octree's skip test and its
  // post-update sync with the registry, and a single useFrame in the viewer
  // updates every registered cloud in one call.
  //
  // The hooks close over props that change on most renders (clipBox, colorMode,
  // …), so they read through a ref — the registration itself stays keyed on the
  // octree alone and doesn't churn every render.
  // Tracks whether the overlay was active last frame, so it is torn down
  // exactly once when the tool closes rather than every frame after.
  const labelOverlayWasActiveRef = useRef(false);
  const frameStateRef = useRef({
    clipBox, translation, data, colorMode, selectedScalarField, onFirstTilesReady,
    cropMask, cropMaskKey, displayOffset, labelCommittedSlug, labelOverlayRef,
  });
  frameStateRef.current = {
    clipBox, translation, data, colorMode, selectedScalarField, onFirstTilesReady,
    cropMask, cropMaskKey, displayOffset, labelCommittedSlug, labelOverlayRef,
  };

  useEffect(() => {
    if (!octree) return;
    return registerOctreeForFrame({
      octree,
      // When the crop clip box makes this cloud empty (it left the points, or a
      // keep-outside box swallowed them), skip potree's LOD update — an under-
      // filled point budget otherwise makes it stream the whole region (ultra-lag
      // on large clouds). Hide the cloud while empty; restore on the next frame
      // the box overlaps again.
      shouldSkip: () => {
        const { clipBox: cb, data: d, translation: t } = frameStateRef.current;
        const cropEmpty = !!cb && cropClipsEverything(cb, d.bounds, t ?? { x: 0, y: 0, z: 0 });
        if (cropEmpty !== cropHiddenRef.current) {
          cropHiddenRef.current = cropEmpty;
          const cacheId = d.octree?.cacheId;
          if (cacheId) ((window as any).__octreeCropHidden ??= {})[cacheId] = cropEmpty;
        }
        if (cropEmpty) {
          if (octree.visible) octree.visible = false;
          return true;
        }
        if (!octree.visible) octree.visible = true;
        return false;
      },
      // Keeps per-tile sceneNode.material in sync with the cloud's current
      // material — tiles loaded between material-effect runs get their ref
      // synced here on the next frame.
      afterUpdate: () => {
        const {
          data: d, colorMode: cm, selectedScalarField: field,
          onFirstTilesReady: onReady,
          cropMask: mask, cropMaskKey: maskKey, displayOffset: offset,
        } = frameStateRef.current;
        const cur = octree.material;
        const visible = (octree as any).visibleNodes;
        if (!Array.isArray(visible)) return;
        // Notify the parent the first time geometry is actually present, so it
        // can force the one-shot recompile remount (mount-into-gradient-mode fix).
        if (!firstTilesFiredRef.current && visible.length > 0) {
          firstTilesFiredRef.current = true;
          onReady?.();
        }
        const scalarActive =
          cm === 'scalar' && !!field && !!d.octree?.attributeRanges?.[field];
        // Manual-labelling overlay. Runs BEFORE the scalar swap decision below
        // because while the tool is open the label column OWNS the intensity
        // slot — you cannot paint classes while colouring by reflectance and
        // have any idea what you painted. Tiles already built for this stroke
        // key are skipped, so steady state is a string compare per node.
        // Through frameStateRef: this callback is registered ONCE (deps are
        // [octree]), so a prop read from the closure is frozen at its mount
        // value — labelOverlayRef was null then, and the overlay never ran.
        const overlay = frameStateRef.current.labelOverlayRef?.current ?? null;
        if (overlay) {
          applyLabelOverlayToVisibleNodes(
            octree, offset, overlay, frameStateRef.current.labelCommittedSlug ?? null,
          );
        } else if (labelOverlayWasActiveRef.current) {
          // Tool closed / committed: drop the overlay so the octree's own
          // attribute (or whatever scalar the user picked) colours again.
          clearLabelOverlayFromVisibleNodes(octree);
        }
        labelOverlayWasActiveRef.current = !!overlay;

        for (const node of visible) {
          const sn = (node as any).sceneNode;
          if (sn && sn.material !== cur) sn.material = cur;
          // Re-apply the scalar→intensity buffer swap to tiles that streamed
          // in since the last material effect. Cheap and idempotent (a
          // reference compare short-circuits already-swapped geometries).
          // Suppressed while the label overlay owns the intensity slot.
          if (!overlay && scalarActive && sn?.geometry) {
            swapScalarIntoIntensity(sn.geometry, field!);
          }
        }
        // Mask tiles that streamed in (or were evicted and reloaded) since the
        // crop effect ran — without this they render their cropped-away points
        // as the LOD fills in. Skips any tile already masked under this key, so
        // the steady-state cost is one string compare per visible node.
        if (mask) {
          applyCropMaskToVisibleNodes(
            octree, offset, mask.predicate, mask.invert, maskKey,
          );
        } else {
          // Keep the E2E stats hook truthful while no mask is active, so a test
          // can read a real "nothing hidden" baseline before drawing.
          publishCropMaskStats(octree);
        }
      },
    });
  }, [octree]);

  // Scene attach/detach is handled in the loader effect above. This
  // component returns null because the cloud lives directly on the scene
  // root, not inside a React-managed `<primitive>` element. We still need
  // to render *something* so the component participates in React's tree
  // (useFrame requires a mounted component).
  return null;
}
