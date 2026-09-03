"""Structured E57 scan export, and the export -> import round trip.

Two properties separate this writer from the flat one it replaced:

  * **Misses are FLAGGED**, via E57's native `cartesianInvalidState` — the same
    field `_e57_to_las` reads on import. Before this, an included miss shipped as
    an ordinary point ~1 km out with nothing marking it, so re-importing our own
    export read the miss shell as genuine returns and inflated the cloud extent
    ~1000x. The round-trip tests are the ones that pin it.
  * **The file is STRUCTURED** whenever the scan can be gridded at all —
    `rowIndex`/`columnIndex` from `_scan_grid_cells`, which grids either from
    instrument indices (PTX / structured-E57 imports) or by angular binning
    against the declared sweep (RIEGL projects, synthetic Helios scans).

Unlike PTX, E57 keeps every echo of a multi-return cell and writes points in the
scanner-local frame with the pose in the header, so the world-coordinate round
trip is asserted explicitly.
"""

import base64

import numpy as np
import pytest

import main

pye57 = pytest.importorskip("pye57")


def _entry(points, *, n_theta=6, n_phi=8, origin=(0.0, 0.0, 0.0),
           scalar_columns=None, translation=None, columns=None,
           scan_pattern=None):
    return main.ScanExportEntry(
        origin=list(origin), n_theta=n_theta, n_phi=n_phi,
        theta_min=0, theta_max=180, phi_min=0, phi_max=360,
        points=[list(p) for p in points] if points is not None else None,
        scalar_columns=scalar_columns, columns=columns,
        translation=list(translation) if translation is not None else None,
        scan_pattern=scan_pattern)


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


def _export(scans, tmp_path=None, base="e", include_misses=True, **kw):
    req = main.ScanExportRequest(
        scans=scans, base_name=base, include_misses=include_misses,
        write_xml=False, data_format="e57",
        dest_dir=str(tmp_path) if tmp_path else None, **kw)
    return main._do_scan_export(req)


def _read(res, tmp_path, i=0):
    """Open the exported E57 and return (raw scan dict, header fields, stats).

    The header is copied into a plain dict rather than returned live: pye57's
    ScanHeader holds a WEAK reference into the open file, so touching it after
    the file closes raises `bad_weak_ptr`.
    """
    f = res["files"][i]
    path = tmp_path / f["name"]
    if not f.get("written"):
        path.write_bytes(base64.b64decode(f["data"]))
    rd = pye57.E57(str(path))
    try:
        raw = rd.read_scan_raw(0)
        h = rd.get_header(0)
        header = {"translation": np.asarray(h.translation, dtype=float).copy()}
        try:
            ib = h["indexBounds"]
            header["index_bounds"] = {
                k: int(ib[k].value()) for k in
                ("rowMinimum", "rowMaximum", "columnMinimum", "columnMaximum")}
        except Exception:
            header["index_bounds"] = None
        return raw, header, f.get("grid")
    finally:
        rd.close()


