"""In-RAM session eviction (idle TTL + LRU count cap + bounded undo history).

Cloud and plant sessions each pin the full source-of-truth in RAM and were
previously reclaimed only by an explicit DELETE — a renderer reload/crash that
never issued one leaked them until the backend died. These tests pin the
lazy-sweep eviction policy and the bounded `deleted_history`.

No PotreeConverter / TestClient needed: we exercise the pure ranking helper and
the sweep functions against fabricated session objects in the real module dicts,
and the history cap through the in-RAM mask logic.
"""

import threading

import numpy as np
import pytest

import main


@pytest.fixture(autouse=True)
def _clean_session_state():
    """Each test gets empty session dicts and known limits; restore after."""
    saved = (
        dict(main._cloud_sessions),
        dict(main._plant_sessions),
        main._SESSION_IDLE_TTL_SECONDS,
        main._MAX_CLOUD_SESSIONS,
        main._MAX_PLANT_SESSIONS,
        main._MAX_DELETED_HISTORY,
    )
    main._cloud_sessions.clear()
    main._plant_sessions.clear()
    yield
    main._cloud_sessions.clear()
    main._plant_sessions.clear()
    (
        cs, ps,
        main._SESSION_IDLE_TTL_SECONDS,
        main._MAX_CLOUD_SESSIONS,
        main._MAX_PLANT_SESSIONS,
        main._MAX_DELETED_HISTORY,
    ) = saved
    main._cloud_sessions.update(cs)
    main._plant_sessions.update(ps)


def _make_cloud_session(session_id: str, *, n: int = 10, last_accessed: float) -> "main.CloudSession":
    pos = np.zeros((n, 3), dtype=np.float64)
    return main.CloudSession(
        session_id=session_id,
        source_path="<test>",
        ascii_format=None,
        column_plan=None,
        positions=pos,
        colors=None,
        intensity=None,
        extras={},
        extra_dims_meta=[],
        deleted=np.zeros(n, dtype=bool),
        deleted_history=[],
        octree_cache_id=None,
        created_at=last_accessed,
        last_accessed=last_accessed,
    )


class _Handle:
    """A pyhelios-handle stand-in that records its __exit__ teardown."""

    def __init__(self):
        self.torn_down = 0

    def __exit__(self, *a):
        self.torn_down += 1


class _FakePlantSession:
    """Stands in for PlantSession with the two attrs eviction reads + separate
    context/plantarch teardown spies. The real dataclass holds live pyhelios
    handles we don't want in a unit test; eviction only touches
    last_accessed/created_at and the two handles' __exit__."""

    def __init__(self, session_id, last_accessed):
        self.session_id = session_id
        self.created_at = last_accessed
        self.last_accessed = last_accessed
        self.context = _Handle()
        self.plantarch = _Handle()
        self.lock = threading.Lock()
        self.closed = False

    @property
    def torn_down(self) -> int:
        # 1 once both handles have been exited exactly once.
        return min(self.context.torn_down, self.plantarch.torn_down)


# ---- pure ranking helper ----------------------------------------------------

def test_evict_idle_past_ttl():
    main._SESSION_IDLE_TTL_SECONDS = 100.0
    now = 1000.0
    sessions = {
        "fresh": _make_cloud_session("fresh", last_accessed=now - 10),
        "stale": _make_cloud_session("stale", last_accessed=now - 500),
    }
    evict = main._evict_session_ids(sessions, max_count=100, now=now)
    assert evict == ["stale"]


def test_evict_over_count_cap_oldest_first():
    main._SESSION_IDLE_TTL_SECONDS = 0  # disable TTL; isolate the count cap
    now = 1000.0
    sessions = {
        f"s{i}": _make_cloud_session(f"s{i}", last_accessed=now - (5 - i))
        for i in range(5)  # s0 oldest .. s4 newest
    }
    evict = main._evict_session_ids(sessions, max_count=2, now=now)
    # Keep the 2 most recent (s3, s4); evict the 3 oldest.
    assert set(evict) == {"s0", "s1", "s2"}


def test_no_eviction_when_within_limits():
    main._SESSION_IDLE_TTL_SECONDS = 100.0
    now = 1000.0
    sessions = {"a": _make_cloud_session("a", last_accessed=now - 1)}
    assert main._evict_session_ids(sessions, max_count=8, now=now) == []


# ---- cloud sweep ------------------------------------------------------------

