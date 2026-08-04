// Decoder for the backend's streaming JSON responses.
//
// Long-running endpoints (point-cloud import, extract-by-column, backfill,
// DEM, …) don't return plain JSON. They stream PHP1 progress markers — which
// also carry the `run_id` the Cancel button targets — and then the JSON result
// as a tail. Playwright's `response.json()` chokes on the leading markers, so a
// spec that wants the result reads `response.body()` and passes it through here.
//
// Marker layout (see `_pack_progress_marker` in backend-api/main.py):
//     'PHP1' | uint32 json_len | JSON (space-padded to a 4-byte multiple)
//
// Mirrors `decode_streamed_json` in backend-api/tests/binframe.py and
// `parseProgressMarkers` in src/renderer/utils/backendApi.ts.
export function stripProgressMarkers(body: Buffer): any {
  let i = 0;
  for (;;) {
    // Skip whitespace keepalives emitted between markers.
    while (i < body.length && (body[i] === 0x20 || body[i] === 0x09
                               || body[i] === 0x0a || body[i] === 0x0d)) {
      i += 1;
    }
    if (body.subarray(i, i + 4).toString('latin1') !== 'PHP1') break;
    const len = body.readUInt32LE(i + 4);
    i += 8 + len;
  }
  return JSON.parse(body.subarray(i).toString('utf8'));
}
