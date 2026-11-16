import { describe, expect, it } from 'vitest';
import type { LidarScanResult } from '../utils/backendApi';
import { buildScanCloudData } from './scanCloudData';

// One response buffer holding every array as a view, the way decodeBinaryFrame
// hands a synthetic scan's result over: points, colors and two scalars.
function scanResult(session?: LidarScanResult['session']): { result: LidarScanResult; buffer: ArrayBuffer } {
  const n = 4;
  const buffer = new ArrayBuffer(n * 4 * (3 + 3 + 1 + 1));
  const points = new Float32Array(buffer, 0, n * 3);
  points.set([0, 0, 0, 2, 1, 0, 1, 3, 0, 1, 1, 4]);
  const colors = new Float32Array(buffer, n * 12, n * 3).fill(0.5);
  const intensity = new Float32Array(buffer, n * 24, n);
  intensity.set([0.1, 0.2, 0.3, 0.4]);
  const range = new Float32Array(buffer, n * 28, n);
  range.set([5, 6, 7, 8]);
  return {
    buffer,
    result: { scannerId: 's1', points, colors, scalars: { intensity, range }, numPoints: n, session },
  };
}

// Every typed array reachable from `data`, however deeply nested.
function typedArrays(x: unknown, out: ArrayBufferView[] = [], seen = new Set<unknown>()): ArrayBufferView[] {
  if (x === null || typeof x !== 'object' || seen.has(x)) return out;
  seen.add(x);
  if (ArrayBuffer.isView(x)) { out.push(x); return out; }
  for (const v of Object.values(x)) typedArrays(v, out, seen);
  return out;
}

const SESSION = {
  session_id: 'sess-1',
  cache_id: 'octree-1',
  cache_dir: '/cache/octree-1',
  attributes: [{ name: 'intensity', min: [0.1], max: [0.4] }, { name: 'range', min: [5], max: [8], label: 'Range' }],
} as unknown as LidarScanResult['session'];

describe('buildScanCloudData', () => {
  it('keeps nothing that views the response buffer once the scan has an octree session', () => {
    // A view pins the WHOLE buffer (every scanner's points, colors and scalars).
    const { result, buffer } = scanResult(SESSION);
    const data = buildScanCloudData(result, 'scan', ['range'])!;
    expect(typedArrays(data).filter(a => a.buffer === buffer)).toEqual([]);
    expect(data.positions.length).toBe(0);
    expect(data.colors).toBeUndefined();
    expect(data.intensities).toBeUndefined();
    expect(data.scalarFields).toBeUndefined();
    // ...while the scan stays fully described: count, bounds, and the octree ref
    // the renderer, the Color-by picker and every tool read instead.
    expect(data.pointCount).toBe(4);
    expect(data.bounds.min.toArray()).toEqual([0, 0, 0]);
    expect(data.bounds.max.toArray()).toEqual([2, 3, 4]);
    expect(data.octree).toMatchObject({
      sessionId: 'sess-1', cacheId: 'octree-1',
      attributeRanges: { intensity: { min: [0.1], max: [0.4] }, range: { min: [5], max: [8] } },
      attributeLabels: { range: 'Range' },
    });
  });

  it('keeps the flat arrays when the session has no octree to draw', () => {
    // The backend builds the octree best-effort; without it the flat points are
    // the only renderable copy.
    const { result } = scanResult({ ...SESSION!, cache_id: undefined } as LidarScanResult['session']);
    const data = buildScanCloudData(result, 'scan', ['range'])!;
    expect(data.positions).toBe(result.points);
    expect(data.intensities).toBe(result.scalars.intensity);
  });

  it('keeps the flat arrays for a scan with no session', () => {
    const { result } = scanResult(undefined);
    const data = buildScanCloudData(result, 'scan', ['range'])!;
    expect(data.positions).toBe(result.points);
    expect(data.colors).toBe(result.colors);
    expect(data.scalarFields?.range).toMatchObject({ min: 5, max: 8 });
    expect(data.octree).toBeUndefined();
  });
});