def test_sweep_cloud_sessions_drops_over_cap():
    main._SESSION_IDLE_TTL_SECONDS = 0
    main._MAX_CLOUD_SESSIONS = 2
    import time
    base = time.time()
    for i in range(4):
        sid = f"c{i}"
        main._cloud_sessions[sid] = _make_cloud_session(sid, last_accessed=base + i)
    main._sweep_cloud_sessions()
    assert set(main._cloud_sessions) == {"c2", "c3"}  # two newest survive


# ---- plant sweep tears down pyhelios ---------------------------------------

def test_sweep_plant_sessions_tears_down_evicted():
    main._SESSION_IDLE_TTL_SECONDS = 0
    main._MAX_PLANT_SESSIONS = 1
    import time
    base = time.time()
    old = _FakePlantSession("p_old", base)
    new = _FakePlantSession("p_new", base + 10)
    main._plant_sessions["p_old"] = old
    main._plant_sessions["p_new"] = new
    main._sweep_plant_sessions()
    assert set(main._plant_sessions) == {"p_new"}
    assert old.torn_down == 1   # context/plantarch __exit__ called on eviction
    assert new.torn_down == 0


def test_sweep_plant_sessions_skips_a_session_in_use():
    """A session whose lock is held is mid-advance: freeing it would pull the
    native objects out from under that call. The sweep leaves it for later."""
    main._SESSION_IDLE_TTL_SECONDS = 0
    main._MAX_PLANT_SESSIONS = 1
    import time
    base = time.time()
    busy = _FakePlantSession("p_busy", base)
    new = _FakePlantSession("p_new", base + 10)
    main._plant_sessions["p_busy"] = busy
    main._plant_sessions["p_new"] = new
    with busy.lock:
        main._sweep_plant_sessions()
    assert set(main._plant_sessions) == {"p_busy", "p_new"}
    assert busy.torn_down == 0 and not busy.closed


class _BlockingPlantArch(_Handle):
    """advanceTime parks until released, and logs the order things happen in."""

    def __init__(self, log, started, release):
        super().__init__()
        self.log, self.started, self.release = log, started, release

    def advanceTime(self, dt):
        self.log.append("advance-start")
        self.started.set()
        assert self.release.wait(5)
        self.log.append("advance-end")

    def getPlantAge(self, pid):
        return 1.0

    def getPlantHeight(self, pid):
        return 0.1

    def __exit__(self, *a):
        self.log.append("teardown")
        super().__exit__(*a)


def test_delete_waits_for_an_advance_in_flight():
    """DELETE (or File -> New, or a retry after a client timeout) used to free the
    pyhelios objects while advanceTime was still running on them -- a segfault
    that takes the whole backend down. Teardown must wait for the call."""
    log, started, release = [], threading.Event(), threading.Event()
    sess = main.PlantSession(
        session_id="p_live", plant_type="bean", plant_id=0, context=_Handle(),
        plantarch=_BlockingPlantArch(log, started, release), current_age=0.0,
        position=(0, 0, 0), created_at=0.0, last_accessed=0.0)
    main._plant_sessions["p_live"] = sess
    advance = threading.Thread(target=main.advance_plant_session, args=(
        "p_live", main.PlantSessionAdvanceRequest(dt=1.0)))
    advance.start()
    assert started.wait(5)
    delete = threading.Thread(target=main.delete_plant_session, args=("p_live",))
    delete.start()
    delete.join(0.3)
    assert delete.is_alive(), "teardown must not run while advanceTime is"
    release.set()
    advance.join(5)
    delete.join(5)
    assert log == ["advance-start", "advance-end", "teardown"]
    assert sess.closed and "p_live" not in main._plant_sessions


def test_a_request_that_waited_out_a_teardown_gets_404():
    sess = _FakePlantSession("p_gone", 0.0)
    main._plant_sessions["p_gone"] = sess
    sess.closed = True  # torn down after this request found it in the dict
    with pytest.raises(main.HTTPException) as exc:
        with main._plant_session_in_use("p_gone"):
            pass
    assert exc.value.status_code == 404


# ---- bounded undo history ---------------------------------------------------

def test_deleted_history_is_bounded():
    """The delete_region append + trim caps the per-session undo stack so a long
    erase session can't grow RAM unbounded by full-mask snapshots."""
    main._MAX_DELETED_HISTORY = 5
    sess = _make_cloud_session("h", n=20, last_accessed=0.0)
    for _ in range(20):
        # mirror the endpoint's append-then-trim
        sess.deleted_history.append(sess.deleted.copy())
        if len(sess.deleted_history) > main._MAX_DELETED_HISTORY:
            sess.deleted_history = sess.deleted_history[-main._MAX_DELETED_HISTORY:]
    assert len(sess.deleted_history) == 5
