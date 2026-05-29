import { useEffect, useState } from 'react';
import { useThree, useFrame } from '@react-three/fiber';
import { PointCloudOctree, PointColorType, PointSizeType, ClipMode, createClipBox } from 'potree-core';
import * as THREE from 'three';
import { ColormapName, sampleColormap } from '../../../lib/colormaps';
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

export interface OctreePointCloudProps {
  data: PointCloudData;  // must have data.octree set
  pointSize?: number;
  colorMode?: 'rgb' | 'intensity' | 'height' | 'single' | 'scalar';
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
}

export function OctreePointCloud({
  data,
  pointSize = 2,
  colorMode = 'rgb',
  singleColor = '#a1a1aa',
  colormap = 'viridis',
  rangeMin,
  rangeMax,
  clipBox = null,
}: OctreePointCloudProps) {
  const [octree, setOctree] = useState<PointCloudOctree | null>(null);
  // Ticks every time the material effect recreates the material. The
  // ClipBox effect depends on this so it re-applies the clip volume to
  // the fresh material instance — otherwise toggling color mode while a
  // crop preview is active would drop the ClipBox.
  const [materialVersion, setMaterialVersion] = useState(0);
  const manager = getPotreeManager();
  const { gl, camera, scene } = useThree();

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
        scene.add(pco);
        pcoForCleanup = pco;
        setOctree(pco);
      })
      .catch((err) => {
        console.error(`Octree load failed for ${data.octree?.cacheId}:`, err);
      });
    return () => {
      cancelled = true;
      if (pcoForCleanup) {
        scene.remove(pcoForCleanup);
        pcoForCleanup.dispose();
      }
    };
  }, [data.octree?.cacheId, manager, scene]);

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
    if (rangeMin !== undefined && rangeMax !== undefined && rangeMax > rangeMin) {
      // User-overridden range from the Color By panel — use it directly.
      // The backend backs this with the actual intensity (reflectance ×
      // 256) so the user's UI values are in the same units as the
      // gradient sweep.
      (m as any).intensityRange = [rangeMin, rangeMax];
    } else {
      const intensityRange = data.octree?.attributeRanges?.intensity;
      if (intensityRange && intensityRange.min.length > 0 && intensityRange.max.length > 0) {
        const iMin = intensityRange.min[0];
        const iMax = intensityRange.max[0];
        // Guard against a zero-width range (constant intensity) — set
        // [min-1, min+1] so the divisor isn't zero and the cloud renders
        // as the middle of the gradient instead of NaN.
        if (iMax > iMin) {
          (m as any).intensityRange = [iMin, iMax];
        } else {
          (m as any).intensityRange = [iMin - 1, iMin + 1];
        }
      }
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
      case 'single':
      case 'scalar':
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
    if (colorMode === 'height' || colorMode === 'intensity') {
      const stopCount = 32;
      const gradient: Array<[number, THREE.Color]> = [];
      for (let i = 0; i < stopCount; i++) {
        const t = i / (stopCount - 1);
        const [r, g, b] = sampleColormap(colormap, t);
        gradient.push([t, new THREE.Color(r, g, b)]);
      }
      (m as any).gradient = gradient;
    }

    // Force shader source rebuild (newFormat is a plain field with no
    // setter that calls updateShaderSource for us).
    if (typeof (m as any).updateShaderSource === 'function') {
      (m as any).updateShaderSource();
    }
    m.needsUpdate = true;

    setMaterialVersion(v => v + 1);
  }, [octree, pointSize, colorMode, singleColor, colormap, rangeMin, rangeMax]);

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
      const center = new THREE.Vector3(
        (clipBox.min.x + clipBox.max.x) / 2,
        (clipBox.min.y + clipBox.max.y) / 2,
        (clipBox.min.z + clipBox.max.z) / 2,
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
       clipBox?.max.x, clipBox?.max.y, clipBox?.max.z, clipBox?.invert]);

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
      for (const node of visible) {
        const sn = (node as any).sceneNode;
        if (sn && sn.material !== cur) sn.material = cur;
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
