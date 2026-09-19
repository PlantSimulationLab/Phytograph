"""The heavy paths that were OUTSIDE byte-weighted admission are now inside it.

`_ADMISSION` bounds how much memory concurrent operations may commit to, but it
covered ~13 of 97 routes: every session MUTATION (merge, transform, split,
extract) and every REGISTRATION path (c2c ICP, c2m ICP, global register) ran
outside it. That is worse than it sounds, because `Admission._acquire` admits
freely whenever nothing is in flight -- so unadmitted work is arithmetically
INVISIBLE to the gate. It neither waits for a running job nor makes one wait for
it, in either direction. `merge` is the sharpest case: it concatenates N
sessions and is the single largest allocation the backend can make.

These assert the property that matters -- the operation is counted against the
budget WHILE IT RUNS -- rather than that some function was called. Each test
observes `_ADMISSION.in_flight()` from inside the work itself, via a patched
callee, which is the only way to see a context manager that has already exited
by the time the endpoint returns.
"""
import numpy as np
import pytest

import main


@pytest.fixture
def observe_in_flight(monkeypatch):
    """Patch `attr` on `main` so it records what admission held when it ran.

    Returns the list the labels land in. The wrapper calls through, so the
    endpoint still does its real work and the test is not a stub.
    """
    def _install(attr):
        seen: list = []
        original = getattr(main, attr)

        def _spy(*args, **kwargs):
            seen.extend(f["label"] for f in main._ADMISSION.in_flight())
            return original(*args, **kwargs)

        monkeypatch.setattr(main, attr, _spy)
        return seen
    return _install


def _session(make_file_session, tmp_path, name, n=200, offset=0.0):
    """A small real session on disk, via the same loader an import uses."""
    pts = np.random.default_rng(0).random((n, 3)) * 2.0 + offset
    path = tmp_path / f"{name}.xyz"
    path.write_text("\n".join(f"{x} {y} {z}" for x, y, z in pts))
    return make_file_session(path)


# ---- session mutations -------------------------------------------------------

def test_merge_is_admitted_while_it_concatenates(client, make_file_session,
                                                 tmp_path, observe_in_flight):
    a = _session(make_file_session, tmp_path, "a")
    b = _session(make_file_session, tmp_path, "b", offset=5.0)
    seen = observe_in_flight("_merge_sessions_locked")

    r = client.post("/api/cloud/session/merge", json={"session_ids": [a, b]})
    assert r.status_code == 200, r.text
    assert any("merge" in label for label in seen), (
        f"the concatenation ran with nothing admitted: {seen}"
    )


def test_transform_is_admitted_while_it_rewrites_positions(
        client, make_file_session, tmp_path, monkeypatch):
    sid = _session(make_file_session, tmp_path, "t")

    # Observe from inside the admitted block: the rewrite happens while holding
    # `_cloud_session_lock`, which the endpoint takes INSIDE the admission, so
    # recording in_flight on acquire sees exactly the window under test. A callee
    # outside the block (the octree rebuild) would see an empty list and prove
    # nothing. It also pins the ORDER, which matters: admission must be acquired
    # before the lock, never under it, or a waiting job holds the session lock
    # while it sleeps and stalls every other session request.
    seen: list = []
    real_lock = main._cloud_session_lock

    class _Watched:
        def __enter__(self):
            seen.extend(f["label"] for f in main._ADMISSION.in_flight())
            return real_lock.__enter__()

        def __exit__(self, *exc):
            return real_lock.__exit__(*exc)

    monkeypatch.setattr(main, "_cloud_session_lock", _Watched())

    identity = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]
    r = client.post(f"/api/cloud/session/{sid}/transform",
                    json={"matrix": identity, "octree_mode": "pose"})
    assert r.status_code == 200, r.text
    assert any("transform" in label for label in seen), (
        f"positions were rewritten with nothing admitted: {seen}"
    )


def test_extract_is_admitted_while_it_gathers(client, make_file_session,
                                              tmp_path, observe_in_flight):
    sid = _session(make_file_session, tmp_path, "e")
    # `_region_mask` runs inside the admitted block; see the transform test.
    seen = observe_in_flight("_region_mask")

    r = client.post(f"/api/cloud/session/{sid}/extract", json={
        "region": {"kind": "box", "min": [0, 0, 0], "max": [1, 1, 1]},
    })
    assert r.status_code == 200, r.text
    assert any("extract" in label for label in seen), (
        f"the gather ran with nothing admitted: {seen}"
    )


