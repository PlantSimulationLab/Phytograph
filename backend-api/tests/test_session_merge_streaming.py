"""Stitch (POST /api/cloud/session/merge) as a streamed, cancelable, sized job.

Issue #7: a user stitched 13 orchard scans (354.6 M points) on a machine with a
7.6 GB memory budget. The merge was one blocking request under a fixed 5-minute
client deadline; the backend took 9.3 minutes (the output was built in RAM,
estimated 44.3 GiB, so it paged), the client gave up at 5, and the finished
354 M-point session stayed resident with nothing pointing at it. These pin each
part of the fix against the real endpoint:

  - the response streams PHP1 progress (with the run_id a Cancel targets) ahead
    of the JSON, so the client's idle deadline refreshes while work progresses;
  - a cancel, or any failure after the merged session is registered, leaves NO
    session and no store directory behind;
  - `include_misses=False` really drops the sky/miss rows and the `is_miss`
    column, so the stitch is smaller rather than relabeled;
  - a large output is written into a disk-backed session store, chunk by chunk,
    with the same contents an in-RAM merge produces;
  - the cost gate answers 409 before any work, and `acknowledge_cost` runs it;
  - the pre-flight sizes evicted inputs from their spill entries instead of
    paging them back in before the response has sent a byte;
  - a disk too small for the store is refused up front with 507.

PotreeConverter is stubbed (as in test_import_cancel.py): what is under test is
the merge, its stream and its cleanup, not the converter.
"""

import threading
import time
from collections import namedtuple

import numpy as np
import pytest

import main
from tests.binframe import decode_progress_markers, decode_streamed_json


@pytest.fixture
def isolated(tmp_path, monkeypatch):
    """Own octree cache and an empty session registry for each test."""
    monkeypatch.setenv("PHYTOGRAPH_OCTREE_CACHE_ROOT", str(tmp_path / "octrees"))
    monkeypatch.setattr(main, "_cloud_sessions", {})
    return tmp_path


def _install_fake_converter(monkeypatch, before_write=None):
    def fake(input_las, out_dir, cancel_event=None, poll=0.2):
        out_dir.mkdir(parents=True, exist_ok=True)
        if before_write is not None:
            before_write(cancel_event)
        (out_dir / "metadata.json").write_text('{"points": 0}')

    monkeypatch.setattr(main, "_run_potree_converter", fake)


def _cloud(name: str, n: int = 300, offset: float = 0.0, miss_every: int = 0) -> str:
    """Register a session of `n` points; every `miss_every`-th row is a miss."""
    rng = np.random.default_rng(abs(hash(name)) % (2**32))
    positions = rng.random((n, 3)) * 2.0 + offset
    extras = {"reflectance": rng.random(n).astype(np.float32)}
    meta = [{"slug": "reflectance", "label": "Reflectance"}]
    if miss_every:
        is_miss = np.zeros(n, dtype=np.uint8)
        is_miss[::miss_every] = 1
        positions[is_miss == 1] *= 500.0  # a miss is projected far out
        extras[main._MISS_SLUG] = is_miss
        meta.append({"slug": main._MISS_SLUG, "label": "Is Miss"})
    sess = main.CloudSession(
        session_id=f"{name}-{abs(hash(name)) % 10**6}",
        source_path=f"/tmp/{name}.las",
        ascii_format=None,
        column_plan=None,
        positions=positions,
        colors=(rng.random((n, 3)) * 65535).astype(np.uint16),
        intensity=(rng.random(n) * 65535).astype(np.uint16),
        extras=extras,
        extra_dims_meta=meta,
        deleted=np.zeros(n, dtype=bool),
        deleted_history=[],
        octree_cache_id=None,
        created_at=time.time(),
        last_accessed=time.time(),
    )
    with main._cloud_session_lock:
        main._cloud_sessions[sess.session_id] = sess
    return sess.session_id


def _run_id_from_registry(timeout=10.0):
    deadline = time.time() + timeout
    while time.time() < deadline:
        with main._CANCEL_REGISTRY_LOCK:
            ids = list(main._CANCEL_REGISTRY)
        if ids:
            return ids[-1]
        time.sleep(0.05)
    return None


