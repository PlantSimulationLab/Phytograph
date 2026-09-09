"""An evicted cloud session must be recoverable, not lost.

`_MAX_CLOUD_SESSIONS` (8) bounds RAM, and until now it also bounded what the user
could DO: the 9th import silently made the 1st cloud unusable — every compute,
export and ICP on it answered `404: Cloud session not found`, with no way back.

From the field, a two-hour session log: 77 `POST /api/cloud/session/create*`
calls produced 39 evictions, one per create, at the cap's steady state. The user
left for an hour, came back, ran cloud-to-cloud ICP and got

    404: Cloud session not found: ded335cd

for a session evicted at 14:45:36 — during a `create-multi` batch, twelve minutes
after its last use, i.e. well inside the 30-minute idle TTL. It was the COUNT
cap, and the cloud was gone while still sitting in the user's scene.

Eviction now spills the session to disk and `_get_cloud_session` reads it back.
RAM is capped exactly as before; the cost of a miss is a disk read.
"""

import dataclasses
import sys
import threading
import time
from pathlib import Path

import numpy as np
import pytest

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

import main  # noqa: E402


@pytest.fixture
def spill_root(tmp_path, monkeypatch):
    """Isolate the spill directory and the in-process registries."""
    root = tmp_path / "sessions"
    monkeypatch.setenv("PHYTOGRAPH_SESSION_SPILL_ROOT", str(root))
    monkeypatch.setattr(main, "_cloud_sessions", {})
    monkeypatch.setattr(main, "_spilled_sessions", {})
    monkeypatch.setattr(main, "_spilling_sessions", {})
    monkeypatch.setattr(main, "_session_restore_locks", {})
    return root


def _session(session_id: str, n: int = 64) -> "main.CloudSession":
    rng = np.random.default_rng(abs(hash(session_id)) % (2**32))
    return main.CloudSession(
        session_id=session_id,
        source_path=f"/tmp/{session_id}.las",
        ascii_format=None,
        column_plan=None,
        positions=rng.random((n, 3)) * 10.0,
        colors=(rng.random((n, 3)) * 65535).astype(np.uint16),
        intensity=(rng.random(n) * 65535).astype(np.uint16),
        extras={"reflectance": rng.random(n).astype(np.float32)},
        extra_dims_meta=[{"slug": "reflectance", "label": "Reflectance"}],
        deleted=np.zeros(n, dtype=bool),
        deleted_history=[],
        octree_cache_id=f"octree-{session_id}",
        created_at=time.time(),
        last_accessed=time.time(),
    )


def _admit(sess, age: float) -> None:
    """Register `sess` as last used `age` seconds AGO.

    Ages are in the past on purpose. A restore stamps `last_accessed = now`, so a
    fixture that dated its sessions in the FUTURE would make every restored
    session look like the oldest one and get it re-evicted by the very sweep that
    follows the restore — a test artifact that says nothing about the code.
    """
    sess.last_accessed = time.time() - age
    main._cloud_sessions[sess.session_id] = sess


# ---------------------------------------------------------------------------
# The field failure
# ---------------------------------------------------------------------------

def test_a_session_evicted_by_the_count_cap_is_still_usable(spill_root, monkeypatch):
    """The reported bug: import past the cap, then use the oldest cloud."""
    monkeypatch.setattr(main, "_MAX_CLOUD_SESSIONS", 3)
    for i in range(3):
        _admit(_session(f"s{i}"), 100 - i)
    victim = main._cloud_sessions["s0"]

    _admit(_session("s3"), 0)
    main._sweep_cloud_sessions()

    # It really did leave RAM — the cap is still doing its job.
    assert "s0" not in main._cloud_sessions
    assert len(main._cloud_sessions) == 3

    restored = main._get_cloud_session("s0")

    assert restored is not victim, "a restore must come off disk, not be the same object"
    np.testing.assert_array_equal(restored.positions, victim.positions)
    np.testing.assert_array_equal(restored.colors, victim.colors)
    np.testing.assert_array_equal(
        restored.extras["reflectance"], victim.extras["reflectance"]
    )
    assert restored.octree_cache_id == "octree-s0"