def test_split_is_admitted_while_it_gathers(client, make_file_session,
                                            tmp_path, observe_in_flight):
    sid = _session(make_file_session, tmp_path, "s")
    seen = observe_in_flight("_region_mask")

    r = client.post(f"/api/cloud/session/{sid}/split", json={
        "region": {"kind": "box", "min": [0, 0, 0], "max": [1, 1, 1]},
    })
    assert r.status_code == 200, r.text
    assert any("split" in label for label in seen), (
        f"the gather ran with nothing admitted: {seen}"
    )


def test_admission_is_acquired_before_the_session_lock_not_under_it(
        client, make_file_session, tmp_path, monkeypatch):
    """Order matters as much as presence.

    `Admission._acquire` sleeps on a Condition while it waits for room. Taking
    `_cloud_session_lock` first and admitting under it would hold the global
    session lock across that sleep, stalling every unrelated session request
    behind one queued operation -- and deadlocking against anything that admits
    while holding it. The merge path is the one that does both, so it is the one
    worth pinning.
    """
    a = _session(make_file_session, tmp_path, "oa")
    b = _session(make_file_session, tmp_path, "ob", offset=5.0)

    # The lock is taken and released several times over a merge (session lookup,
    # the sweep, the stitch). What must never happen is admitting WHILE it is
    # held, so track depth rather than a first-occurrence order.
    real_lock = main._cloud_session_lock
    depth = {"held": 0}
    held_at_admit: list = []

    class _Watched:
        def __enter__(self):
            depth["held"] += 1
            return real_lock.__enter__()

        def __exit__(self, *exc):
            depth["held"] -= 1
            return real_lock.__exit__(*exc)

    real_admit = main._ADMISSION.admit

    def _spy_admit(estimate, label):
        if "merge" in label:
            held_at_admit.append(depth["held"])
        return real_admit(estimate, label)

    monkeypatch.setattr(main, "_cloud_session_lock", _Watched())
    monkeypatch.setattr(main._ADMISSION, "admit", _spy_admit)

    r = client.post("/api/cloud/session/merge", json={"session_ids": [a, b]})
    assert r.status_code == 200, r.text
    assert held_at_admit, "merge was never admitted"
    assert all(d == 0 for d in held_at_admit), (
        "admission must NOT be acquired while `_cloud_session_lock` is held "
        f"(depth at admit: {held_at_admit})"
    )


# ---- the estimators ----------------------------------------------------------

def test_mutation_estimate_follows_the_columns_a_session_carries():
    """A bare xyz cloud must not be charged for colour it does not have."""
    class _S:
        def __init__(self, n, **kw):
            self.deleted = np.zeros(n, dtype=bool)
            self.positions = np.zeros((n, 3))
            self.extras = {}
            self.colors = self.intensity = None
            self.timestamps = self.beam_origins = None
            for k, v in kw.items():
                setattr(self, k, v)

    n = 1000
    bare = main._session_mutation_bytes([_S(n)])
    rich = main._session_mutation_bytes(
        [_S(n, colors=np.zeros((n, 3)), intensity=np.zeros(n),
            timestamps=np.zeros(n), beam_origins=np.zeros((n, 3)))])
    assert 0 < bare < rich, "extra columns must raise the estimate"
    # And it scales with the OUTPUT size, which is what merge varies.
    assert main._session_mutation_bytes([_S(n)], out_points=2 * n) == 2 * bare


def test_mutation_estimate_counts_simultaneous_copies():
    class _S:
        deleted = np.zeros(100, dtype=bool)
        positions = np.zeros((100, 3))
        extras: dict = {}
        colors = intensity = timestamps = beam_origins = None

    one = main._session_mutation_bytes([_S()], copies=1.0)
    two = main._session_mutation_bytes([_S()], copies=2.0)
    assert two == 2 * one, (
        "a gather holds the slice AND the output; copies must scale the estimate"
    )


def test_registration_estimate_covers_both_clouds():
    a = np.zeros((1000, 3))
    b = np.zeros((3000, 3))
    both = main._registration_bytes(a, b)
    assert both == main._registration_bytes(np.zeros((4000, 3))), (
        "registration holds both clouds at once; the estimate is their sum"
    )
    assert both > 0


def test_request_registration_estimate_reads_flat_arrays_and_counts():
    """The endpoints size from the request, which carries FLAT xyz arrays."""
    flat = [0.0] * (300 * 3)          # 300 points as x,y,z,x,y,z,...
    assert main._request_registration_bytes(flat) == \
        main._registration_bytes(np.zeros((300, 3)))
    # A session source contributes its point-count estimate as a plain int.
    assert main._request_registration_bytes(300) == \
        main._request_registration_bytes(flat)
    # None (the absent branch of an either/or field) contributes nothing.
    assert main._request_registration_bytes(None, flat) == \
        main._request_registration_bytes(flat)