def _store_dirs():
    return set(main._session_spill_root().glob("*.store"))


def test_merge_streams_progress_with_a_run_id_then_the_result(client, isolated, monkeypatch):
    _install_fake_converter(monkeypatch)
    a, b = _cloud("a"), _cloud("b", offset=5.0)

    res = client.post("/api/cloud/session/merge", json={"session_ids": [a, b]})
    assert res.status_code == 200, res.text

    markers = decode_progress_markers(res.content)
    assert any(m.get("run_id") for m in markers), "no run_id: the client could not cancel"
    fractions = [m["progress"] for m in markers if m.get("progress") is not None]
    assert len(fractions) >= 3, f"expected real stage progress, got {fractions}"
    assert fractions == sorted(fractions), f"progress went backwards: {fractions}"
    assert fractions[-1] == pytest.approx(1.0)

    merged = decode_streamed_json(res.content)["merged"]
    sess = main._cloud_sessions[merged["session_id"]]
    assert sess.positions.shape == (600, 3)
    # Real coordinates from both inputs, not a placeholder.
    assert sess.positions[:, 0].min() < 2.0 and sess.positions[:, 0].max() > 5.0


def test_cancel_mid_build_registers_nothing_and_deletes_the_store(client, isolated, monkeypatch):
    # Large enough (by policy) for the store, so the cleanup of a written store
    # directory is exercised too.
    monkeypatch.setenv("PHYTOGRAPH_SESSION_STORE_MIN_POINTS", "1")
    reached, release = threading.Event(), threading.Event()

    def block(cancel_event):
        reached.set()
        release.wait(timeout=10)

    _install_fake_converter(monkeypatch, before_write=block)
    a, b = _cloud("a"), _cloud("b", offset=5.0)
    before_sessions, before_stores = set(main._cloud_sessions), _store_dirs()

    out = {}
    t = threading.Thread(target=lambda: out.setdefault("res", client.post(
        "/api/cloud/session/merge", json={"session_ids": [a, b]})))
    t.start()
    try:
        assert reached.wait(timeout=15), "merge never reached the octree build"
        # By now the merged session exists and owns a store on disk.
        assert len(main._cloud_sessions) == len(before_sessions) + 1
        assert len(_store_dirs()) == len(before_stores) + 1
        run_id = _run_id_from_registry()
        assert run_id and main._cancel_run(run_id)
    finally:
        release.set()
        t.join(timeout=30)

    res = out["res"]
    assert res.status_code == 200, res.text
    assert any(m.get("canceled") for m in decode_progress_markers(res.content))
    assert set(main._cloud_sessions) == before_sessions
    assert _store_dirs() == before_stores


def test_a_failed_octree_build_discards_the_merged_session(client, isolated, monkeypatch):
    def boom(*args, **kwargs):
        raise RuntimeError("converter exploded")

    monkeypatch.setattr(main, "_session_rebuild", boom)
    a, b = _cloud("a"), _cloud("b", offset=5.0)
    before = set(main._cloud_sessions)

    res = client.post("/api/cloud/session/merge", json={"session_ids": [a, b]})
    assert res.status_code == 200, res.text
    errors = [m["error"] for m in decode_progress_markers(res.content) if m.get("error")]
    assert errors and "converter exploded" in errors[-1]
    assert set(main._cloud_sessions) == before


