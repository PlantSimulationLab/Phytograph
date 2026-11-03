"""The scripting client against a live backend: import, read, edit, export."""
from __future__ import annotations

import numpy as np
import pytest

import phytograph as pg


def _file_xyz(path):
    return np.loadtxt(path, comments="#", usecols=(0, 1, 2))


def test_open_reads_every_point_in_world_coordinates(backend, forest_plot):
    expected = _file_xyz(forest_plot)
    with backend.open(forest_plot) as c:
        assert len(c) == len(expected)
        xyz = c.positions
        assert xyz.dtype == np.float64 and xyz.shape == expected.shape
        # Same points (ordering is the importer's): compare sorted bounds and sums.
        np.testing.assert_allclose(xyz.min(0), expected.min(0), atol=1e-3)
        np.testing.assert_allclose(xyz.max(0), expected.max(0), atol=1e-3)
        np.testing.assert_allclose(xyz.mean(0), expected.mean(0), atol=1e-3)


def test_world_shift_is_invisible_to_the_script(backend, forest_plot):
    """A cloud imported with a large global shift still reads, crops and
    exports in true world coordinates — the shift is the backend's business."""
    expected = _file_xyz(forest_plot)
    shift = [500_000.0, 4_200_000.0, 0.0]
    with backend.open(forest_plot, world_shift=shift) as c:
        np.testing.assert_allclose(c.world_shift, shift)
        np.testing.assert_allclose(c.positions.mean(0), expected.mean(0), atol=1e-3)

        lo, hi = expected.min(0), expected.max(0)
        mid_x = (lo[0] + hi[0]) / 2
        c.crop(lo - 1, [mid_x, hi[1] + 1, hi[2] + 1])
        kept = expected[expected[:, 0] <= mid_x]
        assert len(c) == len(kept)
        assert c.positions[:, 0].max() <= mid_x + 1e-6


def test_crop_invert_is_the_complement(backend, forest_plot):
    expected = _file_xyz(forest_plot)
    lo, hi = expected.min(0), expected.max(0)
    box = (lo - 1, [(lo[0] + hi[0]) / 2, hi[1] + 1, hi[2] + 1])
    with backend.open(forest_plot) as a, backend.open(forest_plot) as b:
        a.crop(*box)
        b.crop(*box, invert=True)
        assert len(a) + len(b) == len(expected)
        assert len(a) > 0 and len(b) > 0


def test_where_filter_and_columns_stay_row_aligned(backend, scalars_xyz):
    rows = np.loadtxt(scalars_xyz, skiprows=1)
    with backend.open(scalars_xyz) as c:
        slug = next(s for s in c.columns if s.lower() == "deviation")
        c.filter(where={slug: [1, 2]})
        keep = np.isin(rows[:, 4], [1, 2])
        data = c.to_numpy()
        assert len(data["positions"]) == int(keep.sum())
        # Each surviving point carries ITS OWN deviation value.
        order_file = np.lexsort(rows[keep, :3].T)
        order_cloud = np.lexsort(data["positions"].T)
        np.testing.assert_allclose(data["positions"][order_cloud], rows[keep, :3][order_file], atol=1e-3)
        np.testing.assert_array_equal(data[slug][order_cloud].astype(int),
                                      rows[keep, 4][order_file].astype(int))
        np.testing.assert_array_equal(c.column(slug), data[slug])


def test_extract_and_split_leave_the_parent_alone(backend, scalars_xyz):
    rows = np.loadtxt(scalars_xyz, skiprows=1)
    with backend.open(scalars_xyz) as c:
        slug = next(s for s in c.columns if s.lower() == "deviation")
        child = c.extract(where={slug: [3]})
        assert child is not None and len(child) == int((rows[:, 4] == 3).sum())
        assert len(c) == len(rows)
        child.close()

        parts = c.split(slug)  # 0 excluded by default
        assert sorted(parts) == [1, 2, 3]
        for v, part in parts.items():
            assert len(part) == int((rows[:, 4] == v).sum())
            assert set(np.unique(part.column(slug)).astype(int)) == {v}
            part.close()
        assert c.extract(where={slug: [42]}) is None


def test_transform_moves_points_in_world_frame(backend, forest_plot):
    with backend.open(forest_plot, world_shift=[1000.0, 0.0, 0.0]) as c:
        before = c.positions
        c.translate(1.5, -2.0, 0.25)
        np.testing.assert_allclose(c.positions, before + [1.5, -2.0, 0.25], atol=1e-6)

        theta = np.pi / 2
        rot = np.array([[np.cos(theta), -np.sin(theta), 0, 0],
                        [np.sin(theta), np.cos(theta), 0, 0],
                        [0, 0, 1, 0], [0, 0, 0, 1]])
        moved = c.positions
        c.transform(rot)
        np.testing.assert_allclose(c.positions, moved @ rot[:3, :3].T, atol=1e-6)


@pytest.mark.parametrize("suffix", [".laz", ".ply", ".csv"])
def test_export_round_trips(backend, scalars_xyz, tmp_path, suffix):
    with backend.open(scalars_xyz) as c:
        slug = next(s for s in c.columns if s.lower() == "deviation")
        c.filter(where={slug: (1, None)})
        n = len(c)
        out = tmp_path / f"out{suffix}"
        res = c.export(out)
        assert res["point_count"] == n and out.stat().st_size > 0
        with backend.open(out) as back:
            assert len(back) == n
            np.testing.assert_allclose(np.sort(back.positions, axis=0),
                                       np.sort(c.positions, axis=0), atol=1e-3)


def test_closed_cloud_is_gone(backend, scalars_xyz):
    c = backend.open(scalars_xyz)
    sid = c.session_id
    c.close()
    with pytest.raises(pg.PhytographError) as e:
        backend.cloud(sid).info()
    assert e.value.status == 404


def test_missing_file_is_a_clear_error(backend, tmp_path):
    with pytest.raises(pg.PhytographError) as e:
        backend.open(tmp_path / "nope.laz")
    assert e.value.status == 404 and "not found" in str(e.value).lower()
