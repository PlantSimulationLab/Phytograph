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
import { invalidateTileMask } from './octreeCropMask';

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
// rewritten column is fetched afresh. Bounded by BYTES, not entries: a class
// column on the 45.7 M-point scan is 46 MB, but a float one (height above
// ground, an expression) is 183 MB, and a count bound let a handful of those
// pin over a gigabyte. The newest column is always kept, whatever its size.
const MAX_CACHED_BYTES = 512 * 1024 * 1024;
const cache = new Map<string, { promise: Promise<ArrayLike<number>>; bytes: number }>();

function cacheKey(c: OverlayColumn): string {
  return `${c.sessionId}|${c.slug}|${c.token}`;
}

function byteLength(values: ArrayLike<number>): number {
  return (values as { byteLength?: number }).byteLength ?? values.length * 8;
}

function evictOverBudget(): void {
  let total = 0;
  for (const e of cache.values()) total += e.bytes;
  for (const [key, e] of cache) {
    if (total <= MAX_CACHED_BYTES || cache.size <= 1) break;
    cache.delete(key);
    total -= e.bytes;
  }
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
    return hit.promise;
  }
  const promise = fetchColumn(c.sessionId, c.slug, c.token);
  const entry = { promise, bytes: 0 };
  cache.set(key, entry);
  promise.then((values) => {
    entry.bytes = byteLength(values);
    evictOverBudget();
  }, () => { if (cache.get(key) === entry) cache.delete(key); });
  return promise;
}

/** Forget every cached column: File → New, and tests. */
export function clearOverlayColumnCache(): void {
  cache.clear();
}

// ── Per-tile columns ────────────────────────────────────────────────────────
//
// A column too big to fetch whole (`fetch: "tile"` — five float32 normal
// columns on the 45.7 M-point scan are 915 MB) is fetched for each tile as it
// loads: the tile's rows go to `/column_rows`, and its values come back for
// every such column of that session in one request. Only the loaded tiles'
// rows ever travel, bounded by the point budget rather than the cloud.
//
// Until a tile's values arrive its attribute is NaN-filled, not absent. An
// absent attribute makes a filter clause not apply, so a committed filter or a
// split child's class mask would draw the tile UNFILTERED for a moment; NaN
// fails every range and class test, so the tile's points stay hidden instead.
// On arrival the tile's mask key is dropped so the next pass re-masks it.

/** One session's per-tile columns, as a single request group. */
export interface TileColumnGroup {
  sessionId: string;
  columns: { slug: string; token: string }[];
}

export type FetchColumnRows = (
  sessionId: string, slugs: string[], tokens: string[], rows: Uint32Array,
) => Promise<Float32Array>;

const TILE_TAG = '__phytographTileOverlay_';
const DONE = '_done';
// Requests in flight at once across every cloud. Each tile is one request, a
// view can show hundreds of tiles, and the backend serves them from one
// threadpool shared with every other request.
const MAX_TILE_REQUESTS = 6;
let inFlight = 0;
const queue: (() => void)[] = [];

function schedule<T>(job: () => Promise<T>): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const run = () => {
      inFlight++;
      job().then(resolve, reject).finally(() => {
        inFlight--;
        queue.shift()?.();
      });
    };
    if (inFlight < MAX_TILE_REQUESTS) run();
    else queue.push(run);
  });
}

function groupKey(g: TileColumnGroup): string {
  return `${g.sessionId}|${g.columns.map((c) => `${c.slug}:${c.token}`).join(',')}`;
}

/**
 * Make sure `geometry` has (or is fetching) the group's columns. Returns
 * immediately; `onUnavailable` fires if the session is gone or a column
 * changed (404/409), which the caller answers by rebuilding.
 */
export function requestTileColumns(
  geometry: any, group: TileColumnGroup, fetchRows: FetchColumnRows,
  onUnavailable: (err: unknown) => void,
): void {
  const key = groupKey(group);
  const tag = TILE_TAG + group.sessionId;
  if (geometry[tag] === key) return;
  const lo = geometry?.attributes?.[ROW_LO_ATTRIBUTE];
  const hi = geometry?.attributes?.[ROW_HI_ATTRIBUTE];
  if (!lo || !hi) return;
  geometry[tag] = key;
  delete geometry[tag + DONE];
  const n: number = lo.count;
  for (const c of group.columns) {
    geometry.setAttribute(c.slug, new THREE.BufferAttribute(new Float32Array(n).fill(NaN), 1));
  }
  invalidateTileMask(geometry);
  const rows = new Uint32Array(n);
  const L = lo.array as ArrayLike<number>;
  const H = hi.array as ArrayLike<number>;
  for (let i = 0; i < n; i++) rows[i] = H[i] * 65536 + L[i];
  schedule(() => fetchRows(
    group.sessionId, group.columns.map((c) => c.slug), group.columns.map((c) => c.token), rows,
  )).then((values) => {
    // The tile was evicted, or re-requested for newer tokens, meanwhile.
    if (geometry[tag] !== key || !geometry.attributes) return;
    group.columns.forEach((c, i) => {
      geometry.setAttribute(c.slug, new THREE.BufferAttribute(values.slice(i * n, (i + 1) * n), 1));
    });
    geometry[tag + DONE] = key;
    invalidateTileMask(geometry);
  }, (err) => {
    if (geometry[tag] === key) delete geometry[tag];
    onUnavailable(err);
  });
}

/** `requestTileColumns` over an octree's loaded tiles. */
export function requestTileColumnsForVisibleNodes(
  octree: any, groups: readonly TileColumnGroup[], fetchRows: FetchColumnRows,
  onUnavailable: (err: unknown) => void,
): void {
  if (groups.length === 0) return;
  const visible = octree?.visibleNodes;
  if (!Array.isArray(visible)) return;
  for (const node of visible) {
    const geom = node?.sceneNode?.geometry;
    if (!geom) continue;
    for (const g of groups) requestTileColumns(geom, g, fetchRows, onUnavailable);
  }
}

/** The per-tile columns of an overlay list, one request group per session. */
export function tileColumnGroups(columns: readonly OverlayColumn[]): TileColumnGroup[] {
  const by = new Map<string, TileColumnGroup>();
  for (const c of columns) {
    if (c.fetch !== 'tile') continue;
    const g = by.get(c.sessionId) ?? { sessionId: c.sessionId, columns: [] };
    g.columns.push({ slug: c.slug, token: c.token });
    by.set(c.sessionId, g);
  }
  return [...by.values()];
}

/** Whether every loaded tile has the groups' values (not just placeholders):
 *  when a label commit's hold may stop painting over them. */
export function tileColumnsComplete(octree: any, groups: readonly TileColumnGroup[]): boolean {
  const visible = octree?.visibleNodes;
  if (!Array.isArray(visible)) return false;
  for (const node of visible) {
    const geom = node?.sceneNode?.geometry;
    if (!geom || !geom.attributes?.[ROW_LO_ATTRIBUTE]) continue;
    for (const g of groups) {
      if (geom[TILE_TAG + g.sessionId + DONE] !== groupKey(g)) return false;
    }
  }
  return true;
}