def test_include_misses_false_drops_the_miss_rows_and_column(client, isolated, monkeypatch):
    _install_fake_converter(monkeypatch)
    a = _cloud("a", n=300, miss_every=3)          # 100 misses, 200 hits
    b = _cloud("b", n=300, offset=5.0)            # no is_miss column: all hits

    res = client.post("/api/cloud/session/merge",
                      json={"session_ids": [a, b], "include_misses": False})
    merged = decode_streamed_json(res.content)["merged"]
    sess = main._cloud_sessions[merged["session_id"]]
    assert sess.positions.shape[0] == 500
    assert main._MISS_SLUG not in sess.extras
    assert all(e["slug"] != main._MISS_SLUG for e in sess.extra_dims_meta)
    assert merged["has_misses"] is False and merged["miss_octree_cache_id"] is None
    # The rows that remain are a's HITS: no point from the far-out miss shell.
    assert np.abs(sess.positions).max() < 10.0
    # Columns stay row-aligned with positions.
    assert sess.extras["reflectance"].shape[0] == 500
    np.testing.assert_array_equal(
        sess.extras["reflectance"][:200],
        main._cloud_sessions[a].extras["reflectance"][main._cloud_sessions[a].extras[main._MISS_SLUG] == 0])

    # And the default keeps them, as before.
    res = client.post("/api/cloud/session/merge", json={"session_ids": [a, b]})
    merged = decode_streamed_json(res.content)["merged"]
    sess = main._cloud_sessions[merged["session_id"]]
    assert sess.positions.shape[0] == 600
    assert int(np.count_nonzero(sess.extras[main._MISS_SLUG])) == 100
    assert merged["has_misses"] is True


def test_a_store_backed_merge_holds_the_same_cloud_as_an_in_ram_one(client, isolated, monkeypatch):
    _install_fake_converter(monkeypatch)
    a = _cloud("a", n=500, miss_every=4)
    b = _cloud("b", n=700, offset=5.0)
    # Different shifts, so the per-chunk reshift is exercised on both paths.
    main._cloud_sessions[b].world_shift = np.array([3.0, -1.0, 0.5])
    main._cloud_sessions[a].deleted[::7] = True

    # Force several chunks per input so chunk boundaries are crossed.
    monkeypatch.setattr(main.session_store, "DEFAULT_CHUNK_ROWS", 64)

    def merge():
        res = client.post("/api/cloud/session/merge", json={"session_ids": [a, b]})
        return main._cloud_sessions[decode_streamed_json(res.content)["merged"]["session_id"]]

    in_ram = merge()
    assert in_ram.store is None
    monkeypatch.setenv("PHYTOGRAPH_SESSION_STORE_MIN_POINTS", "1")
    stored = merge()
    assert stored.store is not None
    assert isinstance(stored.positions, np.memmap)

    np.testing.assert_array_equal(np.asarray(stored.positions), in_ram.positions)
    np.testing.assert_array_equal(np.asarray(stored.colors), in_ram.colors)
    np.testing.assert_array_equal(np.asarray(stored.intensity), in_ram.intensity)
    assert set(stored.extras) == set(in_ram.extras)
    for slug in in_ram.extras:
        np.testing.assert_array_equal(np.asarray(stored.extras[slug]), in_ram.extras[slug])
    # a survives 500 - ceil(500/7) rows, b all 700.
    assert in_ram.positions.shape[0] == (500 - len(range(0, 500, 7))) + 700


def test_the_cost_gate_refuses_before_any_work_and_acknowledge_runs_it(client, isolated, monkeypatch):
    _install_fake_converter(monkeypatch)
    monkeypatch.setattr(main, "_COST_WARNING_SECONDS", 0.0)
    a = _cloud("a", miss_every=2)
    b = _cloud("b", offset=5.0)
    before = set(main._cloud_sessions)

    res = client.post("/api/cloud/session/merge", json={"session_ids": [a, b]})
    assert res.status_code == 409
    warning = res.json()["detail"]["cost_warning"]
    assert "Stitching 2 clouds into 600 points" in warning["message"]
    assert warning["misses"] == 150 and "sky/miss" in warning["message"]
    assert set(main._cloud_sessions) == before

    res = client.post("/api/cloud/session/merge",
                      json={"session_ids": [a, b], "acknowledge_cost": True})
    assert res.status_code == 200
    assert decode_streamed_json(res.content)["merged"]["point_count"] is not None
    assert len(main._cloud_sessions) == len(before) + 1


