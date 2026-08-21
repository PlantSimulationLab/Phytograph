"""One session per scan position for multi-scan sources (PTX blocks, E57 scans).

A scan is defined by its pose. A multi-block PTX or multi-scan E57 holds several
genuinely separate acquisitions, and merging them into one cloud leaves a single
origin standing in for all of them — which silently breaks the LAD inversion (it
takes ONE scanner origin), centres the sky/miss display shell on the wrong point,
and makes the per-scan row/column rasters collide.

`_do_create_multi_cloud_session` fans out instead: each position gets its own
session, octree and ScanParameters. These assert the split is real — that scan 1
comes back with scan 1's pose and grid, not scan 0's.
"""

from pathlib import Path

import numpy as np
import pytest

import main

laspy = pytest.importorskip("laspy")

from tests.test_ptx_import import _write_ptx, _pose, _simple  # noqa: E402


@pytest.fixture(autouse=True)
def _clear_scan_meta():
    yield
    main._import_scan_meta.clear()
    main._ptx_block_index_cache.clear()


# Two blocks with DIFFERENT dimensions and poses — the real file's shape.
_B0 = dict(rows=20, cols=30, origin=(0.0, 0.0, 0.0), yaw=10.0)
_B1 = dict(rows=18, cols=26, origin=(50.0, 20.0, 1.0), yaw=-25.0)


def _two_block_ptx(path: Path) -> Path:
    z0, a0 = _simple(_B0["rows"], _B0["cols"])
    z1, a1 = _simple(_B1["rows"], _B1["cols"], zen_lo=70.0, zen_hi=100.0)
    m0 = np.zeros((_B0["rows"], _B0["cols"]), bool); m0[5:8, 6:9] = True
    m1 = np.zeros((_B1["rows"], _B1["cols"]), bool); m1[4:6, 3:7] = True
    return _write_ptx(
        path,
        dict(zen=z0, az=a0, rng=np.full((_B0["rows"], _B0["cols"]), 5.0),
             pose=_pose(yaw=_B0["yaw"], t=_B0["origin"]), miss_mask=m0),
        dict(zen=z1, az=a1, rng=np.full((_B1["rows"], _B1["cols"]), 5.0),
             pose=_pose(yaw=_B1["yaw"], t=_B1["origin"]), miss_mask=m1),
    )


def _one_block_ptx(path: Path) -> Path:
    z, a = _simple(12, 15)
    return _write_ptx(path, dict(zen=z, az=a, rng=np.full((12, 15), 5.0), pose=_pose()))


class TestScanCount:
    def test_counts_ptx_blocks(self, tmp_path):
        assert main._source_scan_count(_two_block_ptx(tmp_path / "m.ptx")) == 2
        assert main._source_scan_count(_one_block_ptx(tmp_path / "o.ptx")) == 1

    def test_single_scan_formats_count_one(self, tmp_path):
        xyz = tmp_path / "c.xyz"
        xyz.write_text("1 2 3\n4 5 6\n")
        assert main._source_scan_count(xyz) == 1

    def test_an_unreadable_file_counts_as_one(self, tmp_path):
        """A file we can't probe must import as a single scan — the behaviour
        before multi-scan existed — rather than raising out of the count."""
        bad = tmp_path / "bad.ptx"
        bad.write_text("not a ptx\n")
        assert main._source_scan_count(bad) == 1

    def test_the_block_index_is_cached_across_conversions(self, tmp_path, monkeypatch):
        """Converting each block separately would otherwise re-walk the whole
        file per block — 3 extra passes over 1.67 GB on the reference dataset."""
        src = _two_block_ptx(tmp_path / "m.ptx")
        main._ptx_block_index_cache.clear()
        calls = []
        real = main._ptx_index_blocks
        monkeypatch.setattr(main, "_ptx_index_blocks",
                            lambda p: (calls.append(p), real(p))[1])
        main._source_scan_count(src)
        main._ptx_to_las(src, tmp_path / "a.las", block_index=0)
        main._ptx_to_las(src, tmp_path / "b.las", block_index=1)
        assert len(calls) == 1, f"walked the file {len(calls)} times"

    def test_the_cache_is_invalidated_when_the_file_changes(self, tmp_path):
        src = _two_block_ptx(tmp_path / "m.ptx")
        assert main._source_scan_count(src) == 2
        _one_block_ptx(src)                      # same path, different content
        assert main._source_scan_count(src) == 1


