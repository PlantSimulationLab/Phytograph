import { useRef, useMemo, useEffect } from 'react';
import * as THREE from 'three';
import { ColormapName, sampleColormap } from '../../../lib/colormaps';
import { categoricalSchemeFor, colorForClassValue } from '../../../lib/classification';
import type { PointCloudData, ColorMode, CloudFilters } from '../../../lib/pointCloudTypes';

export interface PointCloudProps {
  // Source point cloud — typed arrays are SHARED with three.js, never
  // copied into a separate position attribute. This is what keeps a
  // 50M-point cloud from blowing the renderer when the user enters crop
  // mode or resizes a crop box.
  data: PointCloudData;
  pointSize?: number;
  colorMode?: ColorMode;
  singleColor?: string;
  selectedScalarField?: string;  // Name of scalar field to color by when colorMode='scalar'
  filters?: CloudFilters;  // Active filters
  colormap?: ColormapName;
  rangeMin?: number;  // Overrides data-derived min for color mapping
  rangeMax?: number;  // Overrides data-derived max for color mapping
  // Optional Uint32Array of visible-point indices. When provided, three.js
  // draws only the indexed subset; the position/color attributes still
  // cover the full point count and are shared with `data`. The crop
  // preview and erase paths produce this via getDisplayIndices below;
  // passing it instead of a separately-allocated filtered PointCloudData
  // keeps each preview update at ~4 bytes per visible point instead of
  // ~28-36 bytes (positions + colors + intensities).
  indices?: Uint32Array | null;
}