class TestStructuredGrid:
    """rowIndex/columnIndex are written whenever the scan can be gridded."""

    def test_grid_from_instrument_indices_is_exact(self, tmp_path):
        """A cloud carrying row_index/column_index (a PTX or structured-E57
        import) writes those indices through verbatim — no re-derivation."""
        rows, cols = 6, 8
        pts, rr, cc = _grid_points(rows, cols)
        # Shuffle so a pass-through can't be faked by the natural point order.
        rng = np.random.default_rng(0)
        perm = rng.permutation(len(pts))
        pts, rr, cc = pts[perm], rr[perm], cc[perm]
        res = _export([_entry(pts, n_theta=rows, n_phi=cols,
                              scalar_columns={"row_index": list(rr),
                                              "column_index": list(cc)})],
                      tmp_path)
        assert res["success"] is True, res.get("error")
        raw, _, stats = _read(res, tmp_path)
        assert stats["structured"] is True
        assert stats["source"] == "index"
        assert np.array_equal(np.asarray(raw["rowIndex"]), rr.astype(np.uint16))
        assert np.array_equal(np.asarray(raw["columnIndex"]), cc.astype(np.uint16))

    def test_grid_from_angular_binning_when_no_indices(self, tmp_path):
        """The RIEGL / synthetic-Helios shape: no per-point raster address, but a
        declared Ntheta x Nphi sweep to bin against. This is the path that lets a
        .riproject import export as a structured file at all."""
        rows, cols = 6, 8
        pts, rr, cc = _grid_points(rows, cols)
        res = _export([_entry(pts, n_theta=rows, n_phi=cols)], tmp_path)
        raw, _, stats = _read(res, tmp_path)
        assert stats["structured"] is True
        assert stats["source"] == "angles"
        # Points were built at bin centres, so binning must recover their cells.
        assert np.array_equal(np.asarray(raw["rowIndex"]), rr.astype(np.uint16))
        assert np.array_equal(np.asarray(raw["columnIndex"]), cc.astype(np.uint16))

    def test_index_bounds_reflect_the_real_grid(self, tmp_path):
        """pye57 derives indexBounds from the row/column min/max. A flat write
        leaves a degenerate one (columnMaximum 0) that `_e57_scan_params`
        deliberately distrusts — so this is what makes the grid resolution
        recoverable on import."""
        rows, cols = 6, 8
        pts, _, _ = _grid_points(rows, cols)
        res = _export([_entry(pts, n_theta=rows, n_phi=cols)], tmp_path)
        _, header, _ = _read(res, tmp_path)
        ib = header["index_bounds"]
        assert ib is not None and ib["rowMaximum"] == rows - 1
        assert ib["columnMaximum"] == cols - 1

    def test_multi_return_cell_keeps_every_echo(self, tmp_path):
        """The deliberate divergence from PTX: PTX stores one sample per cell and
        must collapse, but E57's indexBounds carries returnMinimum/Maximum, so a
        second return in a cell is kept rather than dropped."""
        rows, cols = 6, 8
        pts, rr, cc = _grid_points(rows, cols)
        # Duplicate the first cell's point at a different range, same (row, col).
        dup = pts[:1] * 0.5
        pts2 = np.vstack([pts, dup])
        rr2 = np.append(rr, rr[0])
        cc2 = np.append(cc, cc[0])
        res = _export([_entry(pts2, n_theta=rows, n_phi=cols,
                              scalar_columns={"row_index": list(rr2),
                                              "column_index": list(cc2)})],
                      tmp_path)
        raw, _, stats = _read(res, tmp_path)
        assert stats["structured"] is True
        assert len(raw["cartesianX"]) == len(pts2), "an echo was collapsed away"
        both = [(int(r), int(c)) for r, c in
                zip(np.asarray(raw["rowIndex"]), np.asarray(raw["columnIndex"]))]
        assert both.count((int(rr[0]), int(cc[0]))) == 2

    def test_column_picker_cannot_drop_the_raster_indices(self, tmp_path):
        """The modal's column picker chooses SCALAR columns; the structured
        writer places points by (row, column). Without the forced slugs a user's
        column selection would silently downgrade the file to unstructured."""
        rows, cols = 6, 8
        pts, rr, cc = _grid_points(rows, cols)
        res = _export([_entry(pts, n_theta=rows, n_phi=cols,
                              scalar_columns={"row_index": list(rr),
                                              "column_index": list(cc),
                                              "reflectance": [0.5] * len(pts)},
                              # Deliberately omits row_index/column_index.
                              columns=["x", "y", "z", "reflectance"])],
                      tmp_path)
        raw, _, stats = _read(res, tmp_path)
        assert stats["structured"] is True
        assert stats["source"] == "index"
        assert "rowIndex" in raw


