"""Backend.from_numpy: a cloud from arrays, then the same tools as any import."""
from __future__ import annotations

import numpy as np
import pytest

import phytograph as pg


def _plane_and_post(n_ground=6000, n_post=1500, seed=0):
    """A 10 m x 10 m tilted plane plus a vertical 0.2 m-wide post at (5, 5)."""
    rng = np.random.default_rng(seed)
    xy = rng.uniform(0, 10, size=(n_ground, 2))
    ground = np.column_stack([xy, 50 + 0.1 * xy[:, 0]])
    ang = rng.uniform(0, 2 * np.pi, n_post)
    z = rng.uniform(0, 4, n_post)
    post = np.column_stack([5 + 0.1 * np.cos(ang), 5 + 0.1 * np.sin(ang), 50.5 + z])
    return np.vstack([ground, post]), n_ground


def test_round_trip_keeps_every_array(backend):
    xyz, _ = _plane_and_post()
    n = len(xyz)
    rng = np.random.default_rng(1)
    colors = rng.integers(0, 256, size=(n, 3), dtype=np.uint8)
    inten = rng.uniform(0, 1, n).astype(np.float32)
    ts = 1.4e9 + np.arange(n) * 1e-5            # needs float64 to survive
    label = rng.integers(0, 5, n).astype(np.int32)
    with backend.from_numpy(xyz, colors=colors, intensity=inten, timestamp=ts,
                            columns={"label": label}) as c:
        assert len(c) == n
        assert {"label", "intensity", "timestamp"} <= set(c.columns)
        d = c.to_numpy()
        np.testing.assert_array_equal(d["positions"], xyz)
        np.testing.assert_allclose(d["colors"], colors / 255.0, atol=1 / 65535)
        np.testing.assert_allclose(d["intensity"], inten, atol=1 / 65535)
        np.testing.assert_array_equal(d["timestamp"], ts)
        np.testing.assert_array_equal(d["label"].astype(int), label)


def test_world_shift_is_invisible(backend):
    xyz, _ = _plane_and_post()
    utm = xyz + [612_000.0, 4_270_000.0, 0.0]
    with backend.from_numpy(utm, world_shift=[612_000, 4_270_000, 0]) as c:
        np.testing.assert_allclose(c.world_shift, [612_000, 4_270_000, 0])
        np.testing.assert_allclose(c.positions, utm, atol=1e-6)
        c.crop([612_000, 4_270_000, 0], [612_005, 4_270_010, 100])
        assert c.positions[:, 0].max() <= 612_005 + 1e-6


def test_misses_column_marks_misses(backend):
    xyz, _ = _plane_and_post()
    far = np.array([[0, 0, 1000.0], [10, 10, 1000.0]])
    pts = np.vstack([xyz, far])
    miss = np.r_[np.zeros(len(xyz), np.uint8), np.ones(2, np.uint8)]
    with backend.from_numpy(pts, columns={"is_miss": miss}) as c:
        assert len(c) == len(xyz)
        assert len(c.to_numpy(include_misses=True)["positions"]) == len(pts)
        # The tools see hits only: the seeded extent is the 10 m plot, not 1 km.
        assert max(c.defaults()["robust_extent"]) < 20


def test_tools_run_on_an_array_cloud(backend):
    xyz, n_ground = _plane_and_post()
    with backend.from_numpy(xyz) as c:
        c.segment_ground()
        cls = c.column("ground_class")
        is_ground_truth = np.arange(len(xyz)) < n_ground
        # Rows keep their order, so the labels line up with the input arrays.
        assert np.mean(cls[is_ground_truth] == pg.GROUND) > 0.97
        post_upper = ~is_ground_truth & (xyz[:, 2] > 51)
        assert np.mean(cls[post_upper] == pg.NON_GROUND) > 0.99


@pytest.mark.parametrize("bad, message", [
    (dict(positions=np.zeros((5, 2))), "positions"),
    (dict(positions=np.array([[0, 0, np.nan]] * 3)), "NaN"),
    (dict(positions=np.zeros((5, 3)), columns={"x y": np.zeros(5)}), "not allowed"),
    (dict(positions=np.zeros((5, 3)), columns={"short": np.zeros(4)}), "shape"),
])
def test_bad_arrays_are_refused_with_a_reason(backend, bad, message):
    with pytest.raises(pg.PhytographError) as e:
        backend.from_numpy(**bad)
    assert e.value.status == 400 and message in str(e.value)
