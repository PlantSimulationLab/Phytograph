"""The wire-format decoder, fed the way a socket feeds it: in arbitrary chunks."""
import json
import struct

import numpy as np
import pytest

from phytograph import _frames


def _marker(obj) -> bytes:
    body = json.dumps(obj).encode()
    body += b" " * ((-len(body)) % 4)
    return b"PHP1" + struct.pack("<I", len(body)) + body


def _frame(meta, bufs) -> bytes:
    descs, payload = [], b""
    for name, arr, dt in bufs:
        a = np.ascontiguousarray(arr, dtype=np.float32 if dt == "f32" else np.uint32).ravel()
        descs.append({"name": name, "dtype": dt, "length": int(a.size)})
        payload += a.tobytes()
    header = json.dumps({"meta": meta, "buffers": descs}).encode()
    header += b" " * ((-len(header)) % 4)
    return b"PHB1" + struct.pack("<I", len(header)) + header + payload


def _stream():
    return (_marker({"progress": None, "message": "", "run_id": "abc"})
            + b"    " + _marker({"progress": 0.5, "message": "half"}) + b"    "
            + _frame({"n": 3}, [("pos", np.arange(9), "f32"), ("idx", [7, 8, 9], "u32")]))


@pytest.mark.parametrize("chunk", [1, 3, 7, 64, 10_000])
def test_markers_and_frame_survive_any_chunking(chunk):
    body = _stream()
    p = _frames.StreamParser()
    markers = []
    for i in range(0, len(body), chunk):
        markers += p.feed(body[i:i + chunk])
    assert [m.get("run_id") for m in markers] == ["abc", None]
    assert markers[1]["progress"] == 0.5
    meta, bufs = _frames.decode_frame(p.payload())
    assert meta == {"n": 3}
    np.testing.assert_array_equal(bufs["pos"], np.arange(9, dtype=np.float32))
    np.testing.assert_array_equal(bufs["idx"], [7, 8, 9])


def test_json_tail_and_terminal_markers():
    body = _marker({"run_id": "r"}) + b'{"ok": true}'
    markers, payload = _frames.split_stream(body)
    assert not _frames.is_frame(payload) and json.loads(payload) == {"ok": True}
    assert _frames.terminal_marker(markers) is None

    markers, _ = _frames.split_stream(_marker({"run_id": "r"}) + _marker({"error": "boom"}))
    assert _frames.terminal_marker(markers)["error"] == "boom"


def test_whole_body_decodes_like_the_old_test_helper():
    meta, bufs = _frames.decode_frame(_stream())
    assert meta["n"] == 3 and bufs["idx"].dtype == np.uint32
