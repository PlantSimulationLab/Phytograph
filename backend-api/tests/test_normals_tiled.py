"""The tiled normal estimate must equal the untiled one.

This is THE test for the tool's scalability story. Normals are a neighbourhood
statistic, so a tile that cannot see past its own edge computes a different
answer there than the whole-cloud run would -- and the failure is a cosmetic-
looking seam that silently corrupts anything downstream (Poisson stitches across
it, point-to-plane ICP pulls toward it).

Two properties are pinned separately because they fail for different reasons:

  * ANGLE. Fixed by the collar. `normals._COLLAR_MULTIPLE` x the p99 k-th-NN
    distance was measured to reproduce the untiled result exactly; 0.5x gave
    0.89 deg of error. `test_collar_multiple_is_sufficient` fails if someone
    shrinks it.
  * SIGN. Fixed by orienting toward the sensor origin, which is a per-point
    decision and so cannot depend on which tile a point landed in. An MST
    orientation would be globally coupled and would flip whole tiles.

Both fixtures matter: the uniform one is the easy case, and the 1/r^2 one is the
real terrestrial-scan density, where tiles hold wildly different point counts.
"""

import numpy as np
import pytest

import normals


def _uniform(n=120_000, seed=7):
    rng = np.random.default_rng(seed)
    xy = rng.uniform(-20, 20, size=(n, 2))
    z = (0.4 * np.sin(xy[:, 0] * 0.3) + 0.3 * np.cos(xy[:, 1] * 0.25)
         + rng.normal(0, 0.004, n))
    return np.column_stack([xy, z])


def _tls_density(n=200_000, seed=11):
    """Angular sampling: density falls as 1/r^2, like a real terrestrial scan."""
    rng = np.random.default_rng(seed)
    r = np.sqrt(rng.uniform(0.5 ** 2, 40 ** 2, n))
    th = rng.uniform(0, 2 * np.pi, n)
    xy = np.column_stack([r * np.cos(th), r * np.sin(th)])
    z = 0.3 * np.sin(xy[:, 0] * 0.2) + rng.normal(0, 0.005, n)
    return np.column_stack([xy, z])


def _untiled(monkeypatch, pts, **kw):
    monkeypatch.setenv("PHYTOGRAPH_NORMALS_TILE_MIN_POINTS", "999999999")
    return normals.compute_normals(pts, **kw)


def _tiled(monkeypatch, pts, target=8000, meta=None, **kw):
    monkeypatch.setenv("PHYTOGRAPH_NORMALS_TILE_MIN_POINTS", "1000")
    monkeypatch.setenv("PHYTOGRAPH_NORMALS_TILE_TARGET_POINTS", str(target))
    return normals.compute_normals(pts, meta=meta, **kw)


def _angles(a, b):
    dot = np.einsum("ij,ij->i", a[:, 0:3].astype(np.float64),
                    b[:, 0:3].astype(np.float64))
    return np.degrees(np.arccos(np.clip(np.abs(dot), 0, 1))), dot


ORIGIN = [0.0, 0.0, 25.0]


@pytest.mark.parametrize("fixture,origin", [
    (_uniform, [0.0, 0.0, 25.0]),
    (_tls_density, [0.0, 0.0, 2.0]),
])
def test_tiled_matches_untiled(monkeypatch, fixture, origin):
    pts = fixture()
    kw = dict(k=30, orientation="origin", origin=origin)
    ref = _untiled(monkeypatch, pts, **kw)
    meta = {}
    got = _tiled(monkeypatch, pts, meta=meta, **kw)

    assert meta["tiled"] is True
    assert meta["tiles"] > 4, "fixture must actually be split into tiles"

    ang, dot = _angles(ref, got)
    assert (dot < 0).sum() == 0, "origin orientation must not flip across tiles"
    assert ang.max() < 0.1, f"seam error {ang.max():.4f} deg"
    # The derived scalars are functions of the same neighbourhood, so they must
    # agree too -- a collar that is right for the normal is right for these.
    assert np.abs(ref[:, 3] - got[:, 3]).max() < 1e-6
    assert np.abs(ref[:, 4] - got[:, 4]).max() < 0.1


def test_collar_multiple_is_sufficient(monkeypatch):
    """Sabotage guard: the CURRENT collar is clean, and a halved one is not.

    Without the second half, this suite would still pass if someone reduced
    `_COLLAR_MULTIPLE` to save memory -- the property would be untested rather
    than verified.
    """
    pts = _tls_density()
    kw = dict(k=30, orientation="origin", origin=[0.0, 0.0, 2.0])
    ref = _untiled(monkeypatch, pts, **kw)

    good = _tiled(monkeypatch, pts, **kw)
    ang_good, _ = _angles(ref, good)
    assert ang_good.max() < 0.1

    monkeypatch.setattr(normals, "_COLLAR_MULTIPLE", 0.25)
    bad = _tiled(monkeypatch, pts, **kw)
    ang_bad, _ = _angles(ref, bad)
    assert ang_bad.max() > ang_good.max() * 5, (
        "a quarter-width collar must visibly degrade the result; if this fails "
        "the seam test is not actually measuring the collar")