def test_preflight_sizes_a_spilled_input_without_paging_it_in(client, isolated, monkeypatch):
    _install_fake_converter(monkeypatch)
    a = _cloud("a", n=400, miss_every=4)
    b = _cloud("b", n=300, offset=5.0)
    main._cloud_sessions[a].deleted[:40] = True
    main._cloud_sessions[a].last_accessed = time.time() - 3600
    monkeypatch.setattr(main, "_MAX_CLOUD_SESSIONS", 1)
    main._sweep_cloud_sessions()
    assert a in main._spilled_sessions and a not in main._cloud_sessions

    restores = []
    real_restore = main._restore_cloud_session
    monkeypatch.setattr(main, "_restore_cloud_session",
                        lambda sid: restores.append(sid) or real_restore(sid))

    prof_a, prof_b = main._merge_profiles([a, b])
    assert restores == [], "the pre-flight read a spilled session back"
    assert prof_a["survivors"] == 360
    # Misses among the SURVIVORS only: rows 0,4,...,36 were deleted.
    assert prof_a["misses"] == 100 - 10
    assert prof_b["survivors"] == 300 and prof_b["misses"] == 0

    # The merge itself still works: the worker pages it in.
    res = client.post("/api/cloud/session/merge", json={"session_ids": [a, b]})
    merged = decode_streamed_json(res.content)["merged"]
    assert restores == [a]
    assert main._get_cloud_session(merged["session_id"]).positions.shape[0] == 660


def test_a_disk_too_small_for_the_store_is_refused_up_front(client, isolated, monkeypatch):
    monkeypatch.setenv("PHYTOGRAPH_SESSION_STORE_MIN_POINTS", "1")
    usage = namedtuple("usage", "total used free")
    monkeypatch.setattr(main.shutil, "disk_usage", lambda p: usage(10, 9, 1))
    a, b = _cloud("a"), _cloud("b", offset=5.0)
    before = set(main._cloud_sessions)

    res = client.post("/api/cloud/session/merge", json={"session_ids": [a, b]})
    assert res.status_code == 507
    assert "Not enough free disk space to stitch" in res.json()["detail"]
    assert set(main._cloud_sessions) == before


def test_bad_requests_still_get_real_status_codes(client, isolated):
    a = _cloud("a")
    assert client.post("/api/cloud/session/merge",
                       json={"session_ids": [a]}).status_code == 400
    assert client.post("/api/cloud/session/merge",
                       json={"session_ids": [a, "nope"]}).status_code == 404
    b = _cloud("b")
    main._cloud_sessions[a].deleted[:] = True
    main._cloud_sessions[b].deleted[:] = True
    res = client.post("/api/cloud/session/merge", json={"session_ids": [a, b]})
    assert res.status_code == 400 and "no surviving points" in res.json()["detail"]


# ---------------------------------------------------------------------------
# Review follow-ups: memory actually held, cleanup windows, column types.
# ---------------------------------------------------------------------------

def _rich_cloud(name, n, *, offset=0.0, declared=True, with_color=True, with_time=True,
                with_origins=True, miss_every=0):
    """A session carrying every column family, with types that only survive a
    merge if nothing narrows them: a float64 column that needs its precision and
    an int32 column that would fit in uint8."""
    rng = np.random.default_rng(abs(hash(name)) % (2**32))
    precise = np.linspace(0, 1, n) + 1e-12 * np.arange(n)
    extras = {"gps_fine": precise.astype(np.float64),
              "cls": (np.arange(n) % 3).astype(np.int32)}
    meta = [{"slug": "gps_fine", "label": "GPS", **({"dtype": "float64"} if declared else {})},
            {"slug": "cls", "label": "Class"}]
    if miss_every:
        is_miss = np.zeros(n, dtype=np.uint8)
        is_miss[::miss_every] = 1
        extras[main._MISS_SLUG] = is_miss
        meta.append({"slug": main._MISS_SLUG, "label": "Is Miss"})
    sess = main.CloudSession(
        session_id=f"{name}-rich", source_path=f"/tmp/{name}.las", ascii_format=None,
        column_plan=None, positions=rng.random((n, 3)) + offset,
        colors=(rng.random((n, 3)) * 65535).astype(np.uint16) if with_color else None,
        intensity=(rng.random(n) * 65535).astype(np.uint16) if with_color else None,
        extras=extras, extra_dims_meta=meta,
        timestamps=(1e9 + np.arange(n) * 1e-6) if with_time else None,
        beam_origins=rng.random((n, 3)) if with_origins else None,
        deleted=np.zeros(n, dtype=bool), deleted_history=[], octree_cache_id=None,
        created_at=time.time(), last_accessed=time.time())
    with main._cloud_session_lock:
        main._cloud_sessions[sess.session_id] = sess
    return sess


