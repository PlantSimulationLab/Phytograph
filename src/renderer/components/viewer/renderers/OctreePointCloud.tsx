import { useEffect, useRef, useState } from 'react';
import { useThree, useFrame } from '@react-three/fiber';
import { PointCloudOctree, PointColorType, PointSizeType, ClipMode, createClipBox } from 'potree-core';
import * as THREE from 'three';
import { ColormapName, sampleColormap } from '../../../lib/colormaps';
import { categoricalSchemeForRange, buildCategoricalGradientStops } from '../../../lib/classification';
import type { PointCloudData } from '../../../lib/pointCloudTypes';
import { getPotreeManager, OctreeRequestManager } from '../potreeManager';

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
  // in practice — crop and erase are different edit modes — so they never fight
  // over `clipMode`. We take the box transform matrix and derive the inverse the
  // shader needs here, keeping potree-core's IClipBox detail out of the parent.
  clipBoxes?: Array<{ matrix: THREE.Matrix4 }> | null;
  // World-space translation for this cloud (the Translate tool / T-modal value).
  // The PointCloudOctree is attached directly to the scene root (not inside the
  // parent's React `<group position>`), so the group transform does NOT reach it
  // — we have to set the offset on the octree object itself. Defaults to origin.
  translation?: { x: number; y: number; z: number };
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
}

