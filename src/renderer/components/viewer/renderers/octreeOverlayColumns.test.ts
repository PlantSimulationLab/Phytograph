import { describe, it, expect, beforeEach, vi } from 'vitest';
import * as THREE from 'three';
import {
  applyOverlayColumnsToGeometry, clearOverlayColumnCache, loadOverlayColumn, overlayReadyKey,
  ROW_HI_ATTRIBUTE, ROW_LO_ATTRIBUTE,
} from './octreeOverlayColumns';
import type { OverlayColumn } from '../../../lib/pointCloudTypes';

/** A tile as potree-core decodes it: the row ids arrive as Float32 buffers. */
function tile(rows: number[]): THREE.BufferGeometry {
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(new Float32Array(rows.length * 3), 3));
  g.setAttribute(ROW_LO_ATTRIBUTE, new THREE.BufferAttribute(new Float32Array(rows.map((r) => r & 0xffff)), 1));
  g.setAttribute(ROW_HI_ATTRIBUTE, new THREE.BufferAttribute(new Float32Array(rows.map((r) => r >>> 16)), 1));
  return g;
}

describe('applyOverlayColumnsToGeometry', () => {
  it("writes each point's value from its session row, rows past 65535 included", () => {
    // Morton order: tile points are NOT in row order, and a 45 M-point cloud
    // has rows far past one uint16.
    const rows = [70_000, 3, 0, 65_536, 1];
    const values = new Uint8Array(70_001);
    values[0] = 1; values[1] = 2; values[3] = 2; values[65_536] = 1; values[70_000] = 2;
    const g = tile(rows);
    expect(applyOverlayColumnsToGeometry(g, [{ slug: 'ground_class', token: 't1', values }])).toBe(true);
    expect(Array.from(g.attributes.ground_class.array)).toEqual([2, 2, 1, 1, 2]);
  });

  it('replaces a built attribute of the same name, and skips a column already written', () => {
    const g = tile([0, 1]);
    g.setAttribute('ground_class', new THREE.BufferAttribute(new Float32Array([9, 9]), 1));
    applyOverlayColumnsToGeometry(g, [{ slug: 'ground_class', token: 't1', values: [1, 2] }]);
    const written = g.attributes.ground_class;
    expect(Array.from(written.array)).toEqual([1, 2]);
    applyOverlayColumnsToGeometry(g, [{ slug: 'ground_class', token: 't1', values: [7, 7] }]);
    expect(g.attributes.ground_class).toBe(written);
    // A new token is a rewritten column: written again.
    applyOverlayColumnsToGeometry(g, [{ slug: 'ground_class', token: 't2', values: [2, 1] }]);
    expect(Array.from(g.attributes.ground_class.array)).toEqual([2, 1]);
  });

  it('cannot show anything on a tile without row ids', () => {
    const g = new THREE.BufferGeometry();
    expect(applyOverlayColumnsToGeometry(g, [{ slug: 's', token: 't', values: [1] }])).toBe(false);
    expect(g.attributes.s).toBeUndefined();
  });
});

describe('overlayReadyKey', () => {
  it('changes when a column arrives or is rewritten', () => {
    expect(overlayReadyKey([])).toBe('');
    const a = overlayReadyKey([{ slug: 'g', token: '1', values: [] }]);
    expect(a).not.toBe(overlayReadyKey([{ slug: 'g', token: '2', values: [] }]));
  });
});

describe('loadOverlayColumn', () => {
  beforeEach(() => clearOverlayColumnCache());
  const col = (slug: string, token = 't'): OverlayColumn =>
    ({ slug, token, sessionId: 's1', label: slug, min: 0, max: 1 });

  it('fetches a column once for every cloud that shows it', async () => {
    const fetch = vi.fn(async () => new Uint8Array([1, 2]));
    const [a, b] = await Promise.all([loadOverlayColumn(col('g'), fetch), loadOverlayColumn(col('g'), fetch)]);
    expect(a).toBe(b);
    expect(fetch).toHaveBeenCalledTimes(1);
    await loadOverlayColumn(col('g', 'newer'), fetch);
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it('does not remember a failure', async () => {
    const fetch = vi.fn()
      .mockRejectedValueOnce(Object.assign(new Error('gone'), { status: 404 }))
      .mockResolvedValueOnce(new Uint8Array([1]));
    await expect(loadOverlayColumn(col('g'), fetch)).rejects.toThrow('gone');
    await expect(loadOverlayColumn(col('g'), fetch)).resolves.toEqual(new Uint8Array([1]));
  });

  it('bounds the cache by bytes, keeping the newest column whatever its size', async () => {
    const big = () => new Float32Array(48 * 1024 * 1024);   // 192 MB, a float column at ~48 M points
    const fetch = vi.fn(async () => big());
    for (const slug of ['a', 'b', 'c']) await loadOverlayColumn(col(slug), fetch);
    expect(fetch).toHaveBeenCalledTimes(3);
    await loadOverlayColumn(col('c'), fetch);   // newest: cached
    await loadOverlayColumn(col('b'), fetch);   // still within 512 MB
    expect(fetch).toHaveBeenCalledTimes(3);
    await loadOverlayColumn(col('a'), fetch);   // the oldest, evicted when c landed
    expect(fetch).toHaveBeenCalledTimes(4);
  });
});
