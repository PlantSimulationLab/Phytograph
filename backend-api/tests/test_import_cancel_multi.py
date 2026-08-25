"""Cancelling an import on the endpoint the renderer ACTUALLY uses.

`test_import_cancel.py` covers `/api/cloud/session/create` (singular). Every
path-backed import in the app goes through `/api/cloud/session/create-multi`
instead (`createCloudSessions` in src/renderer/utils/backendApi.ts) — the plural
sibling that builds one session per scan position. That gap hid a real bug:

`_cancel_checkpoint` is duck-typed. It raises only when the object it is handed
exposes a truthy `should_cancel`:

    if progress is not None and getattr(progress, "should_cancel", None) \\
            and progress.should_cancel():

The multi path windowed each sub-import's progress into its slice of the bar
with a bare closure (`def _sub_progress(fraction, message="", ...)`). A plain
function has no `should_cancel`, so the getattr returned None and EVERY
checkpoint inside `_do_create_cloud_session` became a silent no-op — no error,
no log, the work simply ran to completion after the user hit Cancel.

The only thing that still stopped was `_run_potree_converter`, which polls the
`cancel_event` object directly rather than going through the reporter. So a
cancel took effect if and only if it happened to land while the converter was
running. Land it a moment earlier — during the ASCII→LAS normalise or the point
read, which is the common case for a large file — and the import completed and
installed an octree into the cache long after the dialog was dismissed.

Observed in E2E as an intermittent leak: cancel POSTed at ~220 ms, the converter
staging dir appearing 2.3 s LATER, and a fully installed cache entry 15 s after
that.

These tests pin the seam itself (a windowed reporter must forward the cancel
protocol) and the behaviour through the real endpoint.
"""

import threading
import time
from pathlib import Path

import pytest

import main
from tests.binframe import decode_progress_markers, decode_streamed_json

GRID_FORMAT = "x y z"


@pytest.fixture
def grid_xyz(tmp_path, request) -> Path:
    """A 5x5x5 grid (125 points). Offset per test so each derives its own octree
    cache key — octrees are cached by the hash of the derived hits-LAS bytes, so
    a shared grid would hit a previous test's entry and skip the stub."""
    f = tmp_path / "grid.xyz"
    off = (abs(hash(request.node.name)) % 1000) * 1.0
    f.write_text("\n".join(
        f"{off + i*0.1:.4f} {j*0.1:.4f} {k*0.1:.4f}"
        for i in range(5) for j in range(5) for k in range(5)
    ) + "\n")
    return f


@pytest.fixture
def cache_root(tmp_path, monkeypatch) -> Path:
    root = tmp_path / "octree_cache"
    monkeypatch.setenv("PHYTOGRAPH_OCTREE_CACHE_ROOT", str(root))
    return root


def _install_fake_converter(monkeypatch, before_write=None):
    def fake(input_las, out_dir, cancel_event=None, poll=0.2):
        out_dir.mkdir(parents=True, exist_ok=True)
        if before_write is not None:
            before_write(cancel_event)
        (out_dir / "metadata.json").write_text('{"points": 0}')

    monkeypatch.setattr(main, "_run_potree_converter", fake)


# --------------------------------------------------------------------------
# The seam: a windowed reporter must stay cancellable.
# --------------------------------------------------------------------------

class _FakeReporter:
    """Stands in for _ProgressReporter: records calls, reports a cancel state."""

    def __init__(self, cancelled: bool):
        self._cancelled = cancelled
        self.calls = []
        self.bound = None

    def __call__(self, fraction, message=""):
        self.calls.append((fraction, message))

    def should_cancel(self) -> bool:
        return self._cancelled

    def bind_cancel_int(self, cancel_int):
        self.bound = cancel_int


def test_windowed_progress_forwards_cancel_to_checkpoint():
    """The regression itself. `_cancel_checkpoint` must raise through the
    windowing wrapper — this is what a bare closure silently broke."""
    outer = _FakeReporter(cancelled=True)
    windowed = main._WindowedProgress(outer, 0.0, 1.0, "[1/2] ")

    with pytest.raises(main.ScanCancelled):
        main._cancel_checkpoint(windowed)

    assert windowed.should_cancel() is True
    assert windowed.cancelled is True
    with pytest.raises(main.ScanCancelled):
        windowed.raise_if_cancelled()


