// Front-end side of the interactive Helios triangulation filter.
//
// The backend triangulates, auto-estimates the Lmax (Otsu separability) and
// returns a BOUNDED mesh — small candidate sets whole, large ones pre-filtered
// to the estimate + capped so the JSON payload stays parseable. It does NOT
// send per-triangle metrics (two float arrays per million triangles would blow
// past V8's ~512 MB string limit). So here we recompute the per-triangle
// max-edge / aspect from the returned geometry once, then apply the Lmax +
// aspect filter as an instant post-processing step.
//
// This reproduces the C++ single-return filter in LiDAR.cpp:
//   drop if  maxEdge > lmax          (any of the 3 edges > Lmax)
//   drop if  aspect  > maxAspect,    aspect = maxEdge / minEdge
// i.e. a triangle is KEPT iff maxEdge <= lmax && aspect <= maxAspectRatio
// (strict > for drops). The multi-return adaptive separation filter is never on
// the triangulation path (only the LAD inversion, which re-triangulates
// server-side), so it isn't replicated here.

import type { MeshData } from './pointCloudTypes';

export type SeparationLabel = 'High' | 'Medium' | 'Low' | 'n/a';

// Auto-estimate returned by the backend (camelCased), shown in the filter panel
// and used to seed the default Lmax.
export interface HeliosFilterEstimate {
  lmax: number | null;        // suggested Lmax (m); null when too little spread
  eta: number;                // separation confidence in [0, 1]
  label: SeparationLabel;     // High (η≥0.7) / Medium (η≥0.5) / Low / n/a
  // Mode-separation ratio: how far the upper edge-length mode sits above the
  // lower one (median upper-class edge / median lower-class edge). eta measures
  // how *cleanly* the two modes separate; this measures how far *apart* they
  // are. A small ratio (~1.5x) with high eta means the cut splits one surface,
  // not bridges. null when there's no threshold.
  sepRatio: number | null;
  sepLabel: SeparationLabel;  // mode separation: High (≥4x) / Medium (≥2x) / Low / n/a
  merged: boolean;            // a scan looks like a merged multi-scan cloud
  mergedMessage: string | null;
}

// Per-Lmax/aspect filter breakdown for the mesh provenance readout.
export interface HeliosFilterCounts {
  candidates: number;
  kept: number;
  droppedLmax: number;
  droppedAspect: number;
}

// Compute per-triangle max-edge length and aspect ratio (maxEdge/minEdge) from
// indexed geometry. Done once when the mesh arrives; the results are cached on
// the mesh (MeshData.triEdgeMax / triAspect) and reused by every filter change.
export function computeHeliosMetrics(
  data: MeshData,
): { triEdgeMax: Float32Array; triAspect: Float32Array } {
  const { vertices, indices, triangleCount } = data;
  const triEdgeMax = new Float32Array(triangleCount);
  const triAspect = new Float32Array(triangleCount);
  for (let t = 0; t < triangleCount; t++) {
    const i0 = indices[t * 3] * 3;
    const i1 = indices[t * 3 + 1] * 3;
    const i2 = indices[t * 3 + 2] * 3;
    const l0 = dist(vertices, i0, i1);
    const l1 = dist(vertices, i1, i2);
    const l2 = dist(vertices, i0, i2);
    const mx = Math.max(l0, l1, l2);
    const mn = Math.min(l0, l1, l2);
    triEdgeMax[t] = mx;
    triAspect[t] = mn > 0 ? mx / mn : 1e9;
  }
  return { triEdgeMax, triAspect };
}

function dist(v: Float32Array, a: number, b: number): number {
  const dx = v[a] - v[b];
  const dy = v[a + 1] - v[b + 1];
  const dz = v[a + 2] - v[b + 2];
  return Math.sqrt(dx * dx + dy * dy + dz * dz);
}

// Whether a mesh carries the per-triangle metrics needed for interactive
// filtering (populated by computeHeliosMetrics on arrival).
export function hasHeliosFilterMetrics(data: MeshData): boolean {
  return !!data.triEdgeMax
    && !!data.triAspect
    && data.triEdgeMax.length === data.triangleCount
    && data.triAspect.length === data.triangleCount;
}