def _merge_direct(ids, **kw):
    return main._cloud_sessions[main._do_session_merge(ids, **kw)["merged"]["session_id"]]


def test_store_and_ram_merges_agree_on_values_types_and_fills(isolated, monkeypatch):
    """`assert_array_equal` alone ignores dtype, which is exactly how a merge
    that narrowed a declared float64 in RAM but not in the store passed. Every
    column family is compared for VALUE AND TYPE, including the fills an input
    lacking the column gets, across chunk boundaries."""
    _install_fake_converter(monkeypatch)
    monkeypatch.setattr(main.session_store, "DEFAULT_CHUNK_ROWS", 37)
    a = _rich_cloud("a", 300, miss_every=5)
    b = _rich_cloud("b", 200, offset=4.0, with_color=False, with_time=False, with_origins=False)
    a.deleted[::9] = True
    b.world_shift = np.array([2.0, -1.0, 0.25])

    ram = _merge_direct([a.session_id, b.session_id])
    assert ram.store is None
    monkeypatch.setenv("PHYTOGRAPH_SESSION_STORE_MIN_POINTS", "1")
    stored = _merge_direct([a.session_id, b.session_id])
    assert stored.store is not None

    def same(x, y, what):
        x, y = np.asarray(x), np.asarray(y)
        assert x.dtype == y.dtype, f"{what}: in-RAM {x.dtype} vs store {y.dtype}"
        np.testing.assert_array_equal(x, y, err_msg=what)

    for field in ("positions", "colors", "intensity", "timestamps", "beam_origins"):
        same(getattr(ram, field), getattr(stored, field), field)
    assert list(ram.extras) == list(stored.extras)
    for slug in ram.extras:
        same(ram.extras[slug], stored.extras[slug], slug)

    na = int((~a.deleted).sum())
    # Fills for the input that lacked the column: white, 0, 0.0.
    assert (np.asarray(stored.colors)[na:] == 65535).all()
    assert (np.asarray(stored.intensity)[na:] == 0).all()
    assert (np.asarray(stored.timestamps)[na:] == 0.0).all()
    assert (np.asarray(stored.beam_origins)[na:] == 0.0).all()
    assert (np.asarray(stored.extras[main._MISS_SLUG])[na:] == 0).all()
    # b's rows were re-expressed into a's frame.
    np.testing.assert_allclose(np.asarray(stored.positions)[na:], b.positions + b.world_shift)


def test_a_declared_float64_column_survives_the_merge_and_the_next_compaction(isolated, monkeypatch):
    """CLAUDE.md: compaction keeps a float64 a source DECLARED. The merge used
    to narrow it itself (in RAM), and dropped the declaration from the merged
    cloud's metadata, so the first bake narrowed it either way."""
    _install_fake_converter(monkeypatch)
    a = _rich_cloud("a", 120)
    b = _rich_cloud("b", 80, offset=4.0)
    merged = _merge_direct([a.session_id, b.session_id])

    col = merged.extras["gps_fine"]
    assert col.dtype == np.float64
    np.testing.assert_array_equal(col[:120], a.extras["gps_fine"])   # bit for bit
    assert main._declared_dtype(merged, "gps_fine") == "float64"
    with main._cloud_session_lock:
        main._session_compact_extras_locked(merged)
    assert merged.extras["gps_fine"].dtype == np.float64

    # Inputs that DISAGREE about the declaration carry none (no honest label).
    c = _rich_cloud("c", 50, declared=False)
    c.extra_dims_meta[0]["dtype"] = "float32"
    mixed = _merge_direct([a.session_id, c.session_id])
    assert main._declared_dtype(mixed, "gps_fine") is None


