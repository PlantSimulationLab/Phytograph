"""PTX scan export, and the export -> import round trip.

PTX is the first export format that needs scan GEOMETRY rather than just point
channels: it must emit a complete rectangular raster, so every one of
rows*cols cells is written, in column-major order, with a cell that has no
return recorded as the all-zero sentinel. That completeness is exactly the
property `_ptx_to_las` exploits to recover sky/miss points, which is why the
round-trip test at the bottom is the one that matters most.
"""

import base64
import math

import numpy as np
import pytest

import main


def _entry(points, *, n_theta=6, n_phi=8, origin=(0.0, 0.0, 0.0),
           scalar_columns=None, translation=None, columns=None,
           scan_pattern=None, session_id=None):
    return main.ScanExportEntry(
        origin=list(origin), n_theta=n_theta, n_phi=n_phi,
        theta_min=0, theta_max=180, phi_min=0, phi_max=360,
        points=[list(p) for p in points] if points is not None else None,
        scalar_columns=scalar_columns, columns=columns,
        translation=list(translation) if translation is not None else None,
        scan_pattern=scan_pattern, session_id=session_id)


def _grid_points(rows, cols, origin=(0.0, 0.0, 0.0), radius=5.0):
    """One point per cell of a rows x cols raster, on a sphere around `origin`,
    placed at the CENTRE of each angular bin so binning is unambiguous."""
    th = (np.arange(rows) + 0.5) / rows * 180.0
    ph = (np.arange(cols) + 0.5) / cols * 360.0
    T, P = np.meshgrid(np.radians(th), np.radians(ph), indexing="ij")
    # Helios phi is CW from +Y.
    x = radius * np.sin(T) * np.sin(P)
    y = radius * np.sin(T) * np.cos(P)
    z = radius * np.cos(T)
    pts = np.stack([x, y, z], axis=-1).reshape(-1, 3) + np.asarray(origin)
    rr, cc = np.meshgrid(np.arange(rows), np.arange(cols), indexing="ij")
    return pts, rr.ravel().astype(float), cc.ravel().astype(float)


def _export(scans, tmp_path=None, base="p", **kw):
    req = main.ScanExportRequest(
        scans=scans, base_name=base, include_misses=True, write_xml=False,
        data_format="ptx", dest_dir=str(tmp_path) if tmp_path else None, **kw)
    return main._do_scan_export(req)


def _text(res, i=0):
    f = res["files"][i]
    if f.get("written"):
        raise AssertionError("written to disk; read it from dest_dir instead")
    return base64.b64decode(f["data"]).decode()


def _lines(text):
    return text.rstrip("\n").split("\n")


