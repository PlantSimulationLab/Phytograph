"""open3d is imported in the background at startup, and a tool that needs it
before that finishes says "Loading Open3D…" on its progress bar instead of
sitting silently on an unrelated label (a first PLY mesh import used to hang
~14 s on "Reading mesh from disk…" for a 4 k-face file)."""

import re
import struct
import json
from pathlib import Path

import pytest

import open3d_warmup

BACKEND = Path(__file__).resolve().parent.parent


class _Recorder:
    """Stands in for main._ProgressReporter: records calls and tracks `last`."""

    def __init__(self, last=None):
        self.calls = []
        self.last = last

    def __call__(self, fraction, message):
        self.calls.append((fraction, message))
        self.last = (fraction, message)


@pytest.fixture
def not_ready(monkeypatch):
    """Pretend open3d has not finished loading. (It is cheap to 'load' again
    here: the real module is already in sys.modules.)"""
    import threading
    monkeypatch.setattr(open3d_warmup, "_ready", threading.Event())
    yield


def test_get_open3d_returns_the_module():
    import open3d
    assert open3d_warmup.get_open3d() is open3d
    assert open3d_warmup.is_ready()


def test_waiting_tool_is_told_then_its_label_restored(not_ready):
    rec = _Recorder(last=(0.4, "Estimating normals"))
    with open3d_warmup.reporting_to(rec):
        open3d_warmup.get_open3d()
    # The bar holds at the tool's fraction (never snaps back to 0) and the
    # tool's own message comes back once the load finishes.
    assert rec.calls == [
        (0.4, open3d_warmup.LOADING_MESSAGE),
        (0.4, "Estimating normals"),
    ]
    assert open3d_warmup.is_ready()


def test_no_report_once_loaded():
    open3d_warmup.get_open3d()
    rec = _Recorder()
    with open3d_warmup.reporting_to(rec):
        open3d_warmup.get_open3d()
    assert rec.calls == []


def test_no_reporter_outside_a_streaming_tool(not_ready):
    # A plain call (no reporting_to) just imports.
    assert open3d_warmup.get_open3d() is not None


def test_warmup_can_be_disabled(monkeypatch, not_ready):
    monkeypatch.setattr(open3d_warmup, "_started", False)
    monkeypatch.setenv("PHYTOGRAPH_OPEN3D_WARMUP", "0")
    assert open3d_warmup.start_background_warmup() is False


def test_warmup_starts_once_and_marks_ready(monkeypatch, not_ready):
    monkeypatch.setattr(open3d_warmup, "_started", False)
    monkeypatch.delenv("PHYTOGRAPH_OPEN3D_WARMUP", raising=False)
    assert open3d_warmup.start_background_warmup() is True
    assert open3d_warmup.start_background_warmup() is False
    assert open3d_warmup._ready.wait(60)


def _progress_messages(content: bytes):
    out, i = [], 0
    while True:
        while i < len(content) and content[i] in (0x20, 0x09, 0x0A, 0x0D):
            i += 1
        if content[i:i + 4] != b"PHP1":
            return out
        n = struct.unpack_from("<I", content, i + 4)[0]
        out.append(json.loads(content[i + 8:i + 8 + n])["message"])
        i += 8 + n


def test_ply_mesh_import_streams_the_loading_notice(client, tmp_path, not_ready):
    ply = tmp_path / "tri.ply"
    ply.write_text(
        "ply\nformat ascii 1.0\nelement vertex 3\n"
        "property float x\nproperty float y\nproperty float z\n"
        "element face 1\nproperty list uchar int vertex_indices\nend_header\n"
        "0 0 0\n1 0 0\n0 1 0\n3 0 1 2\n"
    )
    resp = client.post("/api/mesh/import", json={"path": str(ply)})
    assert resp.status_code == 200, resp.text
    assert open3d_warmup.LOADING_MESSAGE in _progress_messages(resp.content)

    from tests.binframe import decode_bin_frame
    meta, _ = decode_bin_frame(resp.content)
    assert meta["triangle_count"] == 1


def test_every_open3d_import_goes_through_the_warmup():
    """A bare `import open3d` bypasses the progress notice (and the tool looks
    hung again on a cold start). seg_worker.py is exempt: it runs in its own
    subprocess, which the parent's warm-up cannot reach."""
    exempt = {"open3d_warmup.py", "seg_worker.py"}
    offenders = []
    for path in BACKEND.glob("*.py"):
        if path.name in exempt:
            continue
        for n, line in enumerate(path.read_text().splitlines(), 1):
            if re.match(r"\s*(import open3d\b|from open3d\b)", line):
                offenders.append(f"{path.name}:{n}: {line.strip()}")
    assert offenders == [], "use open3d_warmup.get_open3d():\n" + "\n".join(offenders)


def test_renderer_recognizes_the_loading_message():
    """Panels that show their own phase label (DEM) let this notice through via
    `isOpen3dLoadingMessage`, which matches on a prefix. Rewording the message
    without the prefix would silently hide it there."""
    api = (BACKEND.parent / "src" / "renderer" / "utils" / "backendApi.ts").read_text()
    m = re.search(r"message\.startsWith\('([^']+)'\)", api)
    assert m, "isOpen3dLoadingMessage prefix not found in backendApi.ts"
    assert open3d_warmup.LOADING_MESSAGE.startswith(m.group(1))