def test_only_one_input_row_index_exists_at_a_time(isolated, monkeypatch):
    """The first cut held an int64 row index for EVERY input for the whole fill:
    2.8 GB for issue #7's 354.6 M points, against an admission that counted one.
    Inputs with nothing removed need no index at all (a slice), and the others
    are indexed one at a time."""
    _install_fake_converter(monkeypatch)
    untouched = [_rich_cloud(f"u{i}", 100, offset=3.0 * i) for i in range(3)]
    real = np.flatnonzero
    calls = []
    monkeypatch.setattr(main.np, "flatnonzero", lambda a: calls.append(len(a)) or real(a))
    merged = _merge_direct([s.session_id for s in untouched])
    assert merged.positions.shape[0] == 300
    # (The octree build indexes the MERGED cloud, 300 rows; inputs are 100.)
    assert 100 not in calls, "an input with no deleted rows was indexed"

    edited = [_rich_cloud(f"e{i}", 100, offset=3.0 * i) for i in range(3)]
    for s in edited:
        s.deleted[::4] = True
    alive = []
    import weakref

    class _Tracked(np.ndarray):
        pass

    def tracking(a):
        if len(a) != 100:                       # not an input: the octree build
            return real(a)
        out = real(a).view(_Tracked)
        alive.append(weakref.ref(out))
        # Every index made for an earlier input must be gone by now.
        assert sum(r() is not None for r in alive) == 1, "two row indexes alive at once"
        return out

    monkeypatch.setattr(main.np, "flatnonzero", tracking)
    merged = _merge_direct([s.session_id for s in edited])
    assert merged.positions.shape[0] == 225 and len(alive) == 3


def test_admission_covers_what_the_merge_really_holds():
    """For the issue #7 shape: 13 clouds, 354.6 M points, ~37% misses."""
    profiles = [dict(survivors=27_276_907, misses=10_217_000, n_extras=6, colors=True,
                     intensity=True, timestamps=True, origins=False)] * 13
    est = main._merge_estimate(profiles, include_misses=True)
    assert est["points"] == 13 * 27_276_907
    masks = 13 * 27_276_907                 # one byte a row, every input
    one_index = 27_276_907 * 8              # one input's int64 rows
    assert est["merge_ram"] >= masks + one_index
    assert est["merge_ram"] < 2 * (masks + one_index) + 2 * 2_000_000 * 200, (
        "a store-backed merge must not be charged for the whole cloud")
    # The combine step is minutes at the measured rate, not the 12 s first quoted.
    assert "combining ~" in est["breakdown"]
    assert est["points"] / main._RATE_MERGE_PTS_PER_S > 60
    assert est["seconds"] > est["points"] / main._RATE_MERGE_PTS_PER_S


def test_the_merged_session_is_pinned_before_it_is_registered(isolated, monkeypatch):
    """Registered-then-pinned left a gap in which a sweep on another thread
    could spill it (with every input pinned it is the only victim), after which
    its octree was built on an orphaned object."""
    _install_fake_converter(monkeypatch)
    a, b = _cloud("a"), _cloud("b", offset=5.0)
    seen = {}

    class Watching(dict):
        def __setitem__(self, key, value):
            if key not in (a, b):
                seen[key] = key in main._pinned_session_ids()
            super().__setitem__(key, value)

    watched = Watching(main._cloud_sessions)
    monkeypatch.setattr(main, "_cloud_sessions", watched)
    with main._session_pin_scope():
        merged = main._do_session_merge([a, b])["merged"]
    assert seen == {merged["session_id"]: True}


