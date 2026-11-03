"""`/api/cloud/session/{id}/info` and `/arrays` — the read side of the Python
scripting client (python/phytograph).

What they must get right is what the compute chokepoint already does: true world
coordinates (the import shift added back), deleted rows gone, misses gone unless
asked for, and every scalar column filtered in LOCKSTEP with positions."""
import asyncio
import io
from pathlib import Path

import numpy as np
from fastapi.testclient import TestClient

import main
from tests.binframe import _create_session_direct

FIXTURE = Path(__file__).parent / "fixtures" / "scalars.xyz"
SHIFT = [1000.0, -2000.0, 5.0]


def _session(world_shift=None):
    req = main.CloudSessionCreateRequest(source_path=str(FIXTURE), world_shift=world_shift)
    return asyncio.run(_create_session_direct(req))["session_id"]


def _file_rows():
    return np.loadtxt(FIXTURE, skiprows=1)


def _arrays(client, sid, **params):
    r = client.get(f"/api/cloud/session/{sid}/arrays", params=params)
    assert r.status_code == 200, r.text
    with np.load(io.BytesIO(r.content)) as z:
        return {k: z[k] for k in z.files}


def test_arrays_are_world_coordinates_with_columns_in_lockstep():
    client = TestClient(main.app)
    sid = _session(world_shift=SHIFT)
    rows = _file_rows()

    info = client.get(f"/api/cloud/session/{sid}/info").json()
    assert info["world_shift"] == SHIFT
    assert info["row_count"] == info["live_count"] == info["hit_count"] == len(rows)

    a = _arrays(client, sid)
    assert a["positions"].dtype == np.float64
    # World coordinates: the shift was subtracted at import and is added back.
    np.testing.assert_allclose(a["positions"], rows[:, :3], atol=1e-3)
    slug = next(s for s in info["columns"] if s.lower() == "deviation")
    np.testing.assert_array_equal(a[slug].astype(int), rows[:, 4].astype(int))

    # Delete every deviation==0 row through the session filter.
    r = client.post(f"/api/cloud/session/{sid}/filter",
                    json={"scalar_filters": [{"slug": slug, "min": 0.5}], "rebuild": False})
    assert r.status_code == 200
    keep = rows[:, 4] != 0
    info = client.get(f"/api/cloud/session/{sid}/info").json()
    assert info["live_count"] == int(keep.sum())
    assert info["row_count"] == len(rows)

    a = _arrays(client, sid)
    np.testing.assert_allclose(a["positions"], rows[keep, :3], atol=1e-3)
    np.testing.assert_array_equal(a[slug].astype(int), rows[keep, 4].astype(int))


def test_fields_limits_columns_and_rejects_unknown():
    client = TestClient(main.app)
    sid = _session()
    info = client.get(f"/api/cloud/session/{sid}/info").json()
    slug = info["columns"][0]

    a = _arrays(client, sid, fields=slug, colors=False)
    assert set(a) == {"positions", slug}

    a = _arrays(client, sid, extras=False, colors=False)
    assert set(a) == {"positions"}

    r = client.get(f"/api/cloud/session/{sid}/arrays", params={"fields": "no_such_column"})
    assert r.status_code == 404


def test_misses_excluded_unless_requested():
    client = TestClient(main.app)
    sid = _session()
    sess = main._get_cloud_session(sid)
    n = len(sess.positions)
    miss = np.zeros(n, dtype=np.uint8)
    miss[:3] = 1
    with main._cloud_session_lock:
        sess.extras[main._MISS_SLUG] = miss

    info = client.get(f"/api/cloud/session/{sid}/info").json()
    assert info["hit_count"] == n - 3
    assert len(_arrays(client, sid)["positions"]) == n - 3
    assert len(_arrays(client, sid, include_misses=True)["positions"]) == n


def test_unknown_session_is_404():
    client = TestClient(main.app)
    assert client.get("/api/cloud/session/nope/info").status_code == 404
    assert client.get("/api/cloud/session/nope/arrays").status_code == 404


def test_transform_octree_mode_none_moves_geometry_and_builds_nothing(monkeypatch):
    """`octree_mode: "none"` (the scripting client's mode) must not reconvert,
    even after a `filter(rebuild=False)` left no current octree — the case where
    "pose" falls through to a full PotreeConverter run."""
    client = TestClient(main.app)
    sid = _session(world_shift=SHIFT)
    slug = next(s for s in client.get(f"/api/cloud/session/{sid}/info").json()["columns"]
                if s.lower() == "deviation")
    client.post(f"/api/cloud/session/{sid}/filter",
                json={"scalar_filters": [{"slug": slug, "min": 0.5}], "rebuild": False})
    before = _arrays(client, sid)["positions"]

    def _no_rebuild(*a, **k):
        raise AssertionError("octree_mode=none must not rebuild the octree")
    monkeypatch.setattr(main, "_session_rebuild", _no_rebuild)
    monkeypatch.setattr(main, "_translate_octree_in_place", _no_rebuild)

    rot = [0, -1, 0, 2.0, 1, 0, 0, -3.0, 0, 0, 1, 0.5, 0, 0, 0, 1]
    r = client.post(f"/api/cloud/session/{sid}/transform",
                    json={"matrix": rot, "octree_mode": "none"})
    assert r.status_code == 200, r.text
    body = r.json()
    assert body["octree_stale"] is True and body["cache_id"] is None
    M = np.asarray(rot).reshape(4, 4)
    np.testing.assert_allclose(_arrays(client, sid)["positions"],
                               before @ M[:3, :3].T + M[:3, 3], atol=1e-6)


def test_intensity_is_filterable_and_readable_by_name():
    """Intensity lives on its own session field, not in `extras`. A filter on it
    used to answer "Unknown scalar attribute"; it now resolves, in the stored
    LAS uint16 scale, and `/arrays?fields=intensity` returns it (0-1)."""
    client = TestClient(main.app)
    sid = _session()
    info = client.get(f"/api/cloud/session/{sid}/info").json()
    assert "intensity" in info["columns"]
    inten = _arrays(client, sid, fields="intensity", colors=False)["intensity"]
    assert inten.size == info["live_count"]

    cut = float(np.median(inten))
    r = client.post(f"/api/cloud/session/{sid}/filter",
                    json={"scalar_filters": [{"slug": "intensity", "min": cut * 65535 - 0.5}],
                          "rebuild": False})
    assert r.status_code == 200, r.text
    kept = _arrays(client, sid, fields="intensity", colors=False)["intensity"]
    assert kept.size == int((inten >= cut - 1e-6).sum())
    assert kept.min() >= cut - 1e-5
