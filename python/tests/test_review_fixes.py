"""Regressions for the Phase 1 review: intensity, transform after a filter,
import errors, multi-scan files, misses, and the private octree cache."""
from __future__ import annotations

import numpy as np
import pytest

import phytograph as pg
from conftest import E2E_FIXTURES, write_ptx


def _colored():
    rows = np.loadtxt(E2E_FIXTURES / "colored-intensity.xyz", comments="#")
    return rows


def test_intensity_is_a_column_and_filters_in_0_to_1(backend):
    rows = _colored()
    with backend.open(E2E_FIXTURES / "colored-intensity.xyz") as c:
        assert "intensity" in c.columns
        inten = c.column("intensity")
        assert inten.shape == (len(rows),)
        assert 0.0 <= inten.min() < inten.max() <= 1.0
        # Same value whether read alone or with everything else.
        np.testing.assert_array_equal(inten, c.to_numpy()["intensity"])

        cut = float(np.median(inten))
        expected = int((inten >= cut - 1e-6).sum())
        c.filter(where={"intensity": (cut, None)})
        assert len(c) == expected
        assert c.column("intensity").min() >= cut - 1e-4


def test_transform_after_a_filter_builds_no_octree(backend, forest_plot):
    with backend.open(forest_plot) as c:
        xyz = c.positions
        lo, hi = xyz.min(0), xyz.max(0)
        c.crop(lo - 1, [(lo[0] + hi[0]) / 2, hi[1] + 1, hi[2] + 1])
        kept = c.positions
        rot = np.array([[0, -1, 0, 0], [1, 0, 0, 0], [0, 0, 1, 0], [0, 0, 0, 1.0]])
        res = backend.transport.post_json(
            f"/api/cloud/session/{c.session_id}/transform",
            {"matrix": rot.ravel().tolist(), "octree_mode": "none"})
        assert res["octree_stale"] is True and res["cache_id"] is None
        np.testing.assert_allclose(c.positions, kept @ rot[:3, :3].T, atol=1e-6)
        # And the public method takes the same path.
        c.transform(rot)
        np.testing.assert_allclose(c.positions, kept @ (rot[:3, :3] @ rot[:3, :3]).T, atol=1e-6)


def test_unreadable_file_is_an_import_error_not_a_startup_error(backend, tmp_path):
    bad = tmp_path / "garbage.laz"
    bad.write_bytes(b"this is not a LAZ file" * 10)
    with pytest.raises(pg.PhytographError) as e:
        backend.open(bad)
    assert not isinstance(e.value, pg.BackendStartError)
    assert backend.health()["status"] == "healthy"


def test_multi_scan_ptx_is_one_cloud_per_position(backend, tmp_path):
    ptx = write_ptx(tmp_path / "two.ptx", [((0, 0, 0), None), ((100, 0, 0), None)])
    with pytest.raises(pg.PhytographError) as e:
        backend.open(ptx)
    assert "2 scan positions" in str(e.value)

    scans = backend.open_scans(ptx)
    try:
        assert len(scans) == 2
        centers = [s.positions.mean(0) for s in scans]
        # Each scan sits around its own scanner, 100 m apart — not merged.
        assert abs((centers[1] - centers[0])[0] - 100) < 1.0
        assert all(len(s) == 12 * 16 for s in scans)
    finally:
        for s in scans:
            s.close()

    with backend.open(ptx, scan_index=1) as one:
        assert len(one) == 12 * 16
        assert abs(one.positions.mean(0)[0] - centers[1][0]) < 1e-3


def test_misses_are_excluded_unless_asked_for(backend, tmp_path):
    miss = np.zeros((12, 16), bool)
    miss[5:8, :] = True   # 48 beams with no return, in interior rows so the importer
    #                      can recover their directions (edge rows past its
    #                      extrapolation budget are kept at the origin instead)
    ptx = write_ptx(tmp_path / "sky.ptx", [((0, 0, 0), miss)])
    with backend.open(ptx) as c:
        hits = 12 * 16 - 48
        assert len(c) == hits
        assert len(c.positions) == hits
        everything = c.to_numpy(include_misses=True)
        assert len(everything["positions"]) == 12 * 16
        # Misses sit far out along their beams, hits at 5 m.
        r = np.linalg.norm(everything["positions"], axis=1)
        assert (r > 100).sum() == 48 and np.allclose(np.sort(r)[:hits], 5, atol=1e-3)


def test_private_octree_cache_is_used_and_removed(scalars_xyz):
    be = pg.Backend(source="dev")
    work = be._work_dir
    try:
        be.open(scalars_xyz)
        octrees = work / "octrees"
        assert octrees.is_dir() and any(octrees.iterdir())
    finally:
        be.close()
    assert not work.exists()