def test_restoring_does_not_grow_ram_past_the_cap(spill_root, monkeypatch):
    """Recovery must not become a memory leak — it swaps, it does not add."""
    monkeypatch.setattr(main, "_MAX_CLOUD_SESSIONS", 3)
    for i in range(4):
        _admit(_session(f"s{i}"), 100 - i)
    main._sweep_cloud_sessions()
    assert len(main._cloud_sessions) == 3

    main._get_cloud_session("s0")

    assert len(main._cloud_sessions) == 3
    assert "s0" in main._cloud_sessions
    # Whatever was pushed out to make room is itself recoverable.
    evicted = {"s0", "s1", "s2", "s3"} - set(main._cloud_sessions)
    assert evicted
    for sid in evicted:
        assert main._get_cloud_session(sid).session_id == sid


def test_a_genuinely_unknown_session_still_404s(spill_root):
    with pytest.raises(main.HTTPException) as exc:
        main._get_cloud_session("never-existed")
    assert exc.value.status_code == 404


# ---------------------------------------------------------------------------
# The blind spot the pickle choice exists to close
# ---------------------------------------------------------------------------

def test_every_cloudsession_field_survives_the_round_trip(spill_root):
    """A new field on CloudSession must not be silently dropped by the spill.

    This is why the spill pickles the dataclass rather than naming each array:
    a hand-written serializer's failure mode is that someone adds a field, forgets
    it, and every restored session quietly loses it. Walking `dataclasses.fields`
    means that failure cannot be introduced without failing here.
    """
    sess = _session("full")
    n = len(sess.positions)
    # Populate the fields a bare construction leaves at their defaults, so this
    # asserts over real values rather than a wall of matching Nones.
    sess.world_shift = np.array([1.0, 2.0, 3.0])
    sess.miss_octree_cache_id = "miss-full"
    sess.miss_octree_origin = [0.5, 0.5, 1.7]
    sess.backfilled_misses_stale = True
    sess.timestamps = np.arange(n, dtype=np.float64) + 3.5e8
    sess.gps_time_encoding = "adjusted_standard"
    sess.beam_origins = np.zeros((n, 3), dtype=np.float64)
    sess.crs_epsg = 32610
    sess.label_dirty = {"ground_class": True}
    sess.octree_pose = [1.0, 0, 0, 0, 0, 1.0, 0, 0, 0, 0, 1.0, 0, 0, 0, 0, 1.0]
    sess.rendered_octree_cache_id = "rendered-full"
    sess.deleted_history = [np.zeros(n, dtype=bool), np.ones(n, dtype=bool)]
    sess.backfilled_misses = {
        "positions": np.ones((4, 3)) * 1000.0,
        "directions": np.ones((4, 3), dtype=np.float32),
    }
    sess.ascii_format = "x y z reflectance"
    sess.column_plan = main.ColumnPlan(
        columns=[main.ColumnPlanEntry(index=0, role="x"),
                 main.ColumnPlanEntry(index=3, role="extra", slug="ref",
                                      label="Reflectance", categorical=False)],
    )
    sess.label_history = {"ground_class": [main._LabelDelta(
        stroke_id="stroke-1", encoding="sparse",
        idx=np.array([1, 5, 9], dtype=np.int64),
        prev=np.array([2, 2, 3], dtype=np.uint8),
        changed_count=3,
    )]}

    entry = main._spill_cloud_session(sess)
    assert entry is not None
    main._spilled_sessions[sess.session_id] = entry
    restored = main._restore_cloud_session(sess.session_id)
    assert restored is not None

    unset = []
    for f in dataclasses.fields(main.CloudSession):
        before, after = getattr(sess, f.name), getattr(restored, f.name)
        if isinstance(before, np.ndarray):
            np.testing.assert_array_equal(after, before, err_msg=f.name)
        elif isinstance(before, dict) and before and isinstance(
            next(iter(before.values())), np.ndarray
        ):
            assert set(after) == set(before), f.name
            for k in before:
                np.testing.assert_array_equal(after[k], before[k], err_msg=f"{f.name}[{k}]")
        elif isinstance(before, list) and before and isinstance(before[0], np.ndarray):
            assert len(after) == len(before), f.name
            for i, arr in enumerate(before):
                np.testing.assert_array_equal(after[i], arr, err_msg=f"{f.name}[{i}]")
        elif f.name in ("last_accessed", "label_history"):
            continue  # re-stamped on restore / compared structurally below
        else:
            assert after == before, f.name
        if before is None or (isinstance(before, (dict, list)) and not before):
            unset.append(f.name)

    # The delta objects inside label_history are dataclasses of their own, so
    # `==` above compares by identity of their ndarray fields, not by value.
    # Check one explicitly rather than trusting that comparison.
    delta = restored.label_history["ground_class"][0]
    np.testing.assert_array_equal(delta.idx, np.array([1, 5, 9]))
    np.testing.assert_array_equal(delta.prev, np.array([2, 2, 3]))
    assert delta.stroke_id == "stroke-1" and delta.changed_count == 3

    # Guard the guard: if most fields were left at their defaults this test would
    # pass while proving almost nothing.
    assert len(unset) <= 2, f"too many fields left unpopulated to be meaningful: {unset}"