class TestPtxGridShape:
    def test_writes_a_complete_grid_in_the_declared_dimensions(self):
        rows, cols = 6, 8
        pts, rr, cc = _grid_points(rows, cols)
        res = _export([_entry(pts, n_theta=rows, n_phi=cols,
                              scalar_columns={"row_index": list(rr),
                                              "column_index": list(cc)})])
        assert res["success"] is True, res.get("error")
        lines = _lines(_text(res))
        assert int(lines[0]) == cols and int(lines[1]) == rows
        assert len(lines) == 10 + rows * cols
        assert all(len(l.split()) == 4 for l in lines[10:])
        assert res["files"][0]["grid"]["source"] == "index"
        assert res["files"][0]["grid"]["filled"] == rows * cols

    def test_empty_cells_carry_the_zero_sentinel(self):
        rows, cols = 4, 5
        pts, rr, cc = _grid_points(rows, cols)
        keep = np.ones(rows * cols, bool)
        keep[[3, 7, 11]] = False           # three cells with no return
        res = _export([_entry(pts[keep], n_theta=rows, n_phi=cols,
                              scalar_columns={"row_index": list(rr[keep]),
                                              "column_index": list(cc[keep])})])
        body = _lines(_text(res))[10:]
        empty = [l for l in body if l.startswith("0.000000 0.000000 0.000000")]
        assert len(empty) == 3
        assert empty[0].split()[3] == f"{main._PTX_EMPTY_INTENSITY:.6f}"
        assert res["files"][0]["grid"]["filled"] == rows * cols - 3

    def test_cells_are_written_in_column_major_order(self):
        """The first `rows` data lines are column 0 — the ordering the importer
        depends on."""
        rows, cols = 3, 4
        pts, rr, cc = _grid_points(rows, cols)
        res = _export([_entry(pts, n_theta=rows, n_phi=cols,
                              scalar_columns={"row_index": list(rr),
                                              "column_index": list(cc)})])
        body = _lines(_text(res))[10:]
        xyz = np.array([[float(t) for t in l.split()[:3]] for l in body])
        # Cell k holds the point whose (row, col) is (k % rows, k // rows).
        for k in range(rows * cols):
            src = (k % rows) * cols + (k // rows)     # index into `pts`
            np.testing.assert_allclose(xyz[k], pts[src], atol=1e-5)


class TestPtxHeader:
    def test_identity_rotation_with_the_origin_as_translation(self):
        rows, cols = 3, 4
        origin = (12.0, -5.0, 2.5)
        pts, rr, cc = _grid_points(rows, cols, origin=origin)
        res = _export([_entry(pts, n_theta=rows, n_phi=cols, origin=origin,
                              scalar_columns={"row_index": list(rr),
                                              "column_index": list(cc)})])
        lines = _lines(_text(res))
        np.testing.assert_allclose([float(v) for v in lines[2].split()], origin, atol=1e-6)
        assert [l.split() for l in lines[3:6]] == [
            ["1.000000", "0.000000", "0.000000"],
            ["0.000000", "1.000000", "0.000000"],
            ["0.000000", "0.000000", "1.000000"]]
        assert lines[9].split()[3] == "1.000000"     # translation in the LAST row
        np.testing.assert_allclose([float(v) for v in lines[9].split()[:3]], origin, atol=1e-6)

    def test_points_are_local_and_add_back_to_world(self):
        rows, cols = 3, 4
        origin = (100.0, 200.0, 3.0)
        pts, rr, cc = _grid_points(rows, cols, origin=origin)
        res = _export([_entry(pts, n_theta=rows, n_phi=cols, origin=origin,
                              scalar_columns={"row_index": list(rr),
                                              "column_index": list(cc)})])
        body = _lines(_text(res))[10:]
        local = np.array([[float(t) for t in l.split()[:3]] for l in body])
        # Every written coordinate is small (local), and local + origin is world.
        assert np.abs(local).max() < 10.0
        assert np.abs(np.linalg.norm(local, axis=1) - 5.0).max() < 1e-5

    def test_translation_moves_the_scanner_with_its_cloud(self):
        rows, cols = 3, 4
        pts, rr, cc = _grid_points(rows, cols)
        cols_ = {"row_index": list(rr), "column_index": list(cc)}
        a = _lines(_text(_export([_entry(pts, n_theta=rows, n_phi=cols,
                                         scalar_columns=cols_)])))
        b = _lines(_text(_export([_entry(pts, n_theta=rows, n_phi=cols,
                                         scalar_columns=cols_,
                                         translation=[10, 20, 30])])))
        np.testing.assert_allclose([float(v) for v in b[2].split()],
                                   [10.0, 20.0, 30.0], atol=1e-6)
        # Points are scanner-local, so the data block is untouched by the move.
        assert a[10:] == b[10:]


class TestPtxWorldShift:
    def test_the_shift_lands_in_the_header_and_nowhere_else(self, monkeypatch):
        """The point block is shift-invariant — local = (world-shift)-(origin-shift)
        — so restoring the true registered pose touches lines 3 and 10 only."""
        import time
        rows, cols = 3, 4
        pts, rr, cc = _grid_points(rows, cols)
        shift = np.array([512000.0, 4210000.0, 100.0])
        n = pts.shape[0]
        sess = main.CloudSession(
            session_id="ptx_ws", source_path="<test>", ascii_format=None,
            column_plan=None, positions=pts.copy(), colors=None, intensity=None,
            extras={"row_index": rr.astype(np.float32),
                    "column_index": cc.astype(np.float32)},
            extra_dims_meta=[], deleted=np.zeros(n, bool), deleted_history=[],
            octree_cache_id=None, created_at=time.time(), world_shift=shift)
        main._cloud_sessions[sess.session_id] = sess
        try:
            shifted = _lines(_text(_export([_entry(
                None, n_theta=rows, n_phi=cols, session_id=sess.session_id)])))
            sess.world_shift = None
            plain = _lines(_text(_export([_entry(
                None, n_theta=rows, n_phi=cols, session_id=sess.session_id)])))
        finally:
            main._cloud_sessions.pop(sess.session_id, None)
        np.testing.assert_allclose([float(v) for v in shifted[2].split()],
                                   shift, atol=1e-6)
        np.testing.assert_allclose([float(v) for v in plain[2].split()],
                                   [0, 0, 0], atol=1e-6)
        assert shifted[10:] == plain[10:], "the point block must be shift-invariant"


    def test_a_scanner_away_from_the_stored_origin_keeps_its_true_radii(self):
        """The regression the shift-invariance test above cannot see.

        That test puts the scanner at (0,0,0), where the STORED origin the
        writer needs and the WORLD origin the renderer used to send are the
        same three zeros -- so `local = xyz - origin` is right either way and
        the header's `origin + shift` reads correctly by accident. Move the
        scanner off zero and the two frames separate: a WORLD-frame origin on
        a georeferenced cloud made `local` wrong by the whole shift (radii in
        thousands of km instead of metres) and double-shifted the header pose.

        Points are built 5 m around a scanner that sits at `local_origin` in
        the session's STORED frame, so the true local radius is exactly 5 m
        and the true registered pose is `local_origin + shift`.
        """
        import time
        rows, cols = 3, 4
        shift = np.array([512000.0, 4210000.0, 100.0])
        local_origin = np.array([7.0, -3.0, 2.0])
        pts, rr, cc = _grid_points(rows, cols, origin=tuple(local_origin), radius=5.0)
        n = pts.shape[0]
        sess = main.CloudSession(
            session_id="ptx_off_origin", source_path="<test>", ascii_format=None,
            column_plan=None, positions=pts.copy(), colors=None, intensity=None,
            extras={"row_index": rr.astype(np.float32),
                    "column_index": cc.astype(np.float32)},
            extra_dims_meta=[], deleted=np.zeros(n, bool), deleted_history=[],
            octree_cache_id=None, created_at=time.time(), world_shift=shift)
        main._cloud_sessions[sess.session_id] = sess
        try:
            lines = _lines(_text(_export([_entry(
                None, n_theta=rows, n_phi=cols, origin=tuple(local_origin),
                session_id=sess.session_id)])))
        finally:
            main._cloud_sessions.pop(sess.session_id, None)

        # Header pose: the scanner's true WORLD position, shifted back exactly
        # once. A double shift would read local_origin + 2*shift.
        np.testing.assert_allclose([float(v) for v in lines[2].split()],
                                   local_origin + shift, atol=1e-6)
        # Every written return is 5 m from the scanner, in scanner-local coords.
        xyz = np.array([[float(v) for v in l.split()[:3]] for l in lines[10:]])
        placed = xyz[np.any(xyz != 0.0, axis=1)]
        assert placed.shape[0] == rows * cols, "every cell should carry a return"
        np.testing.assert_allclose(np.linalg.norm(placed, axis=1), 5.0, atol=1e-6)


class TestPtxCellAssignment:
    def test_indices_beat_contradicting_angles(self):
        """Instrument indices are ground truth; deliberately wrong angles must
        not move a point that carries a row/column."""
        rows, cols = 3, 4
        pts, rr, cc = _grid_points(rows, cols)
        shuffled_r = (rr[::-1]).copy()
        res = _export([_entry(pts, n_theta=rows, n_phi=cols,
                              scalar_columns={"row_index": list(shuffled_r),
                                              "column_index": list(cc[::-1])})])
        assert res["files"][0]["grid"]["source"] == "index"

    def test_angular_binning_when_there_are_no_indices(self):
        rows, cols = 4, 6
        pts, _, _ = _grid_points(rows, cols)
        res = _export([_entry(pts, n_theta=rows, n_phi=cols)])
        g = res["files"][0]["grid"]
        assert g["source"] == "angles"
        # Points sit at bin centres, so every one lands in its own cell.
        assert g["filled"] == rows * cols and g["collapsed"] == 0

    def test_minus_one_sentinels_are_unplaced_not_crashed(self):
        rows, cols = 3, 4
        pts, rr, cc = _grid_points(rows, cols)
        rr = rr.copy(); cc = cc.copy()
        rr[5] = -1.0
        cc[5] = -1.0
        res = _export([_entry(pts, n_theta=rows, n_phi=cols,
                              scalar_columns={"row_index": list(rr),
                                              "column_index": list(cc)})])
        g = res["files"][0]["grid"]
        assert g["unplaced"] == 1 and g["filled"] == rows * cols - 1

    def test_indices_are_rebased_only_when_they_overflow_the_grid(self):
        rows, cols = 4, 5
        pts, rr, cc = _grid_points(rows, cols)
        # Overflowing: rows 100..103 with n_theta=4 -> rebased to 0..3.
        over = _export([_entry(pts, n_theta=rows, n_phi=cols,
                               scalar_columns={"row_index": list(rr + 100),
                                               "column_index": list(cc)})])
        assert over["files"][0]["grid"]["rows"] == rows
        # Cropped: rows 0..3 of a declared 20 stay where they are.
        crop = _export([_entry(pts, n_theta=20, n_phi=cols,
                               scalar_columns={"row_index": list(rr),
                                               "column_index": list(cc)})])
        assert crop["files"][0]["grid"]["rows"] == 20
        assert crop["files"][0]["grid"]["cells"] == 20 * cols

    def test_the_grid_grows_to_observed_indices(self):
        rows, cols = 4, 5
        pts, rr, cc = _grid_points(rows, cols)
        rr = rr.copy()
        rr[0] = 9.0                     # beyond the declared 4, and not a rebase
        res = _export([_entry(pts, n_theta=rows, n_phi=cols,
                              scalar_columns={"row_index": list(rr),
                                              "column_index": list(cc)})])
        assert res["files"][0]["grid"]["rows"] == 10

    def test_a_cell_collision_keeps_the_first_return(self):
        rows, cols = 2, 2
        pts, rr, cc = _grid_points(rows, cols)
        # Duplicate cell (0,0): a first and a second return on the same beam.
        pts2 = np.vstack([pts, pts[0] * 2.0])
        rr2 = np.append(rr, 0.0)
        cc2 = np.append(cc, 0.0)
        res = _export([_entry(pts2, n_theta=rows, n_phi=cols,
                              scalar_columns={"row_index": list(rr2),
                                              "column_index": list(cc2),
                                              "target_index": [1, 1, 1, 1, 2]})])
        g = res["files"][0]["grid"]
        assert g["collapsed"] == 1 and g["filled"] == rows * cols
        first = _lines(_text(res))[10]
        np.testing.assert_allclose([float(t) for t in first.split()[:3]],
                                   pts[0], atol=1e-5)

    def test_out_of_range_angles_are_dropped_not_clamped(self):
        rows, cols = 3, 4
        pts, _, _ = _grid_points(rows, cols)
        # One point AT the scanner: zero range, so it has no direction at all.
        pts2 = np.vstack([pts, [0.0, 0.0, 0.0]])
        res = _export([_entry(pts2, n_theta=rows, n_phi=cols)])
        g = res["files"][0]["grid"]
        assert g["unplaced"] == 1
        assert g["filled"] == rows * cols     # nothing piled into an edge cell


class TestPtxChannels:
    def test_colour_writes_seven_columns_and_empty_cells_stay_black(self):
        rows, cols = 2, 3
        pts, rr, cc = _grid_points(rows, cols)
        keep = np.ones(rows * cols, bool)
        keep[1] = False
        res = _export([_entry(pts[keep], n_theta=rows, n_phi=cols,
                              scalar_columns={"row_index": list(rr[keep]),
                                              "column_index": list(cc[keep]),
                                              "r": [1.0] * int(keep.sum()),
                                              "g": [0.5] * int(keep.sum()),
                                              "b": [0.0] * int(keep.sum())})])
        body = _lines(_text(res))[10:]
        assert all(len(l.split()) == 7 for l in body)
        filled = [l for l in body if not l.startswith("0.000000 0.000000 0.000000")]
        assert filled[0].split()[4:] == ["255", "128", "0"]
        empty = [l for l in body if l.startswith("0.000000 0.000000 0.000000")]
        assert empty[0].split()[4:] == ["0", "0", "0"]

    def test_intensity_is_normalised_into_the_unit_range(self):
        rows, cols = 2, 3
        pts, rr, cc = _grid_points(rows, cols)
        inten = [0.0, 16383.0, 32767.0, 49151.0, 65535.0, 100.0]
        res = _export([_entry(pts, n_theta=rows, n_phi=cols,
                              scalar_columns={"row_index": list(rr),
                                              "column_index": list(cc),
                                              "intensity": inten})])
        body = _lines(_text(res))[10:]
        vals = np.array([float(l.split()[3]) for l in body])
        assert vals.min() >= 0.0 and vals.max() <= 1.0
        assert abs(vals.max() - 1.0) < 1e-6

    def test_the_column_picker_is_ignored(self):
        """PTX has a fixed schema, so a `columns` list that drops the raster
        indices must not change what gets written."""
        rows, cols = 3, 4
        pts, rr, cc = _grid_points(rows, cols)
        sc = {"row_index": list(rr), "column_index": list(cc)}
        a = _text(_export([_entry(pts, n_theta=rows, n_phi=cols, scalar_columns=sc)]))
        b = _text(_export([_entry(pts, n_theta=rows, n_phi=cols, scalar_columns=sc,
                                  columns=["x", "y", "z"])]))
        assert a == b

    def test_include_misses_makes_no_difference_to_the_bytes(self):
        """PTX writes every cell either way: an excluded miss is just an empty
        cell, which is the same sentinel a real miss row would collapse to."""
        rows, cols = 3, 4
        pts, rr, cc = _grid_points(rows, cols)
        miss = np.zeros(rows * cols)
        miss[[2, 6]] = 1.0
        sc = {"row_index": list(rr), "column_index": list(cc), "is_miss": list(miss)}
        out = []
        for flag in (True, False):
            req = main.ScanExportRequest(
                scans=[_entry(pts, n_theta=rows, n_phi=cols, scalar_columns=sc)],
                base_name="m", include_misses=flag, write_xml=False, data_format="ptx")
            out.append(_text(main._do_scan_export(req)))
        assert out[0] == out[1]


class TestPtxRefusals:
    def test_a_scan_with_no_grid_is_refused(self):
        pts, _, _ = _grid_points(2, 2)
        res = _export([_entry(pts, n_theta=None, n_phi=None)])
        assert res["success"] is False
        assert "grid" in res["error"].lower()

    def test_a_non_raster_pattern_is_refused(self):
        pts, _, _ = _grid_points(2, 2)
        res = _export([_entry(pts, scan_pattern="risley_prism")])
        assert res["success"] is False
        assert "risley_prism" in res["error"]

    def test_an_enormous_raster_is_refused_without_a_destination(self):
        pts, _, _ = _grid_points(2, 2)
        res = _export([_entry(pts, n_theta=3000, n_phi=3000)])
        assert res["success"] is False
        assert "destination folder" in res["error"]


class TestPtxToDisk:
    def test_streams_the_full_grid_and_leaves_no_part_file(self, tmp_path):
        rows, cols = 40, 60
        pts, rr, cc = _grid_points(rows, cols)
        res = _export([_entry(pts, n_theta=rows, n_phi=cols,
                              scalar_columns={"row_index": list(rr),
                                              "column_index": list(cc)})],
                      tmp_path=tmp_path)
        assert res["success"] is True, res.get("error")
        f = res["files"][0]
        assert f["written"] is True and f["data"] is None
        written = tmp_path / f["name"]
        assert written.stat().st_size == f["bytes"] > 0
        assert len(written.read_text().rstrip("\n").split("\n")) == 10 + rows * cols
        assert not any(p.suffix == ".part" for p in tmp_path.iterdir())

    def test_chunking_does_not_change_the_bytes(self, tmp_path, monkeypatch):
        rows, cols = 20, 30
        pts, rr, cc = _grid_points(rows, cols)
        sc = {"row_index": list(rr), "column_index": list(cc)}
        one = _text(_export([_entry(pts, n_theta=rows, n_phi=cols, scalar_columns=sc)]))
        monkeypatch.setattr(main, "_PTX_EXPORT_CHUNK_CELLS", 7)
        many = _text(_export([_entry(pts, n_theta=rows, n_phi=cols, scalar_columns=sc)]))
        assert one == many


class TestPtxRoundTrip:
    def test_export_then_import_preserves_the_raster(self, tmp_path):
        """The whole point of the format: what we write, we can read back — with
        the empty cells coming home as flagged, placed sky/miss points."""
        laspy = pytest.importorskip("laspy")
        rows, cols = 12, 18
        origin = (3.0, -2.0, 1.5)
        pts, rr, cc = _grid_points(rows, cols, origin=origin, radius=7.0)
        keep = np.ones(rows * cols, bool)
        keep[[10, 11, 12, 40, 41]] = False          # 5 cells with no return
        inten = np.linspace(0.0, 1.0, int(keep.sum()))
        res = _export([_entry(pts[keep], n_theta=rows, n_phi=cols, origin=origin,
                              scalar_columns={"row_index": list(rr[keep]),
                                              "column_index": list(cc[keep]),
                                              "intensity": list(inten)})],
                      tmp_path=tmp_path, base="rt")
        assert res["success"] is True, res.get("error")
        ptx = tmp_path / res["files"][0]["name"]
        las = tmp_path / "rt.las"
        n, extra_dims, full_xyz = main._ptx_to_las(ptx, las)
        try:
            assert n == rows * cols                 # every cell survives
            r = main._read_las_into_arrays(las)
            miss = r.extras[main._MISS_SLUG] != 0
            assert int(miss.sum()) == int((~keep).sum())

            # The flagged cells are EXACTLY the ones that were empty.
            got = {(int(a), int(b)) for a, b in
                   zip(r.extras["row_index"][miss], r.extras["column_index"][miss])}
            assert got == {(int(rr[i]), int(cc[i])) for i in np.flatnonzero(~keep)}

            # Hit coordinates and the pose survive.
            hit_rc = {(int(a), int(b)): i for i, (a, b) in enumerate(
                zip(r.extras["row_index"], r.extras["column_index"])) if not miss[i]}
            for i in np.flatnonzero(keep):
                j = hit_rc[(int(rr[i]), int(cc[i]))]
                np.testing.assert_allclose(full_xyz[j], pts[i], atol=2e-5)

            meta = main._import_scan_meta[str(las.resolve())]
            np.testing.assert_allclose(meta["origin"], origin, atol=1e-6)
            assert meta["scan_params"]["n_theta"] == rows
            assert meta["scan_params"]["n_phi"] == cols
            # And the recovered misses got real directions, not a park at origin.
            assert meta["unplaceable_miss_count"] == 0
            d = r.positions[miss] - np.asarray(origin)
            np.testing.assert_allclose(np.linalg.norm(d, axis=1),
                                       main._MISS_GAP_DISTANCE, rtol=1e-5)
        finally:
            main._import_scan_meta.clear()

    def test_intensity_survives_the_round_trip(self, tmp_path):
        pytest.importorskip("laspy")
        rows, cols = 8, 10
        pts, rr, cc = _grid_points(rows, cols)
        inten = np.linspace(0.0, 1.0, rows * cols)
        res = _export([_entry(pts, n_theta=rows, n_phi=cols,
                              scalar_columns={"row_index": list(rr),
                                              "column_index": list(cc),
                                              "intensity": list(inten)})],
                      tmp_path=tmp_path, base="ri")
        las = tmp_path / "ri.las"
        try:
            main._ptx_to_las(tmp_path / res["files"][0]["name"], las)
            r = main._read_las_into_arrays(las)
            back = np.asarray(r.intensity, np.float64) / 65535.0
            order = np.lexsort((r.extras["row_index"], r.extras["column_index"]))
            # Written column-major, so sorting by (col, row) restores that order.
            expect = inten.reshape(rows, cols).T.ravel()
            np.testing.assert_allclose(back[order], expect, atol=2e-4)
        finally:
            main._import_scan_meta.clear()