class TestPerBlockConversion:
    def test_each_block_converts_with_its_own_pose_and_grid(self, tmp_path):
        src = _two_block_ptx(tmp_path / "m.ptx")
        seen = []
        for bi, spec in ((0, _B0), (1, _B1)):
            out = tmp_path / f"b{bi}.las"
            n, _, _ = main._ptx_to_las(src, out, block_index=bi)
            meta = main._import_scan_meta[str(out.resolve())]
            assert n == spec["rows"] * spec["cols"]
            np.testing.assert_allclose(meta["origin"], spec["origin"], atol=1e-6)
            assert meta["scan_params"]["n_theta"] == spec["rows"]
            assert meta["scan_params"]["n_phi"] == spec["cols"]
            # Only THIS block's origin is listed — not every block's.
            assert len(meta["scan_origins"]) == 1
            seen.append(meta["origin"])
        assert seen[0] != seen[1]

    def test_the_blocks_partition_the_merged_cloud(self, tmp_path):
        """Splitting must lose nothing: the two per-block point counts sum to the
        merged one."""
        src = _two_block_ptx(tmp_path / "m.ptx")
        merged, _, _ = main._ptx_to_las(src, tmp_path / "all.las")
        a, _, _ = main._ptx_to_las(src, tmp_path / "a.las", block_index=0)
        b, _, _ = main._ptx_to_las(src, tmp_path / "b.las", block_index=1)
        assert a + b == merged

    def test_misses_are_placed_against_their_own_origin(self, tmp_path):
        """The bug this whole split exists for: block 1's misses must radiate
        from block 1's scanner, not block 0's."""
        src = _two_block_ptx(tmp_path / "m.ptx")
        out = tmp_path / "b1.las"
        main._ptx_to_las(src, out, block_index=1)
        r = main._read_las_into_arrays(out)
        miss = r.extras[main._MISS_SLUG] != 0
        assert miss.any()
        d_own = np.linalg.norm(r.positions[miss] - np.asarray(_B1["origin"]), axis=1)
        np.testing.assert_allclose(d_own, main._MISS_GAP_DISTANCE, rtol=1e-5)

    def test_an_out_of_range_block_is_a_400(self, tmp_path):
        src = _two_block_ptx(tmp_path / "m.ptx")
        with pytest.raises(main.HTTPException) as e:
            main._ptx_to_las(src, tmp_path / "x.las", block_index=5)
        assert e.value.status_code == 400
        assert "has 2" in str(e.value.detail)