# ---------------------------------------------------------------------------
# Lifecycle
# ---------------------------------------------------------------------------

def test_a_lookup_during_the_write_window_re_admits_the_live_object(
    spill_root, monkeypatch
):
    """The pop and the (hundreds of MB) write are split so the global session
    lock is never held across the write. A lookup landing in that window must be
    a HIT — the object is still in RAM and perfectly valid."""
    monkeypatch.setattr(main, "_MAX_CLOUD_SESSIONS", 1)
    _admit(_session("old"), 100)
    _admit(_session("new"), 0)

    seen = {}
    real_spill = main._spill_cloud_session

    def spill_but_race(sess):
        # Exactly the interleaving the split creates: someone asks for the
        # session after the pop, before the file exists.
        seen["got"] = main._get_cloud_session("old")
        return real_spill(sess)

    monkeypatch.setattr(main, "_spill_cloud_session", spill_but_race)
    main._sweep_cloud_sessions()

    assert seen["got"].session_id == "old"
    assert "old" in main._cloud_sessions, "the re-admitted session must stay resident"
    assert "old" not in main._spilled_sessions, "a re-admitted session must not be indexed as spilled"


def test_deleting_a_session_reclaims_its_spill(spill_root, monkeypatch):
    monkeypatch.setattr(main, "_MAX_CLOUD_SESSIONS", 1)
    _admit(_session("gone"), 100)
    _admit(_session("keep"), 0)
    main._sweep_cloud_sessions()
    path = Path(main._spilled_sessions["gone"]["path"])
    assert path.is_file()

    body = main.delete_cloud_session("gone")

    assert body["deleted"] is True
    assert not path.exists()
    assert "gone" not in main._spilled_sessions
    with pytest.raises(main.HTTPException):
        main._get_cloud_session("gone")


def test_startup_wipes_a_previous_run_s_spills(spill_root, monkeypatch):
    """Session ids are per-run UUIDs, so yesterday's spills are unreachable
    bytes. Leaving them would leak gigabytes per launch."""
    monkeypatch.setattr(main, "_MAX_CLOUD_SESSIONS", 1)
    _admit(_session("stale"), 100)
    _admit(_session("live"), 0)
    main._sweep_cloud_sessions()
    assert any(spill_root.iterdir())

    main._clear_session_spills()

    assert not spill_root.exists() or not any(spill_root.iterdir())
    assert main._spilled_sessions == {}


def test_a_corrupt_spill_is_a_miss_not_a_crash(spill_root, monkeypatch):
    monkeypatch.setattr(main, "_MAX_CLOUD_SESSIONS", 1)
    _admit(_session("bad"), 100)
    _admit(_session("good"), 0)
    main._sweep_cloud_sessions()
    Path(main._spilled_sessions["bad"]["path"]).write_bytes(b"not a pickle")

    with pytest.raises(main.HTTPException) as exc:
        main._get_cloud_session("bad")
    assert exc.value.status_code == 404
    # And it is forgotten, so it is not re-read on every subsequent request.
    assert "bad" not in main._spilled_sessions