// Point a tile geometry's `intensity` attribute at the named scalar
// attribute's buffer so the INTENSITY_GRADIENT shader path colours by it.
// The Potree 2.0 loader decodes every non-builtin octree attribute into a
// named Float32 BufferAttribute (geometry.attributes[field]); aliasing it
// into `intensity` is a zero-copy reference swap. Idempotent — re-running on
// an already-swapped geometry is a no-op (same buffer reference). Returns
// true if the geometry had the field (so callers can detect missing data).
function swapScalarIntoIntensity(geometry: any, field: string): boolean {
  const src = geometry?.attributes?.[field];
  if (!src) return false;
  if (geometry.attributes.intensity !== src) {
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
  translation,
  displayOffset,
  onFirstTilesReady,
  onOctreeReady,
}: OctreePointCloudProps) {
  const [octree, setOctree] = useState<PointCloudOctree | null>(null);
  const firstTilesFiredRef = useRef(false);
  // Ticks every time the material effect recreates the material. The
  // ClipBox effect depends on this so it re-applies the clip volume to
  // the fresh material instance — otherwise toggling color mode while a
  // crop preview is active would drop the ClipBox.
  const [materialVersion, setMaterialVersion] = useState(0);
  const manager = getPotreeManager();
  const { gl, camera, scene } = useThree();

  // Keep the latest onOctreeReady in a ref so the load effect (keyed on
  // cacheId) doesn't re-run when the parent passes a new callback identity.
  const onOctreeReadyRef = useRef(onOctreeReady);
  onOctreeReadyRef.current = onOctreeReady;

  // Latest translation in a ref so the cacheId-keyed loader effect can seed the
  // initial position without taking `translation` as a dependency (which would
  // tear down and reload the whole octree on every drag tick).
  const translationRef = useRef(translation);
  translationRef.current = translation;

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
        // Snapshot the loader's base offset, then seed our translation on top of
        // it before the first frame so the cloud streams in at its translated
        // position (no visible jump). Kept live by the effect below as the user
        // drags the gizmo / types a value.
        basePositionRef.current.copy(pco.position);
        const t = translationRef.current;
        const o = displayOffsetRef.current;
        if (t || o) {
          pco.position.set(
            basePositionRef.current.x + (t?.x ?? 0) - (o?.x ?? 0),
            basePositionRef.current.y + (t?.y ?? 0) - (o?.y ?? 0),
            basePositionRef.current.z + (t?.z ?? 0) - (o?.z ?? 0),
          );
        }
        scene.add(pco);
        pcoForCleanup = pco;
        setOctree(pco);
        onOctreeReadyRef.current?.(pco);
      })
      .catch((err) => {
        console.error(`Octree load failed for ${data.octree?.cacheId}:`, err);
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

  // Keep the octree's world offset in sync with the Translate tool. The cloud is
  // attached to the scene root, so the parent's `<group position>` doesn't reach
  // it — we set the offset on the octree object directly. Runs at frame rate via
  // React state, which is plenty for a gizmo drag.
  useEffect(() => {
    if (!octree) return;
    // Add the Translate offset on top of the loader's base position — never
    // replace it (see basePositionRef).
    const base = basePositionRef.current;
    octree.position.set(
      base.x + (translation?.x ?? 0) - (displayOffset?.x ?? 0),
      base.y + (translation?.y ?? 0) - (displayOffset?.y ?? 0),
      base.z + (translation?.z ?? 0) - (displayOffset?.z ?? 0),
    );
    // E2E hook: expose the live octree's net translation (offset from its base
    // load position) keyed by cacheId. Tests assert on THIS (the three.js object
    // state) rather than React state, because the translate bug was precisely
    // that React state was correct while the rendered object ignored it. Cleaned
    // up on unmount.
    const cacheId = data.octree?.cacheId;
    if (cacheId) {
      const reg = ((window as any).__octreePositions ??= {});
      const off = displayOffset ?? { x: 0, y: 0, z: 0 };
      reg[cacheId] = {
        // Net Translate offset (object position minus loader base AND with the
        // render-only display offset added back, so this still reports purely the
        // Translate-tool contribution regardless of the precision safety net).
        net: {
          x: octree.position.x - base.x + off.x,
          y: octree.position.y - base.y + off.y,
          z: octree.position.z - base.z + off.z,
        },
        // True WORLD position of the octree object (display position + offset), so
        // a test can confirm an untranslated cloud maps to its true world spot
        // rather than corner-slammed to the origin.
        world: {
          x: octree.position.x + off.x,
          y: octree.position.y + off.y,
          z: octree.position.z + off.z,
        },
        // The render-only display offset in effect (0 for small-coord scenes).
        displayOffset: { x: off.x, y: off.y, z: off.z },
      };
    }
  }, [octree, translation?.x, translation?.y, translation?.z, displayOffset?.x, displayOffset?.y, displayOffset?.z, data.octree?.cacheId]);

  // Drop the E2E position hook for this cloud on unmount.
  useEffect(() => {
    const cacheId = data.octree?.cacheId;
    return () => {
      if (cacheId && (window as any).__octreePositions) {
        delete (window as any).__octreePositions[cacheId];
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
    const scalarActive = !!scalarRange;
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
      const bandRange = effectiveRange ?? (scalarRange ? [scalarRange.min[0], scalarRange.max[0]] : null);
      const categorical = scalarActive && scalarRange
        ? categoricalSchemeForRange(selectedScalarField, [scalarRange.min[0], scalarRange.max[0]])
        : null;
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

    setMaterialVersion(v => v + 1);
  }, [octree, pointSize, colorMode, selectedScalarField, singleColor, colormap, rangeMin, rangeMax]);

  // Live crop preview: attach an IClipBox to the cloud's material when a
  // crop region is being drawn. The shader discards points outside the
  // box at GPU level — no tile re-fetch, no JS-side iteration, runs at
  // frame rate even on 100M-point clouds. When `clipBox` is null, clear
  // the clip volume and put the material back into DISABLED clip mode so
  // the cloud renders fully.
  //
  // `createClipBox(size, position)` takes a SIZE vector (not min/max) and
  // a CENTER position; the box is rendered as a unit cube transformed by
  // (scale=size, translate=position). The min/max-to-size+center
  // conversion is done here to keep the prop API symmetric with the rest
  // of the codebase's crop-box state.
  //
  // `invert` flips ClipMode.CLIP_OUTSIDE (keep inside) → CLIP_INSIDE
  // (keep outside) so the preview matches the "remove points inside the
  // box" UX when the user enables invert.
  useEffect(() => {
    if (!octree) return;
    const m = octree.material;
    if (clipBox) {
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
      const box = createClipBox(size, center);
      (m as any).setClipBoxes([box]);
      (m as any).clipMode = clipBox.invert
        ? ClipMode.CLIP_INSIDE
        : ClipMode.CLIP_OUTSIDE;
    } else if ((m as any).numClipBoxes > 0 || (m as any).clipMode !== ClipMode.DISABLED) {
      // Only clear when there's actually a clip volume to clear. Calling
      // setClipBoxes([]) on a material that already has zero clip boxes
      // unconditionally triggers updateShaderSource() (the `t` flag in
      // its body fires when going 0↔non-zero), which thrashes the
      // shader cache for no reason and can leave the per-tile draw
      // calls in a state where they bind a freshly-recompiling program
      // that hasn't finished — symptom: the cloud disappears entirely.
      (m as any).setClipBoxes([]);
      (m as any).clipMode = ClipMode.DISABLED;
    }
  }, [octree, materialVersion, clipBox?.min.x, clipBox?.min.y, clipBox?.min.z,
       clipBox?.max.x, clipBox?.max.y, clipBox?.max.z, clipBox?.invert,
       displayOffset?.x, displayOffset?.y, displayOffset?.z]);

  // Live erase-brush preview. The brush paints camera-aligned, view-extruded
  // boxes (square cross-section); we hand their world→box transforms to the
  // material as clip boxes and set CLIP_INSIDE so any point inside ANY box is
  // culled on the GPU (the shader ORs them). The shader uses each box's inverse
  // matrix to map a world point into the unit cube [-0.5, 0.5]^3, so we derive
  // the inverse from the transform here. When the list is empty, clear and
  // restore DISABLED, with the same "only clear if non-empty" guard the crop
  // box effect uses to avoid thrashing the shader cache.
  const clipBoxesKey = (clipBoxes ?? [])
    .map(b => b.matrix.elements.map(e => e.toFixed(4)).join(','))
    .join('|');
  useEffect(() => {
    if (!octree) return;
    const m = octree.material;
    if (clipBoxes && clipBoxes.length > 0) {
      const boxes = clipBoxes.map(b => {
        const matrix = b.matrix.clone();
        const inverse = matrix.clone().invert();
        const position = new THREE.Vector3().setFromMatrixPosition(matrix);
        // Shape matches potree-core's IClipBox; only `inverse.elements` is read
        // by setClipBoxes, the rest are bookkeeping.
        return { box: new THREE.Box3(
          new THREE.Vector3(-0.5, -0.5, -0.5), new THREE.Vector3(0.5, 0.5, 0.5),
        ), inverse, matrix, position };
      });
      (m as any).setClipBoxes(boxes);
      (m as any).clipMode = ClipMode.CLIP_INSIDE;
    } else if ((m as any).numClipBoxes > 0 && !clipBox) {
      // Don't clobber an active crop clip box; only clear when erase owns the
      // boxes (crop and erase never run together, but be defensive).
      (m as any).setClipBoxes([]);
      (m as any).clipMode = ClipMode.DISABLED;
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [octree, materialVersion, clipBoxesKey]);

  // Per-frame LOD update. Potree decides which nodes to fetch / drop
  // based on the camera's view of the octree's bounding boxes. Also
  // keeps per-tile sceneNode.material in sync with the cloud's current
  // material — tiles loaded between material-effect runs get their
  // ref synced here on the next frame.
  useFrame(() => {
    if (!octree) return;
    manager.updatePointClouds([octree], camera, gl);
    const cur = octree.material;
    const visible = (octree as any).visibleNodes;
    if (Array.isArray(visible)) {
      // Notify the parent the first time geometry is actually present, so it
      // can force the one-shot recompile remount (mount-into-gradient-mode fix).
      if (!firstTilesFiredRef.current && visible.length > 0) {
        firstTilesFiredRef.current = true;
        onFirstTilesReady?.();
      }
      const scalarActive =
        colorMode === 'scalar' && !!selectedScalarField &&
        !!data.octree?.attributeRanges?.[selectedScalarField];
      for (const node of visible) {
        const sn = (node as any).sceneNode;
        if (sn && sn.material !== cur) sn.material = cur;
        // Re-apply the scalar→intensity buffer swap to tiles that streamed
        // in since the last material effect. Cheap and idempotent (a
        // reference compare short-circuits already-swapped geometries).
        if (scalarActive && sn?.geometry) {
          swapScalarIntoIntensity(sn.geometry, selectedScalarField!);
        }
      }
    }
  });

  // Scene attach/detach is handled in the loader effect above. This
  // component returns null because the cloud lives directly on the scene
  // root, not inside a React-managed `<primitive>` element. We still need
  // to render *something* so the component participates in React's tree
  // (useFrame requires a mounted component).
  return null;
}