class TestMultiSessionEndpoint:
    def _fake_octree(self, tmp_path, monkeypatch, captured):
        def _build(las_path, extra_dims_meta, **kw):
            with laspy.open(str(las_path)) as rd:
                las = rd.read()
            captured.append(len(las.x))
            return f"cache{len(captured)}", tmp_path / "cache", {"point_count": len(las.x)}
        monkeypatch.setattr(main, "_build_octree_from_las", _build)

    def test_a_two_block_ptx_yields_two_sessions(self, tmp_path, monkeypatch):
        src = _two_block_ptx(tmp_path / "m.ptx")
        self._fake_octree(tmp_path, monkeypatch, [])
        res = main._do_create_multi_cloud_session(
            main.CloudSessionCreateRequest(source_path=str(src)), src)

        assert res["scan_count"] == 2
        assert len(res["scans"]) == 2
        ids = [s["session"]["session_id"] for s in res["scans"]]
        assert len(set(ids)) == 2, "the two positions share a session"

        for entry, spec in zip(res["scans"], (_B0, _B1)):
            sess_meta = entry["session"]
            np.testing.assert_allclose(sess_meta["scan_origin"], spec["origin"], atol=1e-5)
            assert sess_meta["scan_params"]["n_theta"] == spec["rows"]
            assert sess_meta["scan_params"]["n_phi"] == spec["cols"]
            assert sess_meta["has_misses"] is True
            # Each session holds only its own block's points.
            sess = main._cloud_sessions[sess_meta["session_id"]]
            assert len(sess.positions) == spec["rows"] * spec["cols"]

    def test_positions_get_distinct_names(self, tmp_path, monkeypatch):
        src = _two_block_ptx(tmp_path / "m.ptx")
        self._fake_octree(tmp_path, monkeypatch, [])
        res = main._do_create_multi_cloud_session(
            main.CloudSessionCreateRequest(source_path=str(src)), src)
        names = [s["name"] for s in res["scans"]]
        assert names == ["m — scan 1", "m — scan 2"]
        assert [s["scan_index"] for s in res["scans"]] == [0, 1]

    def test_a_single_scan_source_still_returns_a_one_element_list(self, tmp_path, monkeypatch):
        """One shape for the caller to handle, whatever the source."""
        src = _one_block_ptx(tmp_path / "o.ptx")
        self._fake_octree(tmp_path, monkeypatch, [])
        res = main._do_create_multi_cloud_session(
            main.CloudSessionCreateRequest(source_path=str(src)), src)
        assert res["scan_count"] == 1
        assert len(res["scans"]) == 1
        # The FULL basename, exactly as before multi-scan existed — this string
        # becomes the scan's label, so a stem here would rename every import.
        assert res["scans"][0]["name"] == "o.ptx"
        assert res["scans"][0]["session"]["point_count"] == 12 * 15

    def test_a_plain_xyz_goes_through_unchanged(self, tmp_path, monkeypatch):
        src = tmp_path / "c.xyz"
        src.write_text("\n".join(f"{i} {i+1} {i+2}" for i in range(20)) + "\n")
        self._fake_octree(tmp_path, monkeypatch, [])
        res = main._do_create_multi_cloud_session(
            main.CloudSessionCreateRequest(source_path=str(src)), src)
        assert res["scan_count"] == 1
        assert res["scans"][0]["session"]["point_count"] == 20

    def test_one_failing_position_does_not_sink_the_others(self, tmp_path, monkeypatch):
        src = _two_block_ptx(tmp_path / "m.ptx")
        calls = {"n": 0}

        def _build(las_path, extra_dims_meta, **kw):
            calls["n"] += 1
            if calls["n"] == 1:
                raise RuntimeError("octree build exploded")
            with laspy.open(str(las_path)) as rd:
                las = rd.read()
            return "cache", tmp_path / "cache", {"point_count": len(las.x)}

        monkeypatch.setattr(main, "_build_octree_from_las", _build)
        res = main._do_create_multi_cloud_session(
            main.CloudSessionCreateRequest(source_path=str(src)), src)
        assert "error" in res["scans"][0] and "session" not in res["scans"][0]
        assert "exploded" in res["scans"][0]["error"]
        assert "session" in res["scans"][1], "a later position was lost with the first"

    def test_progress_carries_the_counter_prefix(self, tmp_path, monkeypatch):
        """The renderer parses `[i/N]` out of these to drive its import counter."""
        src = _two_block_ptx(tmp_path / "m.ptx")
        self._fake_octree(tmp_path, monkeypatch, [])
        seen = []
        main._do_create_multi_cloud_session(
            main.CloudSessionCreateRequest(source_path=str(src)), src,
            progress=lambda f, m: seen.append(m))
        assert any(m.startswith("[1/2]") for m in seen), seen
        assert any(m.startswith("[2/2]") for m in seen), seen

    def test_each_position_advances_only_its_own_slice_of_the_bar(self, tmp_path, monkeypatch):
        """Position i's stages sweep [i/n, (i+1)/n], so the bar rises once across
        the whole import instead of rewinding to 0 for every position."""
        src = _two_block_ptx(tmp_path / "m.ptx")
        self._fake_octree(tmp_path, monkeypatch, [])
        seen = []
        main._do_create_multi_cloud_session(
            main.CloudSessionCreateRequest(source_path=str(src)), src,
            progress=lambda f, m: seen.append((f, m)))
        fr = [(f, m) for f, m in seen if f is not None]
        assert fr, "no fractional progress at all"
        assert all(0.0 <= f <= 0.5 + 1e-9 for f, m in fr if m.startswith("[1/2]")), fr
        assert all(0.5 - 1e-9 <= f <= 1.0 for f, m in fr if m.startswith("[2/2]")), fr
        # Monotone: never goes backwards.
        vals = [f for f, _ in fr]
        assert vals == sorted(vals), vals

    def test_a_single_scan_import_still_streams_its_stages(self, tmp_path, monkeypatch):
        """The regression this guards: suppressing the inner progress to stop N
        positions rewinding the bar left an ORDINARY single-scan import with no
        per-stage fraction at all, pinning its bar at 0% for the whole import."""
        src = _one_block_ptx(tmp_path / "o.ptx")
        self._fake_octree(tmp_path, monkeypatch, [])
        seen = []
        main._do_create_multi_cloud_session(
            main.CloudSessionCreateRequest(source_path=str(src)), src,
            progress=lambda f, m: seen.append((f, m)))
        mid = [f for f, _ in seen if f is not None and 0.0 < f < 1.0]
        assert len(mid) >= 3, f"only {len(mid)} intermediate fractions: {seen}"
        # And no [i/N] prefix to clutter a single-position import's messages.
        assert not any(m.startswith("[") for _, m in seen), seen

    def test_the_world_shift_is_shared_across_positions(self, tmp_path, monkeypatch):
        """Siblings must land in the same frame or they won't be co-located."""
        src = _two_block_ptx(tmp_path / "m.ptx")
        self._fake_octree(tmp_path, monkeypatch, [])
        res = main._do_create_multi_cloud_session(
            main.CloudSessionCreateRequest(source_path=str(src), world_shift=[10, 20, 30]), src)
        shifts = [s["session"]["world_shift"] for s in res["scans"]]
        assert shifts[0] == shifts[1] == [10.0, 20.0, 30.0]