def test_a_spilled_session_still_pins_its_octrees(spill_root, monkeypatch):
    """A spilled cloud is out of RAM, not out of the scene. If eviction dropped
    the octree pin, the next convert could delete the only rendered copy of an
    edited cloud — the loss `_evict_octree_cache` pins live sessions to prevent.
    """
    monkeypatch.setattr(main, "_MAX_CLOUD_SESSIONS", 1)
    old = _session("old")
    old.miss_octree_cache_id = "miss-old"
    old.rendered_octree_cache_id = "rendered-old"
    _admit(old, 100)
    _admit(_session("new"), 0)
    main._sweep_cloud_sessions()

    pinned = main._live_session_octree_ids()

    assert {"octree-old", "miss-old", "rendered-old"} <= pinned
    assert "octree-new" in pinned


def test_the_spill_directory_is_held_under_its_cap(spill_root, monkeypatch):
    """Over the cap the oldest spill is dropped — reverting THAT cloud to the
    old 404 behaviour, which is why it is the last resort and is logged."""
    monkeypatch.setattr(main, "_MAX_CLOUD_SESSIONS", 1)
    monkeypatch.setenv("PHYTOGRAPH_SESSION_SPILL_MAX_BYTES", "1")
    _admit(_session("first"), 100)
    _admit(_session("second"), 50)
    main._sweep_cloud_sessions()
    _admit(_session("third"), 0)
    main._sweep_cloud_sessions()

    assert "first" not in main._spilled_sessions
    assert not (spill_root / "first.session").exists()
    with pytest.raises(main.HTTPException):
        main._get_cloud_session("first")


def test_concurrent_lookups_read_the_file_once(spill_root, monkeypatch):
    """Two requests for the same evicted cloud must not each read hundreds of
    MB off disk."""
    monkeypatch.setattr(main, "_MAX_CLOUD_SESSIONS", 1)
    _admit(_session("shared"), 100)
    _admit(_session("other"), 0)
    main._sweep_cloud_sessions()

    reads = []
    real_open = open

    def counting_open(path, *a, **kw):
        if str(path).endswith("shared.session") and "rb" in str(a) + str(kw):
            reads.append(path)
        return real_open(path, *a, **kw)

    monkeypatch.setattr("builtins.open", counting_open)
    results = []
    lock = threading.Lock()
    # Sized to the workers only — the main thread does not participate, it joins.
    barrier = threading.Barrier(4)

    def worker():
        barrier.wait(timeout=10)
        sid = main._get_cloud_session("shared").session_id
        with lock:
            results.append(sid)

    threads = [threading.Thread(target=worker) for _ in range(4)]
    for t in threads:
        t.start()
    for t in threads:
        t.join(timeout=30)
    assert not any(t.is_alive() for t in threads), "a restore deadlocked"

    assert results == ["shared"] * 4
    assert len(reads) == 1, f"read the spill {len(reads)} times"


def test_a_failed_spill_invalidates_an_older_one(spill_root, monkeypatch):
    """A stale snapshot is worse than an honest 404.

    A session can be spilled, restored, edited, and evicted again. If that second
    write fails, the file still on disk describes the cloud BEFORE the edit —
    serving it back would silently undo the user's work, which is the failure
    mode `handleOctreeMissing` refuses to allow for octrees and that this must
    refuse for arrays.
    """
    monkeypatch.setattr(main, "_MAX_CLOUD_SESSIONS", 1)
    _admit(_session("edited"), 100)
    _admit(_session("other"), 0)
    main._sweep_cloud_sessions()
    assert "edited" in main._spilled_sessions
    path = Path(main._spilled_sessions["edited"]["path"])

    # Bring it back, edit it, and evict it again with the write broken.
    sess = main._get_cloud_session("edited")
    sess.extras["reflectance"][:] = 42.0
    _admit(_session("newer"), 0)
    monkeypatch.setattr(main, "_spill_cloud_session", lambda s: None)
    main._sweep_cloud_sessions()

    assert "edited" not in main._cloud_sessions
    assert "edited" not in main._spilled_sessions
    assert not path.exists(), "the pre-edit snapshot must be deleted, not left to be served"
    with pytest.raises(main.HTTPException) as exc:
        main._get_cloud_session("edited")
    assert exc.value.status_code == 404