class TestUnstructuredFallback:
    """No grid is a fallback, never an error — E57 does not require one."""

    def test_no_grid_still_writes_a_valid_flagged_file(self, tmp_path):
        """Neither raster indices nor a declared sweep: the file is unstructured
        but still valid, and misses are still flagged."""
        pts = np.array([[1.0, 0.0, 0.0], [0.0, 1.0, 0.0], [0.0, 0.0, 9.0]])
        miss = [0, 0, 1]
        res = _export([_entry(pts, n_theta=0, n_phi=0,
                              scalar_columns={"is_miss": miss})], tmp_path)
        assert res["success"] is True, res.get("error")
        raw, _, stats = _read(res, tmp_path)
        assert stats["structured"] is False
        assert "rowIndex" not in raw
        assert int(np.asarray(raw["cartesianInvalidState"]).sum()) == 1

    def test_non_raster_pattern_falls_back(self, tmp_path):
        """A spiral sweep has no rectangular cell to bin into. PTX errors here;
        E57 degrades, because it can represent the points regardless."""
        pts, _, _ = _grid_points(4, 4)
        res = _export([_entry(pts, n_theta=4, n_phi=4, scan_pattern="spiral")],
                      tmp_path)
        assert res["success"] is True, res.get("error")
        _, _, stats = _read(res, tmp_path)
        assert stats["structured"] is False

    def test_grid_past_uint16_falls_back(self, tmp_path):
        """rowIndex/columnIndex are uint16. A grid past 65535 in either axis
        cannot be addressed, and wrapped indices would be worse than none."""
        pts = np.array([[1.0, 0.0, 0.0], [0.0, 1.0, 0.0]])
        res = _export([_entry(pts, n_theta=70000, n_phi=4)], tmp_path)
        assert res["success"] is True, res.get("error")
        raw, _, stats = _read(res, tmp_path)
        assert stats["structured"] is False
        assert "rowIndex" not in raw


class TestMissFlagging:
    """`cartesianInvalidState` is what makes an exported miss re-importable."""

    def test_misses_are_written_as_invalid_cells(self, tmp_path):
        rows, cols = 6, 8
        pts, _, _ = _grid_points(rows, cols)
        miss = np.zeros(len(pts))
        miss[::7] = 1.0
        res = _export([_entry(pts, n_theta=rows, n_phi=cols,
                              scalar_columns={"is_miss": list(miss)})], tmp_path)
        raw, _, stats = _read(res, tmp_path)
        inv = np.asarray(raw["cartesianInvalidState"])
        assert int(inv.sum()) == int(miss.sum())
        assert np.array_equal(inv != 0, miss != 0)
        assert stats["misses"] == int(miss.sum())

    def test_excluding_misses_drops_them_but_keeps_the_grid(self, tmp_path):
        """Unlike PTX (where the toggle is inert because every cell is written),
        an excluded miss really is absent from an E57 — leaving a sparse but
        still-indexed grid."""
        rows, cols = 6, 8
        pts, rr, cc = _grid_points(rows, cols)
        miss = np.zeros(len(pts))
        miss[::7] = 1.0
        res = _export([_entry(pts, n_theta=rows, n_phi=cols,
                              scalar_columns={"is_miss": list(miss),
                                              "row_index": list(rr),
                                              "column_index": list(cc)})],
                      tmp_path, include_misses=False)
        raw, _, stats = _read(res, tmp_path)
        assert len(raw["cartesianX"]) == int((miss == 0).sum())
        assert stats["structured"] is True, "the grid must survive the drop"
        assert np.array_equal(np.asarray(raw["rowIndex"]),
                              rr[miss == 0].astype(np.uint16))
        # Every surviving point is a real return, so nothing is flagged invalid.
        if "cartesianInvalidState" in raw:
            assert int(np.asarray(raw["cartesianInvalidState"]).sum()) == 0


