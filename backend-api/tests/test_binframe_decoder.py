"""The streaming decoder every test uses to read a PHP1+JSON response.

These pin the two shapes that made real tests fail in confusing ways:

1. A whitespace KEEPALIVE BETWEEN two progress markers. `_bin_frame_streaming_
   response` emits 4-space keepalives whenever a build is quiet, so a run that
   takes long enough interleaves them with the markers. Three tests hand-rolled
   a walk that skipped markers only while they were CONTIGUOUS from the start;
   that stops at the first keepalive and leaves `PHP1...` in the buffer, which
   surfaces as a bare "Expecting value: line 1 column 1" naming nothing. It was
   FLAKY in proportion to machine load, which is exactly the hardest kind to
   chase.

2. A worker FAILURE. The 200 status line is already sent by the time a worker
   raises, so the error is reported in band as a terminal marker and the body
   carries no JSON. Skipping past that marker threw away the only description
   of what broke.
"""

import json
import struct

import pytest

from tests.binframe import (
    decode_progress_markers,
    decode_streamed_json,
    decode_streamed_json_with_markers,
)

KEEPALIVE = b"    "


def _marker(**payload) -> bytes:
    body = json.dumps(payload).encode("utf-8")
    return b"PHP1" + struct.pack("<I", len(body)) + body


def test_decodes_json_after_contiguous_markers():
    stream = (_marker(progress=0.5, message="Working")
              + _marker(progress=1.0, message="Done")
              + b'{"ok": true}')
    assert decode_streamed_json(stream) == {"ok": True}


def test_decodes_json_when_a_keepalive_sits_between_markers():
    """The flake. A local copy of this walk stopped at the keepalive."""
    stream = (_marker(progress=0.5, message="Working")
              + KEEPALIVE
              + _marker(progress=1.0, message="Done")
              + b'{"ok": true}')
    assert decode_streamed_json(stream) == {"ok": True}


def test_decodes_json_through_many_interleaved_keepalives():
    stream = (KEEPALIVE
              + _marker(progress=0.1, message="a")
              + KEEPALIVE + KEEPALIVE
              + _marker(progress=0.9, message="b")
              + KEEPALIVE
              + b'{"n": 3}')
    assert decode_streamed_json(stream) == {"n": 3}
    assert decode_progress_markers(stream) == [
        {"progress": 0.1, "message": "a"},
        {"progress": 0.9, "message": "b"},
    ]


def test_markers_variant_returns_both_halves():
    stream = (_marker(progress=0.5, message="Working")
              + KEEPALIVE
              + _marker(progress=1.0, message="Done")
              + b'{"ok": true}')
    result, markers = decode_streamed_json_with_markers(stream)
    assert result == {"ok": True}
    assert markers == [(0.5, "Working"), (1.0, "Done")]


def test_a_worker_failure_surfaces_its_error_not_a_json_syntax_error():
    stream = (_marker(progress=0.5, message="Working")
              + _marker(progress=None, message="", error="PotreeConverter failed (exit 1)"))
    with pytest.raises(AssertionError, match="PotreeConverter failed"):
        decode_streamed_json(stream)


def test_a_cancelled_run_says_so():
    stream = _marker(progress=None, message="Cancelled", cancelled=True)
    with pytest.raises(AssertionError, match="cancelled"):
        decode_streamed_json(stream)


def test_an_empty_body_names_the_last_marker_it_saw():
    stream = _marker(progress=0.5, message="Working")
    with pytest.raises(AssertionError, match="no JSON body"):
        decode_streamed_json(stream)