def test_an_edit_after_a_re_admission_is_not_lost(spill_root, monkeypatch):
    """The write-window race, followed through to its consequence.

    A lookup lands mid-write and takes the session back; the user edits it. The
    half-written file describes the cloud before that edit, so it must never be
    indexed — otherwise the next restore quietly reverts the edit.
    """
    monkeypatch.setattr(main, "_MAX_CLOUD_SESSIONS", 1)
    _admit(_session("raced"), 100)
    _admit(_session("other"), 0)

    real_spill = main._spill_cloud_session

    def spill_but_race(sess):
        out = real_spill(sess)
        main._get_cloud_session("raced").extras["reflectance"][:] = 7.0
        return out

    monkeypatch.setattr(main, "_spill_cloud_session", spill_but_race)
    main._sweep_cloud_sessions()

    assert "raced" not in main._spilled_sessions
    # Evict it properly now and check the edit survives the round trip.
    monkeypatch.setattr(main, "_spill_cloud_session", real_spill)
    _admit(_session("newest"), 0)
    main._sweep_cloud_sessions()
    restored = main._get_cloud_session("raced")
    np.testing.assert_array_equal(
        restored.extras["reflectance"], np.full(64, 7.0, dtype=np.float32)
    )


# ---------------------------------------------------------------------------
# The chokepoint
# ---------------------------------------------------------------------------

def test_session_reads_go_through_the_lookup_chokepoint():
    """No new `_cloud_sessions.get(...)` may bypass the spill fallback.

    A direct dict read reports a merely-EVICTED cloud as absent, and several of
    these callers degrade silently on a miss rather than erroring: the
    multi-return columns fall back to a single-return triangulation (~1/3 the
    true leaf area, per that function's own docstring) and the LAD beam origins
    fall back to a trajectory join. Both would produce a confident wrong number
    for a cloud that is merely paged out — which is exactly the class of failure
    the spill exists to end, reintroduced one call site at a time.

    Three reads are legitimate and are named here; anything else must use
    `_get_cloud_session` / `_peek_cloud_session`.
    """
    src = (Path(main.__file__).resolve()).read_text(encoding="utf-8").splitlines()
    hits = [
        (i + 1, line.strip())
        for i, line in enumerate(src)
        if "_cloud_sessions.get(" in line
    ]
    enclosing = []
    for lineno, _text in hits:
        for j in range(lineno - 1, -1, -1):
            stripped = src[j].lstrip()
            if stripped.startswith("def ") and (len(src[j]) - len(stripped)) == 0:
                enclosing.append(stripped.split("(")[0][4:])
                break
        else:
            enclosing.append("<module>")

    allowed = {
        # The chokepoint itself.
        "_get_cloud_session",
        # Its own re-check after waiting on the per-id restore lock.
        "_restore_cloud_session",
        # A progress-bar weight: paging a spilled session in off disk to size a
        # slice would read hundreds of MB; a miss falls back to equal weights.
        "_scan_entry_points_estimate",
    }
    unexpected = sorted(set(enclosing) - allowed)
    assert not unexpected, (
        "these read `_cloud_sessions` directly and so cannot see a spilled "
        f"session: {unexpected}"
    )


def test_a_snapshot_discarded_by_a_re_admission_leaves_no_file(spill_root, monkeypatch):
    """The discarded snapshot must be deleted, not left on disk.

    It cannot be kept as a fallback: the claimant is free to mutate the arrays
    while pickle is still walking them, so the file may be torn. Left behind it
    would also count against the spill cap until the next launch wiped it.
    """
    monkeypatch.setattr(main, "_MAX_CLOUD_SESSIONS", 1)
    _admit(_session("raced"), 100)
    _admit(_session("other"), 0)

    real_spill = main._spill_cloud_session
    written = {}

    def spill_but_race(sess):
        out = real_spill(sess)
        written["path"] = Path(out["path"])
        assert written["path"].is_file()
        main._get_cloud_session("raced")
        return out

    monkeypatch.setattr(main, "_spill_cloud_session", spill_but_race)
    main._sweep_cloud_sessions()

    assert "raced" not in main._spilled_sessions
    assert not written["path"].exists()


# ---------------------------------------------------------------------------
# End to end, through the real endpoints
# ---------------------------------------------------------------------------

GRID_FORMAT = "x y z r255 g255 b255 reflectance"