class TestE57MultiScan:
    """E57 had the identical merge-everything behaviour, so it gets the same fix."""

    def _write_two_scan_e57(self, path: Path):
        pye57 = pytest.importorskip("pye57")
        e = pye57.E57(str(path), mode="w")
        for origin in ([0.0, 0.0, 0.0], [40.0, 10.0, 2.0]):
            n = 6
            ang = np.linspace(0.0, 0.6, n)
            data = {
                "cartesianX": np.ascontiguousarray(5.0 * np.cos(ang)),
                "cartesianY": np.ascontiguousarray(5.0 * np.sin(ang)),
                "cartesianZ": np.ascontiguousarray(np.zeros(n)),
                "cartesianInvalidState": np.ascontiguousarray(
                    np.array([0, 0, 0, 0, 1, 1], dtype=np.int8)),
            }
            # A miss needs a non-zero direction to be placeable (pye57 persists
            # only cartesian), so give the invalid cells a unit vector.
            for i in (4, 5):
                data["cartesianX"][i] = np.cos(ang[i])
                data["cartesianY"][i] = np.sin(ang[i])
            e.write_scan_raw(data, translation=np.asarray(origin, dtype=np.float64))
        e.close()
        return path

    def test_scan_count_and_per_scan_conversion(self, tmp_path):
        src = self._write_two_scan_e57(tmp_path / "two.e57")
        assert main._source_scan_count(src) == 2
        for si, origin in ((0, [0.0, 0.0, 0.0]), (1, [40.0, 10.0, 2.0])):
            out = tmp_path / f"s{si}.las"
            n, _ = main._e57_to_las(src, out, scan_index=si)
            meta = main._import_scan_meta[str(out.resolve())]
            assert n == 6
            np.testing.assert_allclose(meta["origin"], origin, atol=1e-6)
            assert len(meta["scan_origins"]) == 1

    def test_the_endpoint_splits_an_e57_into_two_sessions(self, tmp_path, monkeypatch):
        src = self._write_two_scan_e57(tmp_path / "two.e57")

        def _build(las_path, extra_dims_meta, **kw):
            with laspy.open(str(las_path)) as rd:
                las = rd.read()
            return "cache", tmp_path / "cache", {"point_count": len(las.x)}

        monkeypatch.setattr(main, "_build_octree_from_las", _build)
        res = main._do_create_multi_cloud_session(
            main.CloudSessionCreateRequest(source_path=str(src)), src)
        assert res["scan_count"] == 2
        origins = [s["session"]["scan_origin"] for s in res["scans"]]
        np.testing.assert_allclose(origins[0], [0.0, 0.0, 0.0], atol=1e-5)
        np.testing.assert_allclose(origins[1], [40.0, 10.0, 2.0], atol=1e-5)
        for s in res["scans"]:
            assert len(main._cloud_sessions[s["session"]["session_id"]].positions) == 6

    def test_an_out_of_range_scan_is_a_400(self, tmp_path):
        src = self._write_two_scan_e57(tmp_path / "two.e57")
        with pytest.raises(main.HTTPException) as e:
            main._e57_to_las(src, tmp_path / "x.las", scan_index=9)
        assert e.value.status_code == 400