class TestPoseAndRoundTrip:
    """Points are scanner-local with the pose in the header — what real scanners
    emit, and what `_e57_to_las` expects. The world frame must survive."""

    def test_points_are_local_and_pose_is_the_world_origin(self, tmp_path):
        rows, cols = 4, 4
        origin = (10.0, 20.0, 30.0)
        pts, _, _ = _grid_points(rows, cols, origin=origin)
        res = _export([_entry(pts, n_theta=rows, n_phi=cols, origin=origin)],
                      tmp_path)
        raw, header, _ = _read(res, tmp_path)
        assert np.allclose(header["translation"], origin)
        local = np.column_stack([raw["cartesianX"], raw["cartesianY"],
                                 raw["cartesianZ"]])
        assert np.allclose(local, pts - np.asarray(origin), atol=1e-9)
        # The scanner sits at local zero, so every local radius is the sphere's.
        assert np.allclose(np.linalg.norm(local, axis=1), 5.0, atol=1e-9)

    def test_viewer_translation_moves_the_scanner_too(self, tmp_path):
        """A translated cloud must keep the scanner at local zero — otherwise the
        pose is off by the translation and the local frame is wrong."""
        rows, cols = 4, 4
        origin = (1.0, 2.0, 3.0)
        shift = (5.0, -4.0, 2.0)
        pts, _, _ = _grid_points(rows, cols, origin=origin)
        res = _export([_entry(pts, n_theta=rows, n_phi=cols, origin=origin,
                              translation=shift)], tmp_path)
        raw, header, _ = _read(res, tmp_path)
        assert np.allclose(header["translation"],
                           np.asarray(origin) + np.asarray(shift))
        local = np.column_stack([raw["cartesianX"], raw["cartesianY"],
                                 raw["cartesianZ"]])
        assert np.allclose(np.linalg.norm(local, axis=1), 5.0, atol=1e-9)

    def test_world_coordinates_survive_the_round_trip(self, tmp_path):
        """The assertion the local+pose change lives or dies by: export then
        re-import through our OWN importer and land back on the world points."""
        rows, cols = 6, 8
        origin = (10.0, 20.0, 30.0)
        pts, _, _ = _grid_points(rows, cols, origin=origin)
        miss = np.zeros(len(pts))
        miss[::7] = 1.0
        res = _export([_entry(pts, n_theta=rows, n_phi=cols, origin=origin,
                              scalar_columns={"is_miss": list(miss)})], tmp_path)
        src = tmp_path / res["files"][0]["name"]
        out = tmp_path / "back.las"
        n, extra_dims = main._e57_to_las(src, out)

        import laspy
        las = laspy.read(str(out))
        got = np.column_stack([las.x, las.y, las.z])
        got_miss = np.asarray(las["is_miss"]) != 0

        assert n == len(pts)
        assert {"is_miss", "row_index", "column_index"} <= {
            e["slug"] for e in extra_dims}
        assert int(got_miss.sum()) == int(miss.sum()), \
            "misses must re-import as misses, not as far-field returns"
        # Hits land back on their world coordinates (LAS is 1 mm-quantized).
        hits_src = np.sort(pts[miss == 0], axis=0)
        hits_got = np.sort(got[~got_miss], axis=0)
        assert hits_got.shape == hits_src.shape
        assert np.abs(hits_got - hits_src).max() < 2e-3

    def test_reimported_misses_do_not_inflate_the_extent(self, tmp_path):
        """The failure this whole change exists to prevent: an unflagged miss
        re-imports as a genuine return ~1 km out, inflating the extent ~1000x and
        hanging every downstream tool. Flagged misses are placed on the miss
        shell but marked, so the HIT extent stays the real one."""
        rows, cols = 6, 8
        pts, _, _ = _grid_points(rows, cols)
        miss = np.zeros(len(pts))
        miss[::5] = 1.0
        res = _export([_entry(pts, n_theta=rows, n_phi=cols,
                              scalar_columns={"is_miss": list(miss)})], tmp_path)
        out = tmp_path / "back.las"
        main._e57_to_las(tmp_path / res["files"][0]["name"], out)

        import laspy
        las = laspy.read(str(out))
        got = np.column_stack([las.x, las.y, las.z])
        hits = got[np.asarray(las["is_miss"]) == 0]
        # Source sphere is radius 5, so the hit extent is ~10 m per axis.
        assert np.ptp(hits, axis=0).max() < 12.0