// Count how the Lmax / aspect filter partitions the triangles, for the
// provenance readout. droppedLmax takes priority over droppedAspect, matching
// the C++ attribution order.
export function heliosFilterCounts(
  data: MeshData,
  lmax: number,
  maxAspectRatio: number,
): HeliosFilterCounts {
  const edgeMax = data.triEdgeMax;
  const aspect = data.triAspect;
  const candidates = data.triangleCount;
  if (!edgeMax || !aspect) {
    return { candidates, kept: candidates, droppedLmax: 0, droppedAspect: 0 };
  }
  let kept = 0;
  let droppedLmax = 0;
  let droppedAspect = 0;
  for (let t = 0; t < candidates; t++) {
    if (edgeMax[t] > lmax) droppedLmax++;
    else if (aspect[t] > maxAspectRatio) droppedAspect++;
    else kept++;
  }
  return { candidates, kept, droppedLmax, droppedAspect };
}

// Derive a filtered MeshData by keeping only triangles with
// maxEdge <= lmax && aspect <= maxAspectRatio. The vertices buffer is REUSED
// (positions unchanged — only the index and per-triangle arrays are rebuilt),
// so it's cheap and doesn't re-upload positions on the indexed render path.
// surfaceArea is recomputed from the kept triangles. Returned unchanged when
// the mesh has no metrics.
export function applyHeliosFilter(
  data: MeshData,
  lmax: number,
  maxAspectRatio: number,
): MeshData {
  const edgeMax = data.triEdgeMax;
  const aspect = data.triAspect;
  if (!edgeMax || !aspect || edgeMax.length !== data.triangleCount) {
    return data;
  }

  const srcIdx = data.indices;
  const n = data.triangleCount;

  const keep = new Uint8Array(n);
  let keptCount = 0;
  for (let t = 0; t < n; t++) {
    if (edgeMax[t] <= lmax && aspect[t] <= maxAspectRatio) {
      keep[t] = 1;
      keptCount++;
    }
  }

  const indices = new Uint32Array(keptCount * 3);
  const hasScanIds = !!data.triangleScanIds && data.triangleScanIds.length === n;
  const hasCellIds = !!data.triangleCellIds && data.triangleCellIds.length === n;
  const scanIds = hasScanIds ? new Uint32Array(keptCount) : undefined;
  const cellIds = hasCellIds ? new Uint32Array(keptCount) : undefined;
  const edgeMaxOut = new Float32Array(keptCount);
  const aspectOut = new Float32Array(keptCount);

  const verts = data.vertices;
  let area = 0;
  let w = 0;
  for (let t = 0; t < n; t++) {
    if (!keep[t]) continue;
    const i0 = srcIdx[t * 3];
    const i1 = srcIdx[t * 3 + 1];
    const i2 = srcIdx[t * 3 + 2];
    indices[w * 3] = i0;
    indices[w * 3 + 1] = i1;
    indices[w * 3 + 2] = i2;
    if (scanIds) scanIds[w] = data.triangleScanIds![t];
    if (cellIds) cellIds[w] = data.triangleCellIds![t];
    edgeMaxOut[w] = edgeMax[t];
    aspectOut[w] = aspect[t];

    const ax = verts[i1 * 3] - verts[i0 * 3];
    const ay = verts[i1 * 3 + 1] - verts[i0 * 3 + 1];
    const az = verts[i1 * 3 + 2] - verts[i0 * 3 + 2];
    const bx = verts[i2 * 3] - verts[i0 * 3];
    const by = verts[i2 * 3 + 1] - verts[i0 * 3 + 1];
    const bz = verts[i2 * 3 + 2] - verts[i0 * 3 + 2];
    const cx = ay * bz - az * by;
    const cy = az * bx - ax * bz;
    const cz = ax * by - ay * bx;
    area += 0.5 * Math.sqrt(cx * cx + cy * cy + cz * cz);
    w++;
  }

  return {
    ...data,
    indices,
    triangleCount: keptCount,
    surfaceArea: area,
    triangleScanIds: scanIds,
    triangleCellIds: cellIds,
    triEdgeMax: edgeMaxOut,
    triAspect: aspectOut,
    // Drop vertex normals so the renderer recomputes them over the kept
    // geometry — the unfiltered normals averaged in now-dropped triangles.
    normals: undefined,
  };
}