def test_cancel_during_the_copy_leaves_no_session_and_no_store(isolated, monkeypatch):
    """The other cancel test stops inside the converter. This one stops in the
    chunked copy itself, where the cleanup is the fill's own."""
    _install_fake_converter(monkeypatch)
    monkeypatch.setenv("PHYTOGRAPH_SESSION_STORE_MIN_POINTS", "1")
    monkeypatch.setattr(main.session_store, "DEFAULT_CHUNK_ROWS", 16)
    a, b = _cloud("a"), _cloud("b", offset=5.0)
    before_sessions, before_stores = set(main._cloud_sessions), _store_dirs()
    cancel = threading.Event()
    ticks = []

    def progress(fraction, message):
        ticks.append(message)
        if "Combining cloud" in message and len(ticks) > 5:
            assert _store_dirs() != before_stores, "the store should exist mid-copy"
            cancel.set()

    with pytest.raises(main.ScanCanceled):
        main._do_session_merge([a, b], progress=progress, cancel_event=cancel)
    assert set(main._cloud_sessions) == before_sessions
    assert _store_dirs() == before_stores


def test_a_failed_build_deletes_a_store_backed_merge_too(isolated, monkeypatch):
    monkeypatch.setenv("PHYTOGRAPH_SESSION_STORE_MIN_POINTS", "1")
    monkeypatch.setattr(main, "_session_rebuild",
                        lambda *a, **k: (_ for _ in ()).throw(RuntimeError("converter exploded")))
    a, b = _cloud("a"), _cloud("b", offset=5.0)
    before_sessions, before_stores = set(main._cloud_sessions), _store_dirs()
    with pytest.raises(RuntimeError, match="converter exploded"):
        main._do_session_merge([a, b])
    assert set(main._cloud_sessions) == before_sessions
    assert _store_dirs() == before_stores


async def test_a_result_the_client_never_collects_is_discarded(isolated, monkeypatch):
    """The original orphan, in its last remaining window: the work finishes and
    the client is already gone. Closing the response body after the worker is
    done (what Starlette does on a disconnect) must free the merged session."""
    import asyncio
    _install_fake_converter(monkeypatch)
    a, b = _cloud("a"), _cloud("b", offset=5.0)
    before = set(main._cloud_sessions)

    resp = main.session_merge(main.SessionMergeRequest(session_ids=[a, b]), None)
    body = resp.body_iterator
    # Read up to and including the result frame, then stop: the frame was
    # written, but the consumer never came back for more. That is where a
    # generator is left when the client disconnects as the work finishes.
    while True:
        chunk = await body.__anext__()
        if chunk.lstrip().startswith(b"{"):
            break
    assert len(set(main._cloud_sessions) - before) == 1, "the merge never completed"
    await body.aclose()                         # the client went away

    for _ in range(100):
        if set(main._cloud_sessions) == before:
            break
        await asyncio.sleep(0.05)
    assert set(main._cloud_sessions) == before, "an uncollected merge result stayed resident"


async def test_a_collected_result_is_not_discarded(isolated, monkeypatch):
    """The other side of the hook: a normally delivered result must survive."""
    import asyncio
    _install_fake_converter(monkeypatch)
    a, b = _cloud("a"), _cloud("b", offset=5.0)
    before = set(main._cloud_sessions)
    resp = main.session_merge(main.SessionMergeRequest(session_ids=[a, b]), None)
    chunks = [c async for c in resp.body_iterator]
    merged = decode_streamed_json(b"".join(chunks))["merged"]
    await asyncio.sleep(0.5)
    assert set(main._cloud_sessions) - before == {merged["session_id"]}