def test_per_point_origins_survive_tiling(monkeypatch):
    """The per-point-origin path drives tiles directly (the pool cannot gather a
    caller-indexed array), so it needs its own seam coverage."""
    pts = _uniform(n=60_000)
    origins = np.tile(np.array([0.0, 0.0, 25.0]), (len(pts), 1))
    kw = dict(k=30, orientation="origin")
    ref = _untiled(monkeypatch, pts, origin=origins, **kw)
    meta = {}
    got = _tiled(monkeypatch, pts, meta=meta, origin=origins, **kw)

    assert meta["tiled"] is True
    ang, dot = _angles(ref, got)
    assert (dot < 0).sum() == 0
    assert ang.max() < 0.1


def test_tiling_covers_every_point(monkeypatch):
    """A point missed by every tile keeps the `fill=0.0`, so |n| = 0 marks the
    gap. This checks tile COVERAGE only — a genuinely degenerate neighbourhood
    also yields |n| = 0 by design (see `_eigen_normals`'s degeneracy guard and
    its tests in test_normals.py), so the two are deliberately indistinguishable
    here. The fixture is a dense surface with no degenerate points, which is
    what makes a zero attributable to coverage."""
    pts = _tls_density()
    got = _tiled(monkeypatch, pts, k=30, orientation="origin",
                 origin=[0.0, 0.0, 2.0])
    norm = np.linalg.norm(got[:, 0:3].astype(np.float64), axis=1)
    assert (norm > 0.99).all(), "every point must receive a unit normal"


def test_pool_result_is_identical_to_in_process(monkeypatch):
    """The spawn pool is a separate code path (children memmap the points file
    and gather by index) and could diverge from the in-process one without any
    visible error. Setting PHYTOGRAPH_SEG_WORKER is what unlocks it."""
    pts = _tls_density(n=120_000)
    kw = dict(k=30, orientation="origin", origin=[0.0, 0.0, 2.0])

    serial_meta, pool_meta = {}, {}
    monkeypatch.delenv("PHYTOGRAPH_SEG_WORKER", raising=False)
    serial = _tiled(monkeypatch, pts, target=20_000, meta=serial_meta, **kw)

    monkeypatch.setenv("PHYTOGRAPH_SEG_WORKER", "1")
    pool = _tiled(monkeypatch, pts, target=20_000, meta=pool_meta, **kw)

    if pool_meta["workers"] <= 1:
        pytest.skip("pool not available on this machine")
    assert serial_meta["workers"] == 1
    np.testing.assert_array_equal(serial, pool)


@pytest.mark.parametrize("radius", [5.0, 50.0, 100.0])
def test_a_radius_larger_than_the_cloud_does_not_crash(monkeypatch, radius):
    """The panel accepts a radius up to 100 m. `auto_tile_size` clamps the tile
    to the cloud's extent, so a radius wider than the cloud made the collar
    exceed the tile and `TilePlan` raised "buffer_m must not exceed tile_m" —
    an opaque 500 naming two concepts the user never typed, and only above the
    4 M-point tiling threshold, i.e. exactly where it costs most."""
    pts = _uniform(n=40_000)          # spans ~40 m
    meta = {}
    got = _tiled(monkeypatch, pts, target=5_000, meta=meta,
                 k=20, radius=radius, orientation="up")
    assert meta["tiled"] is True
    assert meta["collar_m"] <= meta["tile_m"], "the collar must fit in a tile"
    assert (np.linalg.norm(got[:, 0:3].astype(np.float64), axis=1) > 0.99).all()


def test_a_clamped_collar_still_matches_the_untiled_result(monkeypatch):
    """Clamping must not trade a crash for a silently wrong answer."""
    pts = _uniform(n=40_000)
    kw = dict(k=20, radius=50.0, orientation="up")
    ref = _untiled(monkeypatch, pts, **kw)
    meta = {}
    got = _tiled(monkeypatch, pts, target=5_000, meta=meta, **kw)
    assert "collar_clamped_from" in meta, "this fixture must exercise the clamp"
    ang, dot = _angles(ref, got)
    assert (dot < 0).sum() == 0
    assert ang.max() < 0.1


def test_small_cloud_skips_tiling(monkeypatch):
    monkeypatch.delenv("PHYTOGRAPH_NORMALS_TILE_MIN_POINTS", raising=False)
    meta = {}
    normals.compute_normals(_uniform(n=5000), k=20, meta=meta)
    assert meta["tiled"] is False
    assert meta["workers"] == 1


def test_collar_is_measured_from_the_kth_neighbour_not_the_first(monkeypatch):
    """The collar must grow with k -- it has to contain the whole neighbourhood
    the estimator looks at, which the FIRST neighbour distance does not bound."""
    pts = _tls_density()
    small, large = {}, {}
    _tiled(monkeypatch, pts, k=10, meta=small, orientation="none")
    _tiled(monkeypatch, pts, k=60, meta=large, orientation="none")
    assert large["collar_m"] > small["collar_m"]