// Point cloud mesh component.
//
// Memory model: the position attribute is built from `data.positions`
// directly (no copy). When filtering is needed (data-range filters or a
// crop/erase index passed via `indices`), we set the geometry's INDEX
// attribute — three.js draws only those points. This keeps preview-time
// allocation to ~4 bytes per visible point (one Uint32 index entry)
// instead of ~28-36 bytes (positions + colors + intensities copy), which
// is the difference between fitting and OOM'ing on a multi-cloud crop
// of a 50M-point scene.
//
// The color attribute is computed in its own useMemo so that resizing
// the crop box (which changes `indices` but not the source cloud or
// colorMode) doesn't recompute it. For 'rgb' we share data.colors; for
// 'single'/'per-scan' we skip the attribute entirely and let
// material.color carry the swatch.
export function PointCloud({
  data,
  pointSize = 2,
  colorMode = 'height',
  singleColor = '#a1a1aa',
  selectedScalarField,
  filters,
  colormap = 'viridis',
  rangeMin,
  rangeMax,
  indices,
}: PointCloudProps) {
  const pointsRef = useRef<THREE.Points>(null);

  // Combine the externally-supplied crop/erase indices with the optional
  // data-range filter into a single Uint32Array (or null when nothing is
  // filtered and we can let three.js draw all points without an index).
  const drawIndices = useMemo<Uint32Array | null>(() => {
    if (!data || data.pointCount === 0) return null;

    const hasFilters = !!filters && (
      filters.x.enabled || filters.y.enabled || filters.z.enabled ||
      filters.intensity?.enabled ||
      Object.values(filters.scalarFields).some(f => f.enabled)
    );

    // No filtering needed — three.js will draw [0, pointCount).
    if (!indices && !hasFilters) return null;

    const passesFilters = (i: number): boolean => {
      if (!hasFilters || !filters) return true;
      const x = data.positions[i * 3];
      const y = data.positions[i * 3 + 1];
      const z = data.positions[i * 3 + 2];
      if (filters.x.enabled && (x < filters.x.min || x > filters.x.max)) return false;
      if (filters.y.enabled && (y < filters.y.min || y > filters.y.max)) return false;
      if (filters.z.enabled && (z < filters.z.min || z > filters.z.max)) return false;
      if (filters.intensity?.enabled && data.intensities) {
        const v = data.intensities[i];
        if (v < filters.intensity.min || v > filters.intensity.max) return false;
      }
      for (const name in filters.scalarFields) {
        const sf = filters.scalarFields[name];
        if (sf.enabled && data.scalarFields?.[name]) {
          const v = data.scalarFields[name].values[i];
          if (v < sf.min || v > sf.max) return false;
        }
      }
      return true;
    };

    if (indices && !hasFilters) return indices;

    // Fast paths exhausted — build a fresh Uint32Array. Two-pass so the
    // typed array is allocated at the exact size.
    let kept = 0;
    if (indices) {
      for (let k = 0; k < indices.length; k++) {
        if (passesFilters(indices[k])) kept++;
      }
    } else {
      for (let i = 0; i < data.pointCount; i++) {
        if (passesFilters(i)) kept++;
      }
    }
    if (kept === 0) return new Uint32Array(0);
    const out = new Uint32Array(kept);
    let w = 0;
    if (indices) {
      for (let k = 0; k < indices.length; k++) {
        const i = indices[k];
        if (passesFilters(i)) out[w++] = i;
      }
    } else {
      for (let i = 0; i < data.pointCount; i++) {
        if (passesFilters(i)) out[w++] = i;
      }
    }
    return out;
  }, [data, indices, filters]);

  // Per-point colors. Cached on (data, colorMode, ...) ONLY — does not
  // depend on the index buffer. This is why resizing the crop box
  // doesn't reallocate ~hundreds of MB of color data: only the index
  // attribute changes, three.js indexes into the same color buffer.
  const colorAttr = useMemo<THREE.BufferAttribute | null>(() => {
    if (!data || data.pointCount === 0) return null;
    if (colorMode === 'single') {
      // material.color carries the swatch; no per-vertex color attribute.
      return null;
    }
    if (colorMode === 'rgb' && data.colors && data.colors.length >= data.pointCount * 3) {
      // Share the cloud's own colors with three.js — no copy.
      return new THREE.BufferAttribute(data.colors, 3);
    }
    const count = data.pointCount;
    const colors = new Float32Array(count * 3);
    if (colorMode === 'intensity' && data.intensities && data.intensities.length >= count) {
      const lo = rangeMin ?? 0;
      const hi = rangeMax ?? 1;
      const span = (hi - lo) || 1;
      for (let i = 0; i < count; i++) {
        const t = (data.intensities[i] - lo) / span;
        const [r, g, b] = sampleColormap(colormap, t);
        colors[i * 3] = r; colors[i * 3 + 1] = g; colors[i * 3 + 2] = b;
      }
    } else if (colorMode === 'scalar' && selectedScalarField && data.scalarFields?.[selectedScalarField]) {
      const field = data.scalarFields[selectedScalarField];
      const scheme = categoricalSchemeFor(selectedScalarField);
      if (scheme) {
        // Categorical attribute (e.g. ground_class): discrete per-class colors.
        for (let i = 0; i < count; i++) {
          const [r, g, b] = colorForClassValue(scheme, field.values[i]);
          colors[i * 3] = r; colors[i * 3 + 1] = g; colors[i * 3 + 2] = b;
        }
      } else {
        const lo = rangeMin ?? field.min;
        const hi = rangeMax ?? field.max;
        const span = (hi - lo) || 1;
        for (let i = 0; i < count; i++) {
          const t = (field.values[i] - lo) / span;
          const [r, g, b] = sampleColormap(colormap, t);
          colors[i * 3] = r; colors[i * 3 + 1] = g; colors[i * 3 + 2] = b;
        }
      }
    } else if (colorMode === 'x' || colorMode === 'y' || colorMode === 'height') {
      const axis = colorMode === 'x' ? 0 : colorMode === 'y' ? 1 : 2;
      const { min, max } = data.bounds;
      const minVal = axis === 0 ? min.x : axis === 1 ? min.y : min.z;
      const maxVal = axis === 0 ? max.x : axis === 1 ? max.y : max.z;
      const lo = rangeMin ?? (isFinite(minVal) ? minVal : 0);
      const hi = rangeMax ?? (isFinite(maxVal) ? maxVal : 1);
      const span = (hi - lo) || 1;
      for (let i = 0; i < count; i++) {
        const v = data.positions[i * 3 + axis];
        const t = (v - lo) / span;
        const [r, g, b] = sampleColormap(colormap, t);
        colors[i * 3] = r; colors[i * 3 + 1] = g; colors[i * 3 + 2] = b;
      }
    } else {
      // Fallback: solid singleColor as a vertex attribute. Only happens
      // when a non-recognized colorMode is passed.
      const c = new THREE.Color(singleColor);
      for (let i = 0; i < count; i++) {
        colors[i * 3] = c.r; colors[i * 3 + 1] = c.g; colors[i * 3 + 2] = c.b;
      }
    }
    return new THREE.BufferAttribute(colors, 3);
  }, [data, colorMode, singleColor, selectedScalarField, colormap, rangeMin, rangeMax]);

  // Recreate the BufferGeometry whenever `data` changes (rare — only on
  // import, apply-crop, apply-erase, etc.). This is the ONLY way to
  // release the previous position GPU buffer: three.js's WebGLAttributes
  // cache uses a WeakMap and never calls gl.deleteBuffer when an
  // attribute is swapped via setAttribute() — only when the owning
  // BufferGeometry's `dispose` event fires.
  //
  // Index and color swaps within the same geometry DO leak their GPU
  // buffers, but those are small (~4 bytes/visible-point for the index,
  // small or none for color in single-color mode) and infrequent enough
  // to be tolerable. Position swaps are the killer: on a ~28M-point
  // scan that's ~336 MB GPU per swap, and the user crashed at 3.7 GB
  // because the apply path was leaking the old position buffer.
  //
  // Inline render-body mutation (rather than useEffect) so three.js
  // sees a fully-populated geometry with a correct boundingSphere on
  // the very first frame — useEffect ordering otherwise leaves the
  // geometry empty when three.js computes the bounding sphere, caching
  // a default (origin, radius=-1) and frustum-culling everything.
  const geometry = useMemo<THREE.BufferGeometry>(() => {
    const geo = new THREE.BufferGeometry();
    if (data && data.pointCount > 0 && data.positions && data.positions.length >= data.pointCount * 3) {
      geo.setAttribute('position', new THREE.BufferAttribute(data.positions, 3));
      geo.computeBoundingSphere();
      geo.computeBoundingBox();
    }
    return geo;
  }, [data]);

  // Dispose the previous geometry. Three.js dispatches a 'dispose' event
  // that WebGLGeometries listens for, which then calls
  // WebGLAttributes.remove() for every attached attribute — that's what
  // actually invokes gl.deleteBuffer to release the GPU memory.
  useEffect(() => () => { geometry.dispose(); }, [geometry]);

  // Color and index attributes are mutated on the persistent geometry
  // when they change. Tracked refs guard against redundant setAttribute
  // calls; sync mutations during render keep three.js from rendering a
  // mismatched intermediate state on the next frame.
  //
  // Re-attach color / index whenever the underlying geometry was
  // replaced too — the new geometry starts empty besides position.
  const setupRef = useRef<{
    geometry: THREE.BufferGeometry | null;
    colorAttr: THREE.BufferAttribute | null;
    indices: Uint32Array | null | undefined;
  }>({ geometry: null, colorAttr: null, indices: undefined });

  if (setupRef.current.geometry !== geometry) {
    // New geometry — clear our refs so the color/index setters below
    // re-attach to it from scratch.
    setupRef.current.geometry = geometry;
    setupRef.current.colorAttr = null;
    setupRef.current.indices = undefined;
  }

  if (setupRef.current.colorAttr !== colorAttr) {
    if (colorAttr) {
      geometry.setAttribute('color', colorAttr);
    } else if (geometry.attributes.color) {
      geometry.deleteAttribute('color');
    }
    setupRef.current.colorAttr = colorAttr;
  }

  if (setupRef.current.indices !== drawIndices) {
    if (drawIndices) {
      geometry.setIndex(new THREE.BufferAttribute(drawIndices, 1));
    } else if (geometry.index) {
      geometry.setIndex(null);
    }
    setupRef.current.indices = drawIndices;
  }

  const material = useMemo(() => {
    return new THREE.PointsMaterial({
      size: pointSize,
      vertexColors: !!colorAttr,
      color: colorAttr ? 0xffffff : new THREE.Color(singleColor),
      sizeAttenuation: false,
    });
  }, [pointSize, colorAttr, singleColor]);

  useEffect(() => () => { material.dispose(); }, [material]);

  if (!data || data.pointCount === 0) return null;
  return <points ref={pointsRef} geometry={geometry} material={material} />;
}