def test_windowed_progress_does_not_raise_when_not_cancelled():
    outer = _FakeReporter(cancelled=False)
    windowed = main._WindowedProgress(outer, 0.25, 0.75, "")
    main._cancel_checkpoint(windowed)          # must not raise
    windowed.raise_if_cancelled()              # must not raise
    assert windowed.cancelled is False


def test_windowed_progress_maps_fractions_into_its_slice():
    """Behaviour parity with the closure it replaced: the sub-worker's own 0..1
    is mapped into [lo, hi], the prefix is applied, and a None fraction (the
    indeterminate pulse) stays None."""
    outer = _FakeReporter(cancelled=False)
    windowed = main._WindowedProgress(outer, 0.2, 0.6, "[1/2] ")

    windowed(0.0, "a")
    windowed(0.5, "b")
    windowed(1.0, "c")
    windowed(None, "")

    assert outer.calls == [
        (0.2, "[1/2] a"),
        (0.4, "[1/2] b"),
        (0.6, "[1/2] c"),
        (None, "[1/2]"),
    ]


def test_windowed_progress_clamps_out_of_range_fractions():
    outer = _FakeReporter(cancelled=False)
    windowed = main._WindowedProgress(outer, 0.2, 0.6, "")
    windowed(-1.0, "lo")
    windowed(2.0, "hi")
    assert outer.calls == [(0.2, "lo"), (0.6, "hi")]


def test_windowed_progress_tolerates_a_none_outer():
    """`_do_create_multi_cloud_session` is called with progress=None by unit
    tests and direct callers; the wrapper must be inert rather than raising."""
    windowed = main._WindowedProgress(None, 0.0, 1.0, "")
    windowed(0.5, "x")                 # must not raise
    assert windowed.should_cancel() is False
    main._cancel_checkpoint(windowed)  # must not raise


def test_windowed_progress_delegates_bind_cancel_int():
    outer = _FakeReporter(cancelled=False)
    windowed = main._WindowedProgress(outer, 0.0, 1.0, "")
    sentinel = object()
    windowed.bind_cancel_int(sentinel)
    assert outer.bound is sentinel


# --------------------------------------------------------------------------
# The behaviour, through the endpoint the renderer really calls.
# --------------------------------------------------------------------------

def test_create_multi_cancel_lands_at_the_next_checkpoint(
        client, cache_root, grid_xyz, monkeypatch):
    """A cancel must unwind at the next STAGE BOUNDARY, not grind on to the end.

    This is the assertion that actually pins the bug, and getting it right took
    care: `_build_octree_from_las` reads `cancel_event` DIRECTLY (not via the
    reporter) just before spawning the converter, so even with every checkpoint
    disabled the converter still never ran and no octree was installed. Asserting
    on "converter didn't run" therefore passes with the bug fully present — a
    rubber stamp. The backstop hides the defect; it does not undo it.

    What the bug actually changed is HOW FAR the import gets after the user
    cancels. Cancel during the first stage and then compare the streamed stage
    markers:

        broken: … Loading points into memory → Detecting sky/miss points →
                Computing bounds → Writing octree source → Hashing point data
        fixed:  … Loading points into memory → [cancelled]

    Those four extra stages are the whole ASCII→LAS normalise, the miss scan, the
    bounds pass, a full LAS write and a SHA-1 over every byte of the cloud. On the
    1M-point E2E fixture that is several seconds of work the user already asked
    to stop — and it is the window in which the observed leak happened, because
    once the converter does start, only its own poll loop can still stop it.

    So: assert on the stage markers, which is what the user-visible behaviour
    (and the wasted work) actually consists of.
    """
    converter_ran = threading.Event()

    def fake_converter(input_las, out_dir, cancel_event=None, poll=0.2):
        converter_ran.set()
        out_dir.mkdir(parents=True, exist_ok=True)
        (out_dir / "metadata.json").write_text('{"points": 0}')

    monkeypatch.setattr(main, "_run_potree_converter", fake_converter)

    # Cancel from inside the very first heavy stage, the way a fast user click
    # does: the run is registered before any heavy work, so the token exists.
    real_source_to_las = main._source_to_las
    started = threading.Event()

    def cancel_then_normalise(*args, **kwargs):
        started.set()
        with main._CANCEL_REGISTRY_LOCK:
            ids = list(main._CANCEL_REGISTRY)
        assert ids, "create-multi must register a cancel token before heavy work"
        main._cancel_run(ids[-1])
        return real_source_to_las(*args, **kwargs)

    monkeypatch.setattr(main, "_source_to_las", cancel_then_normalise)

    sessions_before = set(main._cloud_sessions)
    res = client.post("/api/cloud/session/create-multi",
                      json={"source_path": str(grid_xyz),
                            "ascii_format": GRID_FORMAT})
    assert res.status_code == 200, res.text
    assert started.is_set(), "the import never reached the normalise stage"

    markers = decode_progress_markers(res.content)
    assert any(m.get("cancelled") for m in markers), (
        f"a cancelled create-multi must end with a terminal cancelled marker; "
        f"got {markers}")

    stages = [m.get("message", "") for m in markers if m.get("message")]

    # THE decisive assertion: none of the stages that follow the first
    # post-cancel checkpoint may run. Each of these is real work on the full
    # cloud, and every one of them executed before the fix.
    ran_after_cancel = [s for s in stages if any(
        marker in s for marker in (
            "Detecting sky/miss points",
            "Computing bounds",
            "Writing octree source",
            "Hashing point data",
        ))]
    assert not ran_after_cancel, (
        "the cancel was ignored at every stage boundary — the import kept "
        f"working through {ran_after_cancel}. Stages seen: {stages}")

    # The converter is covered by the direct-cancel_event backstop, so this is a
    # guard on that backstop rather than the checkpoint fix.
    assert not converter_ran.is_set(), (
        "PotreeConverter ran after the user cancelled")

    # And nothing was published or installed.
    assert set(main._cloud_sessions) == sessions_before
    installed = ([p for p in cache_root.glob("*") if (p / "metadata.json").is_file()]
                 if cache_root.exists() else [])
    assert not installed, f"a cancelled import installed an octree: {installed}"