class TestExportShape:
    """The `files` entry contract, shared with every other export format."""

    def test_writes_one_file_per_scan_to_disk(self, tmp_path):
        pts, _, _ = _grid_points(4, 4)
        res = _export([_entry(pts, n_theta=4, n_phi=4),
                       _entry(pts, n_theta=4, n_phi=4)], tmp_path)
        assert res["success"] is True, res.get("error")
        names = sorted(f["name"] for f in res["files"])
        assert names == ["e_0.e57", "e_1.e57"]
        for f in res["files"]:
            assert f["written"] is True and f["data"] is None
            assert (tmp_path / f["name"]).stat().st_size == f["bytes"] > 0

    def test_inline_base64_matches_the_on_disk_bytes(self, tmp_path):
        """Both emit paths must produce the same file — the dest-dir branch
        exists to avoid a memory peak, not to write something different."""
        rows, cols = 4, 4
        pts, _, _ = _grid_points(rows, cols)
        scans = [_entry(pts, n_theta=rows, n_phi=cols)]
        on_disk = _export(scans, tmp_path, base="d")
        inline = _export(scans, None, base="d")
        assert inline["files"][0]["written"] is False
        got = base64.b64decode(inline["files"][0]["data"])
        # E57 embeds a per-file GUID, so the bytes differ; compare the payload.
        assert len(got) == (tmp_path / on_disk["files"][0]["name"]).stat().st_size
        p = tmp_path / "inline.e57"
        p.write_bytes(got)
        rd = pye57.E57(str(p))
        try:
            raw = rd.read_scan_raw(0)
            assert len(raw["cartesianX"]) == len(pts)
            assert "rowIndex" in raw
        finally:
            rd.close()

    def test_no_partial_file_survives_a_failed_write(self, tmp_path):
        """A truncated .e57 still opens, so a failed write must leave nothing."""
        pts, _, _ = _grid_points(4, 4)
        entry = _entry(pts, n_theta=4, n_phi=4)
        resolved = main._resolve_scan_for_format(entry, True,
                                                 force_slugs=main._GRID_INDEX_SLUGS)

        def boom(*a, **kw):
            raise RuntimeError("disk full")

        real = main._e57_write_scan
        main._e57_write_scan = boom
        try:
            with pytest.raises(RuntimeError):
                main._emit_e57_file("x.e57", resolved, entry, "x", tmp_path)
        finally:
            main._e57_write_scan = real
        assert list(tmp_path.iterdir()) == []


class TestDegenerateClouds:
    """pye57 derives the file bbox from the VALID points alone, so a scan with
    none reduces over an empty array and dies inside numpy. Both shapes below hit
    that; neither may surface as a traceback."""

    def test_all_miss_scan_keeps_its_points(self, tmp_path):
        """The flag only means "these cells, unlike the others, returned
        nothing" — with no others it carries no information, so it is dropped
        while the points stay. Discarding the scan instead would lose it all."""
        pts = np.array([[1.0, 0.0, 0.0], [0.0, 1.0, 0.0], [0.0, 0.0, 1.0]])
        res = _export([_entry(pts, n_theta=2, n_phi=2,
                              scalar_columns={"is_miss": [1, 1, 1]})], tmp_path)
        assert res["success"] is True, res.get("error")
        raw, _, stats = _read(res, tmp_path)
        assert len(raw["cartesianX"]) == len(pts), "an all-miss scan lost its points"
        assert stats["misses"] == len(pts)

    def test_empty_cloud_writes_a_readable_file(self, tmp_path):
        """Unticking "include misses" on a sky-only scan leaves nothing to write.
        The file must still open."""
        pts = np.array([[1.0, 0.0, 0.0], [0.0, 1.0, 0.0]])
        res = _export([_entry(pts, n_theta=2, n_phi=2,
                              scalar_columns={"is_miss": [1, 1]})],
                      tmp_path, include_misses=False)
        assert res["success"] is True, res.get("error")
        rd = pye57.E57(str(tmp_path / res["files"][0]["name"]))
        try:
            assert rd.scan_count == 0
        finally:
            rd.close()
