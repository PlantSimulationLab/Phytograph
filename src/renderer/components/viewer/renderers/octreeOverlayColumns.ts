// Columns an octree was built WITHOUT, shown by row lookup.
//
// Every session octree carries each point's session row as two hidden uint16
// attributes (`__row_lo`, `__row_hi`; the backend's `_OCTREE_ROW_ATTRS`). A
// tool that only ADDS a column (ground or wood/leaf segmentation) therefore no
// longer rebuilds the octree to show it: the backend registers the column as
// an overlay and the renderer fetches it once, in session row order, then
// writes each loaded tile's values into a geometry attribute named after the
// column. Everything downstream — the scalar color swap, the filter and crop
// mask, a split child's class mask, the point picker — reads
// `geometry.attributes[slug]` and cannot tell the overlay from a built column.
//
// That is the same trick the label overlay plays (octreeLabelOverlay.ts), with
// a row index in place of re-testing stroke geometry: there is no per-point
// identity in an octree otherwise, since PotreeConverter reorders by Morton
// code.

import * as THREE from 'three';
import type { OverlayColumn } from '../../../lib/pointCloudTypes';

export const ROW_LO_ATTRIBUTE = '__row_lo';
export const ROW_HI_ATTRIBUTE = '__row_hi';

/** A fetched column: its values indexed by session row. */
export interface OverlayColumnValues {
  slug: string;
  token: string;
  values: ArrayLike<number>;
}

const TAG = '__phytographOverlay_';

/**
 * Write each column's values into `geometry` under the column's own name, by
 * looking each point's row up. A column already written under its current
 * token is skipped, so the per-frame call costs a string compare per tile.
 *
 * Returns false when the tile carries no row ids (an octree built before they
 * existed), in which case nothing can be shown and the caller rebuilds.
 */
export function applyOverlayColumnsToGeometry(
  geometry: any, columns: readonly OverlayColumnValues[],
): boolean {
  const lo = geometry?.attributes?.[ROW_LO_ATTRIBUTE];
  const hi = geometry?.attributes?.[ROW_HI_ATTRIBUTE];
  if (!lo || !hi) return false;
  for (const c of columns) {
    if (geometry[TAG + c.slug] === c.token && geometry.attributes[c.slug]) continue;
    const n: number = lo.count;
    const out = new Float32Array(n);
    const L = lo.array as ArrayLike<number>;
    const H = hi.array as ArrayLike<number>;
    const values = c.values;
    for (let i = 0; i < n; i++) {
      const row = H[i] * 65536 + L[i];
      out[i] = row < values.length ? values[row] : NaN;
    }
    // Replaces a BUILT attribute of the same name too: a rerun segmentation
    // writes a column the octree already carries an older copy of.
    geometry.setAttribute(c.slug, new THREE.BufferAttribute(out, 1));
    geometry[TAG + c.slug] = c.token;
  }
  return true;
}

/** `applyOverlayColumnsToGeometry` over an octree's loaded tiles. */
export function applyOverlayColumnsToVisibleNodes(
  octree: any, columns: readonly OverlayColumnValues[],
): void {
  if (columns.length === 0) return;
  const visible = octree?.visibleNodes;
  if (!Array.isArray(visible)) return;
  for (const node of visible) {
    const geom = node?.sceneNode?.geometry;
    if (geom) applyOverlayColumnsToGeometry(geom, columns);
  }
}

/** A stable key for the set of columns that are ready to draw: folded into the
 *  mask key, so tiles masked before a column arrived are masked again. */
export function overlayReadyKey(columns: readonly OverlayColumnValues[]): string {
  return columns.map((c) => `${c.slug}:${c.token}`).join(',');
}

// Fetched columns, shared by every cloud drawn from the same session (a split's
// children look their class up in the PARENT's column). Keyed by token, so a
// rewritten column is fetched afresh; a handful of entries bounds the memory —
// a class column on a 45.7 M-point cloud is 46 MB.
const MAX_CACHED_COLUMNS = 8;
const cache = new Map<string, Promise<ArrayLike<number>>>();

function cacheKey(c: OverlayColumn): string {
  return `${c.sessionId}|${c.slug}|${c.token}`;
}

/** The column's values, fetched once per (session, slug, token). A failed
 *  fetch is not cached, so the next caller retries. */
export function loadOverlayColumn(
  c: OverlayColumn,
  fetchColumn: (sessionId: string, slug: string, token: string) => Promise<ArrayLike<number>>,
): Promise<ArrayLike<number>> {
  const key = cacheKey(c);
  const hit = cache.get(key);
  if (hit) {
    // Most recently used last, so the oldest is the one evicted.
    cache.delete(key);
    cache.set(key, hit);
    return hit;
  }
  const p = fetchColumn(c.sessionId, c.slug, c.token);
  cache.set(key, p);
  p.catch(() => { if (cache.get(key) === p) cache.delete(key); });
  while (cache.size > MAX_CACHED_COLUMNS) {
    const oldest = cache.keys().next().value as string;
    cache.delete(oldest);
  }
  return p;
}

/** Forget every cached column: File → New, and tests. */
export function clearOverlayColumnCache(): void {
  cache.clear();
}
