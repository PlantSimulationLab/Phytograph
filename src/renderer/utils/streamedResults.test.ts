// Large streamed results: the LAD voxel columns and the marker-stream reader.
//
// LAD's result used to be JSON, decoded into ONE string before parsing, so a
// grid past ~0.93 M voxels failed after the whole inversion had finished. It is
// now a PHB1 frame of float64 columns (backend `_lad_cells_frame`), rebuilt into
// the same records here. And both streaming readers re-merged everything after
// the progress markers with every chunk, quadratic in the payload.
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  computeLAD,
  decodeBinaryFrame,
  drainMarkerStream,
  encodeBinaryFrame,
  ladResponseFromFrame,
  type LADRequest,
} from './backendApi';

afterEach(() => { vi.restoreAllMocks(); });

const enc = new TextEncoder();

function marker(obj: Record<string, unknown>): Uint8Array {
  const json = enc.encode(JSON.stringify(obj));
  const out = new Uint8Array(8 + json.length);
  out.set(enc.encode('PHP1'), 0);
  new DataView(out.buffer).setUint32(4, json.length, true);
  out.set(json, 8);
  return out;
}

function readerOf(chunks: Uint8Array[]): ReadableStreamDefaultReader<Uint8Array> {
  return new ReadableStream<Uint8Array>({
    start(c) { for (const ch of chunks) c.enqueue(ch); c.close(); },
  }).getReader();
}

// The backend's frame for three LAD records, as `_lad_cells_frame` lays it out.
// One leading u32 buffer puts the f64 columns at a 4-but-not-8-aligned offset
// some of the time, which the decoder must copy rather than view.
function ladFrame(pad: number): Uint8Array {
  const nan = Number.NaN;
  return encodeBinaryFrame({
    success: true, nx: 3, total_leaf_area: 1.25,
    cell_columns: [
      { name: 'index', kind: 'number' }, { name: 'center', kind: 'vec3' },
      { name: 'lad', kind: 'number' }, { name: 'beam_count', kind: 'number' },
      { name: 'ci_valid', kind: 'bool' }, { name: 'wad', kind: 'number' },
    ],
    cell_count: 3,
  }, [
    { name: 'pad', data: new Uint32Array(pad) },
    { name: 'cells.index', data: new Float64Array([0, 1, 2]) },
    { name: 'cells.center', data: new Float64Array([
      512345.125, 4271234.5, 87.25, 512345.625, 4271234.5, 87.25, 512346.125, 4271234.5, 87.25]) },
    { name: 'cells.lad', data: new Float64Array([0.1234567890123, nan, 2]) },
    { name: 'cells.beam_count', data: new Float64Array([12, nan, 0]) },
    { name: 'cells.ci_valid', data: new Float64Array([1, 0, nan]) },
    { name: 'cells.wad', data: new Float64Array([0.5, 0, 0]) },
    { name: 'cells.wad.present', data: new Uint32Array([1, 0, 1]) },
  ]);
}

const EXPECTED_CELLS = [
  { index: 0, center: [512345.125, 4271234.5, 87.25], lad: 0.1234567890123, beam_count: 12, ci_valid: true, wad: 0.5 },
  { index: 1, center: [512345.625, 4271234.5, 87.25], lad: null, beam_count: null, ci_valid: false },
  { index: 2, center: [512346.125, 4271234.5, 87.25], lad: 2, beam_count: 0, ci_valid: null, wad: 0 },
];

describe('ladResponseFromFrame', () => {
  it.each([0, 1])('rebuilds the JSON records exactly (pad %i)', (pad) => {
    const bytes = ladFrame(pad);
    const res = ladResponseFromFrame(decodeBinaryFrame(bytes.buffer as ArrayBuffer));
    expect(res.cells).toEqual(EXPECTED_CELLS);
    // A field missing from a record stays missing, not undefined-valued.
    expect('wad' in res.cells[1]).toBe(false);
    expect(res.total_leaf_area).toBe(1.25);
    expect(res).not.toHaveProperty('cell_columns');
    expect(res).not.toHaveProperty('cell_count');
  });

  it('computeLAD asks for columns and returns the rebuilt records', async () => {
    const bytes = ladFrame(0);
    const spy = vi.spyOn(global, 'fetch').mockResolvedValue(
      new Response(bytes, { status: 200, headers: { 'Content-Type': 'application/octet-stream' } }));
    const res = await computeLAD({ scans: [], grid: { nx: 3, ny: 1, nz: 1 } } as unknown as LADRequest);
    expect(String(spy.mock.calls[0][0])).toMatch(/\/api\/lad\/compute\?voxel_columns=1$/);
    expect(res.cells).toEqual(EXPECTED_CELLS);
  });
});

describe('drainMarkerStream', () => {
  it('reports markers split across chunks and returns the payload after them', async () => {
    const m1 = marker({ progress: 0.5, message: 'half' });
    const m2 = marker({ progress: 0.9, message: 'nearly' });
    // The payload itself contains "PHP1": once it has begun, nothing is parsed.
    const payload = enc.encode('{"a": "PHP1 is not a marker here"}');
    const whole = new Uint8Array([...enc.encode('    '), ...m1, ...enc.encode('    '), ...m2, ...payload]);
    const cuts = [3, 9, m1.length + 5, m1.length + 13, whole.length - 10];
    const chunks = [0, ...cuts].map((s, i) => whole.subarray(s, [...cuts, whole.length][i]));
    const seen: string[] = [];
    const out = await drainMarkerStream(readerOf(chunks), () => {}, (m) => { seen.push(m.message); });
    expect(seen).toEqual(['half', 'nearly']);
    expect(new TextDecoder().decode(out)).toBe('{"a": "PHP1 is not a marker here"}');
  });

  it('is linear in the payload', async () => {
    // 1500 x 64 KB after one marker. Re-merging the tail per chunk copies
    // ~74 GB here (13 s on an M-series Mac); collecting copies 96 MB once.
    const chunk = new Uint8Array(64 * 1024).fill(0x41);
    const chunks = [marker({ progress: 0, message: 'go' }), ...Array.from({ length: 1500 }, () => chunk)];
    const t0 = performance.now();
    const out = await drainMarkerStream(readerOf(chunks), () => {}, () => {});
    const ms = performance.now() - t0;
    expect(out.length).toBe(1500 * chunk.length);
    expect(ms).toBeLessThan(3000);
  });
});