def test_create_multi_cancel_installs_no_octree_when_it_lands_in_the_converter(
        client, cache_root, grid_xyz, monkeypatch):
    """The other window: the cancel lands while the converter is already running.
    That path always worked (the converter polls `cancel_event` directly), so
    this guards it against regressing alongside the checkpoint fix."""
    reached = threading.Event()
    release = threading.Event()

    def block(cancel_event):
        reached.set()
        release.wait(timeout=10)
        if cancel_event is not None and cancel_event.is_set():
            raise main.ScanCancelled()

    _install_fake_converter(monkeypatch, before_write=block)

    result = {}

    def do_post():
        result["res"] = client.post(
            "/api/cloud/session/create-multi",
            json={"source_path": str(grid_xyz), "ascii_format": GRID_FORMAT})

    t = threading.Thread(target=do_post)
    t.start()
    try:
        assert reached.wait(timeout=15), "import never reached the converter"
        deadline = time.time() + 10
        run_id = None
        while time.time() < deadline and run_id is None:
            with main._CANCEL_REGISTRY_LOCK:
                ids = list(main._CANCEL_REGISTRY)
            run_id = ids[-1] if ids else None
            if run_id is None:
                time.sleep(0.05)
        assert run_id, "create-multi must register a cancel token"
        assert main._cancel_run(run_id) is True
    finally:
        release.set()
        t.join(timeout=30)

    res = result["res"]
    assert res.status_code == 200, res.text
    assert any(m.get("cancelled") for m in decode_progress_markers(res.content))
    installed = ([p for p in cache_root.glob("*") if (p / "metadata.json").is_file()]
                 if cache_root.exists() else [])
    assert not installed, f"a cancelled import installed an octree: {installed}"


def test_create_multi_uncancelled_still_imports(
        client, cache_root, grid_xyz, monkeypatch):
    """Guard the fix against over-reach: with no cancel, create-multi must still
    stream monotonic progress and return a real session."""
    _install_fake_converter(monkeypatch)
    res = client.post("/api/cloud/session/create-multi",
                      json={"source_path": str(grid_xyz),
                            "ascii_format": GRID_FORMAT})
    assert res.status_code == 200, res.text

    markers = decode_progress_markers(res.content)
    assert not any(m.get("cancelled") for m in markers)
    fractions = [m["progress"] for m in markers if m.get("progress") is not None]
    assert fractions == sorted(fractions), f"progress went backwards: {fractions}"

    body = decode_streamed_json(res.content)
    assert body["scan_count"] == 1, body
    session_id = body["scans"][0]["session"]["session_id"]
    assert main._cloud_sessions[session_id].positions.shape[0] == 125