@pytest.fixture
def grid_xyz(tmp_path):
    """A small ASCII cloud, same shape as test_cloud_session's fixture."""
    f = tmp_path / "grid.xyz"
    lines = []
    for i in range(10):
        for j in range(10):
            for k in range(10):
                lines.append(
                    f"{i*0.1:.4f} {j*0.1:.4f} {k*0.1:.4f} "
                    f"{(i*17)%256} {(j*23)%256} {(k*31)%256} {((i+j+k)*0.01)%1.0:.4f}"
                )
    f.write_text("\n".join(lines) + "\n")
    return f


def test_a_cloud_evicted_by_a_later_import_still_edits_and_exports(
    client, tmp_path, monkeypatch, grid_xyz
):
    """The reported workflow, end to end through the HTTP API.

    Import a cloud, import enough more to push it past the cap, then do to it
    exactly what the user did an hour later: use it. Before the spill this
    answered `404: Cloud session not found` from the first call on.
    """
    from tests.binframe import decode_streamed_json

    monkeypatch.setenv("PHYTOGRAPH_OCTREE_CACHE_ROOT", str(tmp_path / "octrees"))
    monkeypatch.setenv("PHYTOGRAPH_SESSION_SPILL_ROOT", str(tmp_path / "sessions"))
    monkeypatch.setattr(main, "_MAX_CLOUD_SESSIONS", 1)
    # Start from an empty registry: other tests in this suite share the module
    # dict, and a leftover would change which session the cap pushes out.
    monkeypatch.setattr(main, "_cloud_sessions", {})

    def _create():
        res = client.post(
            "/api/cloud/session/create",
            json={"source_path": str(grid_xyz), "ascii_format": GRID_FORMAT},
        )
        assert res.status_code == 200, res.text
        return decode_streamed_json(res.content)["session_id"]

    # `_do_create_cloud_session` sweeps BEFORE it inserts, so the cap bites on
    # the create AFTER the one that goes over it — three creates at cap 1.
    first = _create()
    _create()
    _create()
    assert first not in main._cloud_sessions, "the cap must still have evicted it"
    assert first in main._spilled_sessions

    # 1. Read it back and edit it — the crop the user would run.
    res = client.post(
        f"/api/cloud/session/{first}/delete_region",
        json={"region": {"kind": "box", "min": [0.2, 0.2, 0.2],
                         "max": [0.7, 0.7, 0.7], "invert": False}},
    )
    assert res.status_code == 200, res.text
    removed = decode_streamed_json(res.content)["deleted_count"]
    assert removed == 216, removed  # the 6^3 interior of the 10^3 grid

    # 2. Push it out again, so the edit has to survive a second round trip.
    _create()
    _create()
    assert first not in main._cloud_sessions

    # 3. Bake it. This is the strongest end-to-end check available: it rebuilds
    #    the octree from the RESTORED in-RAM arrays, so a wrong or stale restore
    #    shows up as a wrong survivor count rather than merely "did not throw".
    survivors = 1000 - removed
    res = client.post(f"/api/cloud/session/{first}/bake")
    assert res.status_code == 200, res.text
    body = decode_streamed_json(res.content)
    assert body["baked"] is True
    assert body["point_count"] == survivors, body
    sess = main._cloud_sessions[first]
    assert len(sess.positions) == survivors
    assert int(sess.deleted.sum()) == 0


# ---------------------------------------------------------------------------
# Review findings, pinned
# ---------------------------------------------------------------------------

def test_a_session_held_by_an_in_flight_request_is_not_evicted(spill_root, monkeypatch):
    """H2 from the independent review: a handler holds its session for the whole
    request, but `last_accessed` is stamped only at the fetch. A create batch
    running alongside a long edit would make the edited cloud the LRU and pickle
    it OUTSIDE the lock while the handler was still writing its arrays — a torn
    or pre-edit snapshot, later restored over the user's edit. Pins stop it."""
    monkeypatch.setattr(main, "_MAX_CLOUD_SESSIONS", 1)
    _admit(_session("editing"), 100)

    with main._session_pin_scope() as pins:
        held = main._get_cloud_session("editing")   # what a handler does first
        assert "editing" in pins
        _admit(_session("newer"), 0)                 # a create lands meanwhile
        main._sweep_cloud_sessions()

        # Over the cap, and it must stay that way while the handler runs.
        assert main._cloud_sessions["editing"] is held
        assert "editing" not in main._spilled_sessions
        held.extras["reflectance"][:] = 3.0           # the edit completes safely

    # Request over: the next sweep may take it, and the spill carries the edit.
    main._sweep_cloud_sessions()
    assert "editing" not in main._cloud_sessions
    restored = main._get_cloud_session("editing")
    np.testing.assert_array_equal(
        restored.extras["reflectance"], np.full(64, 3.0, dtype=np.float32)
    )