def test_a_torn_profile_read_cannot_break_a_spill(isolated, monkeypatch):
    """The spill writer sizes the session with the lock released. A claim-back
    plus a bake between its reads gives arrays of different lengths; that raised
    out of the sweep, failed the request that triggered it and stranded the
    session half-spilled."""
    class Torn:
        deleted = np.zeros(100, dtype=bool)
        extras = {main._MISS_SLUG: np.zeros(60, dtype=np.uint8)}
        colors = intensity = timestamps = beam_origins = None
    with pytest.raises(IndexError):
        main._merge_profile(Torn())
    assert main._merge_profile_or_none(Torn()) is None

    a, b = _cloud("a"), _cloud("b", offset=5.0)
    main._cloud_sessions[a].last_accessed = time.time() - 3600
    monkeypatch.setattr(main, "_MAX_CLOUD_SESSIONS", 1)
    monkeypatch.setattr(main, "_merge_profile",
                        lambda s: (_ for _ in ()).throw(IndexError("torn")))
    main._sweep_cloud_sessions()                # must not raise
    assert a in main._spilled_sessions and a not in main._spilling_sessions
    assert main._spilled_sessions[a]["merge_profile"] is None


def test_the_disk_check_counts_temp_files_and_octrees_not_only_the_store(isolated, monkeypatch):
    monkeypatch.setenv("PHYTOGRAPH_SESSION_STORE_MIN_POINTS", "1")
    profiles = [dict(survivors=1_000_000, misses=0, n_extras=2, colors=True, intensity=True,
                     timestamps=False, origins=False)] * 2
    est = main._merge_estimate(profiles, include_misses=True)
    assert est["store_disk"] > 0 and est["temp_disk"] > 0 and est["cache_disk"] > 0
    usage = namedtuple("usage", "total used free")
    everything = est["store_disk"] + est["temp_disk"] + est["cache_disk"]

    # One volume for all three (the common layout).
    monkeypatch.setattr(main, "_volume_id", lambda p: 7)
    # Room for the store alone is not room for the merge.
    monkeypatch.setattr(main.shutil, "disk_usage", lambda p: usage(0, 0, est["store_disk"] + 1))
    msg = main._merge_disk_shortfall(est)
    assert msg and "Not enough free disk space to stitch" in msg
    monkeypatch.setattr(main.shutil, "disk_usage", lambda p: usage(0, 0, everything + 1))
    assert main._merge_disk_shortfall(est) is None


def test_the_miss_octree_of_a_large_merge_is_gathered_onto_disk(isolated, monkeypatch, tmp_path):
    """Kept misses used to be pulled into one RAM array for their octree (3.2 GB
    for issue #7's 133 M), undoing the point of writing the merge to disk."""
    monkeypatch.setenv("PHYTOGRAPH_SESSION_STORE_MIN_POINTS", "1")
    monkeypatch.setattr(main.session_store, "DEFAULT_CHUNK_ROWS", 16)
    sid = _cloud("a", n=200, miss_every=4)
    sess = main._cloud_sessions[sid]
    sess.deleted[:8] = True                     # rows 0 and 4 are deleted misses
    scratch = tmp_path / "scratch"
    scratch.mkdir()

    got, radius = main._gather_miss_positions(sess, None, scratch_dir=scratch)
    assert isinstance(got, np.memmap) and radius == 0.0
    expected = sess.positions[(sess.extras[main._MISS_SLUG] != 0) & ~sess.deleted]
    assert got.shape == (48, 3)
    np.testing.assert_array_equal(np.asarray(got), expected)

    # Small sets, and any projected (origin) gather, still come back in RAM.
    monkeypatch.setenv("PHYTOGRAPH_SESSION_STORE_MIN_POINTS", "100000000")
    in_ram, _ = main._gather_miss_positions(sess, None, scratch_dir=scratch)
    assert not isinstance(in_ram, np.memmap)
    np.testing.assert_array_equal(in_ram, expected)


def test_a_merge_trims_the_octree_cache_when_it_finishes(isolated, monkeypatch):
    _install_fake_converter(monkeypatch)
    a, b = _cloud("a"), _cloud("b", offset=5.0)
    trims = []
    real = main._evict_octree_cache
    monkeypatch.setattr(main, "_evict_octree_cache",
                        lambda *args, **kw: trims.append(kw) or real(*args, **kw))
    merged = main._do_session_merge([a, b])["merged"]
    assert len(trims) == 1 and trims[0]["reason"] == f"merge {merged['session_id']}"
    assert any(str(p).endswith(merged["cache_id"]) for p in trims[0]["keep"])