def test_http_requests_carry_a_pin_scope(client, tmp_path, monkeypatch, grid_xyz):
    """The middleware installs the pin set, and it survives the hop into anyio's
    worker thread where `def` handlers run. Asserted through `session_merge`,
    which fetches its sources and then sweeps in the same request — at cap 1 the
    sweep would otherwise evict both sources out from under the merge."""
    from tests.binframe import decode_streamed_json

    monkeypatch.setenv("PHYTOGRAPH_OCTREE_CACHE_ROOT", str(tmp_path / "octrees"))
    monkeypatch.setattr(main, "_MAX_CLOUD_SESSIONS", 1)
    monkeypatch.setattr(main, "_cloud_sessions", {})

    def _create():
        res = client.post(
            "/api/cloud/session/create",
            json={"source_path": str(grid_xyz), "ascii_format": GRID_FORMAT},
        )
        assert res.status_code == 200, res.text
        return decode_streamed_json(res.content)["session_id"]

    a, b = _create(), _create()
    seen = {}
    real_sweep = main._sweep_cloud_sessions

    def sweep_and_record():
        seen["pinned"] = main._pinned_session_ids()
        real_sweep()

    monkeypatch.setattr(main, "_sweep_cloud_sessions", sweep_and_record)
    res = client.post("/api/cloud/session/merge", json={"session_ids": [a, b]})
    assert res.status_code == 200, res.text

    assert {a, b} <= seen["pinned"], seen
    # And nothing is pinned once the request has ended.
    assert main._pinned_session_ids() == set()


def test_startup_reaps_only_dead_runs(tmp_path, monkeypatch):
    """H1 from the review: the first cut put every instance's spills in one
    shared directory and wiped it at startup — so a second app instance, a
    parallel E2E worker, or a dev session beside the packaged app deleted the
    OTHER process's clouds mid-session, the very failure the spill exists to
    end. Now each run has its own dir and startup reaps only dirs whose pid is
    gone."""
    import os
    monkeypatch.delenv("PHYTOGRAPH_SESSION_SPILL_ROOT", raising=False)
    monkeypatch.setenv("PHYTOGRAPH_OCTREE_CACHE_ROOT", str(tmp_path / "octrees"))
    parent = main._session_spill_root().parent
    assert parent.name == ".sessions"
    assert parent.parent == tmp_path / "octrees"

    own = main._session_spill_root()
    live = parent / f"{os.getpid()}-deadbeef"       # another run of a LIVE pid
    dead = parent / "4000000-cafef00d"              # no such process
    junk = parent / "not-a-run"
    for d in (own, live, dead, junk):
        d.mkdir(parents=True)
        (d / "x.session").write_bytes(b"x")

    main._clear_session_spills()

    assert own.is_dir(), "own dir must survive"
    assert live.is_dir(), "a live pid's dir belongs to another instance"
    assert not dead.exists(), "a dead pid's dir is unreachable and must go"
    assert junk.is_dir(), "an unparseable name is not ours to delete"


def test_the_spill_dir_is_invisible_to_octree_eviction(tmp_path, monkeypatch):
    """Living INSIDE the octree root is only safe if `_evict_octree_cache` never
    counts or deletes it. It walks 40-hex names only; assert that directly so a
    future 'clean up stray dirs' change cannot delete every spilled cloud."""
    monkeypatch.delenv("PHYTOGRAPH_SESSION_SPILL_ROOT", raising=False)
    root = tmp_path / "octrees"
    monkeypatch.setenv("PHYTOGRAPH_OCTREE_CACHE_ROOT", str(root))
    spill = main._session_spill_root()
    spill.mkdir(parents=True)
    (spill / "big.session").write_bytes(b"\0" * 4096)

    main._evict_octree_cache(1, keep=None)   # 1-byte cap: evict everything it can

    assert (spill / "big.session").is_file()
