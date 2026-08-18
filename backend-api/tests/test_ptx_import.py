"""PTX import with automatic sky/miss recovery (`_ptx_to_las`).

PTX is a COMPLETE rectangular raster: every beam gets a line, and a beam that
returned nothing is written with all-zero coordinates. Unlike E57 it stores no
per-cell angles, so a miss carries no direction of its own — but because PTX
coordinates are in the SCANNER-LOCAL frame, the local spherical angles are the
raw instrument angles and the grid is exactly separable (zenith per row, azimuth
per column). `_PtxGridModel` recovers both as robust per-index medians so every
miss gets an analytic pulse direction.

The fixtures below write grids that are exactly separable by construction, which
means every recovered miss direction has a CLOSED-FORM expected value. That is
what makes the headline accuracy test possible: a regression in the recovery is
otherwise silent, because misses would still land somewhere plausible while
LAD's transmission denominator went quietly wrong.
"""

from pathlib import Path
import math

import numpy as np
import pytest

import main
from tests.binframe import _create_session_direct

laspy = pytest.importorskip("laspy")


# ---------------------------------------------------------------------------
# Fixture writer
# ---------------------------------------------------------------------------

def _pose(yaw=0.0, pitch=0.0, roll=0.0, t=(0.0, 0.0, 0.0), scale=1.0):
    """(rot, trans) with rot = Rz(yaw) Ry(pitch) Rx(roll), angles in degrees."""
    y, p, r = math.radians(yaw), math.radians(pitch), math.radians(roll)
    rz = np.array([[math.cos(y), -math.sin(y), 0], [math.sin(y), math.cos(y), 0], [0, 0, 1]])
    ry = np.array([[math.cos(p), 0, math.sin(p)], [0, 1, 0], [-math.sin(p), 0, math.cos(p)]])
    rx = np.array([[1, 0, 0], [0, math.cos(r), -math.sin(r)], [0, math.sin(r), math.cos(r)]])
    return (rz @ ry @ rx) * scale, np.asarray(t, dtype=np.float64)


def _block_text(*, zen, az, rng, pose, miss_mask=None, tokens=7,
                intensity=None, rgb=None, swap_header=False,
                miss_intensity=0.5, newline="\n"):
    """One PTX block whose cell (r, c) has zenith zen[r] and azimuth az[c].

    Writes the transform in PTX's ROW-vector convention (translation in the LAST
    row), which is the thing the importer has to get right.
    """
    rows, cols = zen.size, az.size
    rot, trans = pose
    st = np.sin(zen)[:, None]
    local = np.stack([
        st * np.cos(az)[None, :],
        st * np.sin(az)[None, :],
        np.repeat(np.cos(zen)[:, None], cols, axis=1),
    ], axis=0) * rng[None, :, :]
    miss = np.zeros((rows, cols), bool) if miss_mask is None else miss_mask
    inten = np.full((rows, cols), 0.25) if intensity is None else intensity

    n1, n2 = (rows, cols) if swap_header else (cols, rows)
    out = [str(n1), str(n2), " ".join(f"{v:.15g}" for v in trans)]
    for i in range(3):
        out.append(" ".join(f"{v:.15g}" for v in rot[:, i]))   # axes = rot columns
    m = np.eye(4)
    m[:3, :3] = rot.T          # row-vector convention: world = [x y z 1] @ M
    m[3, :3] = trans
    for i in range(4):
        out.append(" ".join(f"{v:.15g}" for v in m[i]))
    # Column-major: the first `rows` data lines are column 0.
    for c in range(cols):
        for r in range(rows):
            if miss[r, c]:
                vals = [0.0, 0.0, 0.0, miss_intensity]
                if tokens >= 7:
                    vals += [0, 0, 0]
            else:
                vals = [local[0, r, c], local[1, r, c], local[2, r, c],
                        float(inten[r, c])]
                if tokens >= 7:
                    v = (128, 64, 32) if rgb is None else tuple(int(x) for x in rgb[r, c])
                    vals += list(v)
            out.append(" ".join(
                f"{v:.6f}" if isinstance(v, float) else str(v) for v in vals))
    return newline.join(out) + newline


def _write_ptx(path: Path, *blocks_kwargs, newline="\n"):
    path.write_text("".join(_block_text(newline=newline, **kw) for kw in blocks_kwargs))
    return path


def _simple(rows=40, cols=60, zen_lo=60.0, zen_hi=120.0, az_lo=-30.0, az_hi=30.0):
    return (np.radians(np.linspace(zen_lo, zen_hi, rows)),
            np.radians(np.linspace(az_lo, az_hi, cols)))


def _read(out: Path):
    return main._read_las_into_arrays(out)


def _miss_dirs(r, trans):
    """(unit world directions, row idx, col idx) of the flagged misses."""
    m = r.extras[main._MISS_SLUG] != 0
    d = r.positions[m] - np.asarray(trans)
    n = np.linalg.norm(d, axis=1)
    return (d / np.where(n[:, None] == 0, 1.0, n[:, None]),
            r.extras["row_index"][m].astype(int),
            r.extras["column_index"][m].astype(int), n)


def _expected_dirs(zen, az, rr, cc, rot):
    st = np.sin(zen[rr])
    local = np.column_stack([st * np.cos(az[cc]), st * np.sin(az[cc]), np.cos(zen[rr])])
    return local @ rot.T


def _max_angle_deg(a, b):
    return float(np.degrees(np.arccos(np.clip((a * b).sum(axis=1), -1, 1))).max())


@pytest.fixture(autouse=True)
def _clear_scan_meta():
    yield
    main._import_scan_meta.clear()


# ---------------------------------------------------------------------------
# The headline test
# ---------------------------------------------------------------------------

def test_recovers_miss_directions_to_analytic_accuracy(tmp_path):
    """A scan with a rectangular hole punched in it: every miss must come back
    pointing along the beam the scanner would actually have fired.

    This is THE test for the feature. PTX stores no angles, so a regression here
    is silent — misses land somewhere plausible-looking and LAD's transmission
    denominator is quietly wrong.
    """
    rows, cols = 60, 90
    zen, az = _simple(rows, cols)
    miss = np.zeros((rows, cols), bool)
    miss[20:35, 40:55] = True
    rot, trans = _pose(yaw=35.0, t=(10.0, -4.0, 2.0))
    src = _write_ptx(tmp_path / "scan.ptx", dict(
        zen=zen, az=az, rng=np.full((rows, cols), 10.0),
        pose=(rot, trans), miss_mask=miss))
    out = tmp_path / "out.las"
    n, extra_dims, full_xyz = main._ptx_to_las(src, out)

    assert n == rows * cols
    assert {e["slug"] for e in extra_dims} == {"is_miss", "row_index", "column_index"}

    r = _read(out)
    assert int((r.extras[main._MISS_SLUG] != 0).sum()) == int(miss.sum())
    dirs, rr, cc, dist = _miss_dirs(r, trans)
    # Placed at the canonical miss distance, along the recovered ray.
    np.testing.assert_allclose(dist, main._MISS_GAP_DISTANCE, rtol=1e-5)
    assert _max_angle_deg(dirs, _expected_dirs(zen, az, rr, cc, rot)) < 0.01
    meta = main._import_scan_meta[str(out.resolve())]
    assert meta["unplaceable_miss_count"] == 0


def test_recovers_non_uniform_angular_steps(tmp_path):
    """The same accuracy bound on a deliberately NON-UNIFORM grid.

    This is the test that separates the per-index LUT from a global linear fit:
    a fitted line bakes the non-uniformity into every recovered miss, while a
    per-index median reproduces it exactly. FARO quality-dependent grids and any
    resampled export land here.
    """
    rows, cols = 50, 70
    rng_ = np.random.default_rng(7)
    zen = np.radians(60.0 + np.cumsum(rng_.uniform(0.4, 1.6, rows)))
    az = np.radians(-40.0 + np.cumsum(rng_.uniform(0.3, 1.7, cols)))
    miss = np.zeros((rows, cols), bool)
    miss[10:20, 15:30] = True
    rot, trans = _pose(t=(1.0, 2.0, 3.0))
    src = _write_ptx(tmp_path / "nu.ptx", dict(
        zen=zen, az=az, rng=np.full((rows, cols), 7.0), pose=(rot, trans),
        miss_mask=miss, tokens=4))
    out = tmp_path / "nu.las"
    main._ptx_to_las(src, out)
    dirs, rr, cc, _ = _miss_dirs(_read(out), trans)
    assert _max_angle_deg(dirs, _expected_dirs(zen, az, rr, cc, rot)) < 0.01


@pytest.mark.parametrize("az_lo,az_hi", [(170.0, 190.0), (0.0, 359.0)])
def test_azimuth_seam_and_full_revolution(tmp_path, az_lo, az_hi):
    """Crossing +/-pi, and a full 360 sweep. Guards the circular median (which
    must not need unwrapping to estimate) and the LUT unwrap (which does)."""
    rows, cols = 30, 120
    zen = np.radians(np.linspace(70.0, 110.0, rows))
    az = np.radians(np.linspace(az_lo, az_hi, cols))
    az = np.arctan2(np.sin(az), np.cos(az))          # wrap into (-pi, pi]
    miss = np.zeros((rows, cols), bool)
    miss[5:12, 50:70] = True
    rot, trans = _pose(t=(0.0, 0.0, 1.0))
    src = _write_ptx(tmp_path / f"seam{int(az_lo)}.ptx", dict(
        zen=zen, az=az, rng=np.full((rows, cols), 5.0), pose=(rot, trans),
        miss_mask=miss))
    out = tmp_path / "seam.las"
    main._ptx_to_las(src, out)
    dirs, rr, cc, _ = _miss_dirs(_read(out), trans)
    assert _max_angle_deg(dirs, _expected_dirs(zen, az, rr, cc, rot)) < 0.02


def test_empty_interior_row_and_column_are_interpolated(tmp_path):
    """A wholly-empty row and column, both bracketed by data, must recover
    exactly: interpolation between measured neighbours is bounded on both sides,
    however wide the gap."""
    rows, cols = 40, 50
    zen, az = _simple(rows, cols)
    miss = np.zeros((rows, cols), bool)
    miss[17, :] = True
    miss[:, 22] = True
    rot, trans = _pose(t=(0.0, 0.0, 0.0))
    src = _write_ptx(tmp_path / "gap.ptx", dict(
        zen=zen, az=az, rng=np.full((rows, cols), 8.0), pose=(rot, trans),
        miss_mask=miss))
    out = tmp_path / "gap.las"
    main._ptx_to_las(src, out)
    dirs, rr, cc, _ = _miss_dirs(_read(out), trans)
    assert _max_angle_deg(dirs, _expected_dirs(zen, az, rr, cc, rot)) < 0.01
    assert main._import_scan_meta[str(out.resolve())]["unplaceable_miss_count"] == 0


def test_edge_rows_within_the_extrapolation_budget_are_placed(tmp_path):
    rows, cols = 60, 40
    zen, az = _simple(rows, cols)
    miss = np.zeros((rows, cols), bool)
    miss[:3, :] = True                      # 5% of the axis — inside the 10% budget
    rot, trans = _pose(t=(0.0, 0.0, 0.0))
    src = _write_ptx(tmp_path / "edge.ptx", dict(
        zen=zen, az=az, rng=np.full((rows, cols), 6.0), pose=(rot, trans),
        miss_mask=miss))
    out = tmp_path / "edge.las"
    main._ptx_to_las(src, out)
    assert main._import_scan_meta[str(out.resolve())]["unplaceable_miss_count"] == 0
    dirs, rr, cc, _ = _miss_dirs(_read(out), trans)
    assert _max_angle_deg(dirs, _expected_dirs(zen, az, rr, cc, rot)) < 0.01


def test_edge_rows_beyond_the_budget_are_kept_flagged_at_the_origin(tmp_path):
    """Half the rows are sky: those beyond the extrapolation budget are NOT
    dropped and NOT guessed — they stay flagged at the scanner origin and are
    counted, exactly as the E57 path handles its unplaceable misses."""
    rows, cols = 60, 40
    zen, az = _simple(rows, cols)
    miss = np.zeros((rows, cols), bool)
    miss[:30, :] = True
    rot, trans = _pose(t=(5.0, 5.0, 5.0))
    src = _write_ptx(tmp_path / "sky.ptx", dict(
        zen=zen, az=az, rng=np.full((rows, cols), 6.0), pose=(rot, trans),
        miss_mask=miss))
    out = tmp_path / "sky.las"
    n, _, _ = main._ptx_to_las(src, out)
    assert n == rows * cols                       # nothing dropped
    r = _read(out)
    assert int((r.extras[main._MISS_SLUG] != 0).sum()) == 30 * cols
    meta = main._import_scan_meta[str(out.resolve())]
    assert meta["unplaceable_miss_count"] > 0
    # The unplaceable ones sit AT the origin (mm-quantized by the LAS).
    _, _, _, dist = _miss_dirs(r, trans)
    assert (dist < 0.01).sum() == meta["unplaceable_miss_count"]


def test_all_miss_block_is_kept_and_counted(tmp_path):
    rows, cols = 12, 15
    zen, az = _simple(rows, cols)
    rot, trans = _pose(t=(2.0, 0.0, 1.0))
    src = _write_ptx(tmp_path / "all.ptx", dict(
        zen=zen, az=az, rng=np.full((rows, cols), 4.0), pose=(rot, trans),
        miss_mask=np.ones((rows, cols), bool)))
    out = tmp_path / "all.las"
    n, _, _ = main._ptx_to_las(src, out)
    assert n == rows * cols
    r = _read(out)
    assert int((r.extras[main._MISS_SLUG] != 0).sum()) == rows * cols
    meta = main._import_scan_meta[str(out.resolve())]
    assert meta["unplaceable_miss_count"] == rows * cols
    assert any("could not be recovered" in w for w in meta["warnings"])


def test_a_scrambled_grid_fails_the_trust_gate(tmp_path):
    """Shuffling the data lines destroys separability. The importer must notice
    and fall back — not place every miss along a confidently-wrong ray."""
    rows, cols = 40, 50
    zen, az = _simple(rows, cols)
    miss = np.zeros((rows, cols), bool)
    miss[10:20, 10:20] = True
    rot, trans = _pose(t=(0.0, 0.0, 0.0))
    text = _block_text(zen=zen, az=az, rng=np.full((rows, cols), 5.0),
                       pose=(rot, trans), miss_mask=miss)
    lines = text.strip("\n").split("\n")
    head, body = lines[:10], lines[10:]
    np.random.default_rng(3).shuffle(body)
    src = tmp_path / "shuf.ptx"
    src.write_text("\n".join(head + body) + "\n")
    out = tmp_path / "shuf.las"
    main._ptx_to_las(src, out)
    meta = main._import_scan_meta[str(out.resolve())]
    assert meta["unplaceable_miss_count"] == int(miss.sum())
    assert any("could not be recovered" in w for w in meta["warnings"])


# ---------------------------------------------------------------------------
# Pose
# ---------------------------------------------------------------------------

def test_pose_uses_the_row_vector_convention(tmp_path):
    """world = [x y z 1] @ M, translation in the LAST row. A transposed rotation
    yields a plausible-looking but wrong cloud, so pin it numerically."""
    rows, cols = 20, 25
    zen, az = _simple(rows, cols)
    rot, trans = _pose(yaw=41.0, pitch=7.0, roll=-3.0, t=(12.0, -8.0, 4.0))
    rng = np.full((rows, cols), 9.0)
    src = _write_ptx(tmp_path / "pose.ptx", dict(
        zen=zen, az=az, rng=rng, pose=(rot, trans), tokens=4))
    out = tmp_path / "pose.las"
    _, _, full_xyz = main._ptx_to_las(src, out)

    st = np.sin(zen)[:, None]
    local = np.stack([st * np.cos(az)[None, :], st * np.sin(az)[None, :],
                      np.repeat(np.cos(zen)[:, None], cols, axis=1)], axis=0) * rng
    # `.T.ravel()` puts the grid back into PTX's column-major file order.
    expect = np.column_stack([local[i].T.ravel() for i in range(3)]) @ rot.T + trans
    # 2e-6: the fixture itself writes coordinates at %.6f, so that — not the
    # importer — is the precision floor here.
    np.testing.assert_allclose(full_xyz, expect, atol=2e-6)
    # And the LAS itself agrees to its 1 mm quantisation.
    np.testing.assert_allclose(_read(out).positions, expect, atol=2e-3)


def test_full_xyz_beats_the_las_quantisation(tmp_path):
    """`full_xyz` is the session's source of truth precisely because the LAS is
    1 mm-quantized; prove the two differ and that the float64 one is exact."""
    rows, cols = 10, 12
    zen, az = _simple(rows, cols)
    rot, trans = _pose(t=(0.0, 0.0, 0.0))
    rng = np.full((rows, cols), 3.0)
    src = _write_ptx(tmp_path / "prec.ptx", dict(
        zen=zen, az=az, rng=rng, pose=(rot, trans), tokens=4))
    out = tmp_path / "prec.las"
    n, _, full_xyz = main._ptx_to_las(src, out)
    assert full_xyz.shape == (n, 3)     # create 500s on a length mismatch
    las_pos = _read(out).positions
    # Same points, but only the float64 array carries sub-mm precision: it is
    # faithful to the file's own %.6f, while the LAS is quantized to 1 mm.
    assert np.abs(full_xyz - las_pos).max() > 1e-5
    assert np.abs(full_xyz - las_pos).max() < 1e-3
    assert np.abs(np.linalg.norm(full_xyz, axis=1) - 3.0).max() < 1e-5


def test_the_4x4_wins_over_disagreeing_axis_lines(tmp_path):
    rows, cols = 15, 18
    zen, az = _simple(rows, cols)
    rot, trans = _pose(yaw=30.0, t=(1.0, 1.0, 1.0))
    text = _block_text(zen=zen, az=az, rng=np.full((rows, cols), 4.0),
                       pose=(rot, trans), tokens=4)
    lines = text.split("\n")
    other, _ = _pose(yaw=-77.0)
    for i in range(3):
        lines[3 + i] = " ".join(f"{v:.15g}" for v in other[:, i])
    src = tmp_path / "dis.ptx"
    src.write_text("\n".join(lines))
    out = tmp_path / "dis.las"
    _, _, full_xyz = main._ptx_to_las(src, out)
    meta = main._import_scan_meta[str(out.resolve())]
    assert any("disagree" in w for w in meta["warnings"])
    # The 4x4's rotation was used, not the axis lines'.
    assert np.allclose(meta["origin"], trans)
    assert np.abs(np.linalg.norm(full_xyz - trans, axis=1) - 4.0).max() < 1e-6


def test_identity_4x4_falls_back_to_the_axis_lines(tmp_path):
    rows, cols = 15, 18
    zen, az = _simple(rows, cols)
    rot, trans = _pose(yaw=25.0, t=(3.0, -2.0, 1.0))
    text = _block_text(zen=zen, az=az, rng=np.full((rows, cols), 4.0),
                       pose=(rot, trans), tokens=4)
    lines = text.split("\n")
    eye = np.eye(4)
    for i in range(4):
        lines[6 + i] = " ".join(f"{v:.15g}" for v in eye[i])
    src = tmp_path / "ident.ptx"
    src.write_text("\n".join(lines))
    out = tmp_path / "ident.las"
    main._ptx_to_las(src, out)
    meta = main._import_scan_meta[str(out.resolve())]
    assert any("identity or" in w for w in meta["warnings"])
    np.testing.assert_allclose(meta["origin"], trans, atol=1e-9)


def test_uniform_scale_in_the_transform_leaves_directions_unit(tmp_path):
    """A PTX exported in millimetres carries a uniform scale. Points scale;
    recovered miss rays must stay unit and land at exactly the miss distance."""
    rows, cols = 20, 24
    zen, az = _simple(rows, cols)
    miss = np.zeros((rows, cols), bool)
    miss[8:12, 8:14] = True
    rot, trans = _pose(yaw=15.0, t=(0.0, 0.0, 0.0), scale=0.001)
    src = _write_ptx(tmp_path / "mm.ptx", dict(
        zen=zen, az=az, rng=np.full((rows, cols), 1000.0), pose=(rot, trans),
        miss_mask=miss, tokens=4))
    out = tmp_path / "mm.las"
    main._ptx_to_las(src, out)
    dirs, rr, cc, dist = _miss_dirs(_read(out), trans)
    np.testing.assert_allclose(dist, main._MISS_GAP_DISTANCE, rtol=1e-5)
    unit_rot, _ = _pose(yaw=15.0)
    assert _max_angle_deg(dirs, _expected_dirs(zen, az, rr, cc, unit_rot)) < 0.01


def test_pose_decomposition_round_trips(tmp_path):
    """The gate on emitting tilt/azimuth fields at all: rebuilding
    Rz(yaw)Ry(pitch)Rx(roll) from the decomposition must reproduce the rotation."""
    for yaw, pitch, roll in [(0, 0, 0), (35, 0, 0), (12, 5, -3), (-170, -8, 2)]:
        rot, _ = _pose(yaw=yaw, pitch=pitch, roll=roll)
        got = main._ptx_decompose_pose(rot)
        assert got is not None, (yaw, pitch, roll)
        gy, gp, gr = (math.degrees(v) for v in got)
        assert abs(gy - yaw) < 1e-6 and abs(gp - pitch) < 1e-6 and abs(gr - roll) < 1e-6


# ---------------------------------------------------------------------------
# Header / ordering / layout robustness
# ---------------------------------------------------------------------------

def test_header_swap_is_adjudicated_by_the_fit(tmp_path):
    """A non-square grid written with lines 1/2 swapped. The separability
    residual — the same number the trust gate uses — must pick the ordering the
    scan geometry supports, rather than trusting the spec blindly."""
    rows, cols = 24, 56
    zen, az = _simple(rows, cols)
    miss = np.zeros((rows, cols), bool)
    miss[6:12, 20:32] = True
    rot, trans = _pose(t=(0.0, 0.0, 0.0))
    src = _write_ptx(tmp_path / "swap.ptx", dict(
        zen=zen, az=az, rng=np.full((rows, cols), 5.0), pose=(rot, trans),
        miss_mask=miss, swap_header=True))
    out = tmp_path / "swap.las"
    main._ptx_to_las(src, out)
    meta = main._import_scan_meta[str(out.resolve())]
    assert any("rows before columns" in w for w in meta["warnings"])
    assert meta["scan_params"]["n_theta"] == rows
    assert meta["scan_params"]["n_phi"] == cols
    dirs, rr, cc, _ = _miss_dirs(_read(out), trans)
    assert _max_angle_deg(dirs, _expected_dirs(zen, az, rr, cc, rot)) < 0.01


@pytest.mark.parametrize("tokens", [4, 7])
def test_four_and_seven_token_rows(tmp_path, tokens):
    rows, cols = 12, 14
    zen, az = _simple(rows, cols)
    miss = np.zeros((rows, cols), bool)
    miss[3, 4] = True
    rgb = np.zeros((rows, cols, 3), int)
    rgb[..., 0], rgb[..., 1], rgb[..., 2] = 255, 128, 0
    rot, trans = _pose(t=(0.0, 0.0, 0.0))
    src = _write_ptx(tmp_path / f"tok{tokens}.ptx", dict(
        zen=zen, az=az, rng=np.full((rows, cols), 5.0), pose=(rot, trans),
        miss_mask=miss, tokens=tokens, rgb=rgb if tokens >= 7 else None))
    out = tmp_path / f"tok{tokens}.las"
    main._ptx_to_las(src, out)
    with laspy.open(str(out)) as rd:
        las = rd.read()
    if tokens >= 7:
        # 0-255 lifted into the 16-bit channel, misses black.
        assert int(np.asarray(las.red).max()) == 255 * 256
        assert int(np.asarray(las.green).max()) == 128 * 256
        m = np.asarray(las[main._MISS_SLUG]) != 0
        assert int(np.asarray(las.red)[m].max()) == 0
    else:
        assert int(np.asarray(las.red).max()) == 0


@pytest.mark.parametrize("miss_intensity", [0.0, 0.5])
def test_misses_are_detected_by_zero_xyz_whatever_the_intensity(tmp_path, miss_intensity):
    """The spec says a miss carries intensity 0.5; RiSCAN PRO writes 0. Detection
    keys on the coordinates alone, so both are recognised identically."""
    rows, cols = 10, 12
    zen, az = _simple(rows, cols)
    miss = np.zeros((rows, cols), bool)
    miss[2:5, 3:6] = True
    rot, trans = _pose(t=(0.0, 0.0, 0.0))
    src = _write_ptx(tmp_path / f"mi{miss_intensity}.ptx", dict(
        zen=zen, az=az, rng=np.full((rows, cols), 5.0), pose=(rot, trans),
        miss_mask=miss, miss_intensity=miss_intensity, tokens=4))
    out = tmp_path / "mi.las"
    main._ptx_to_las(src, out)
    assert int((_read(out).extras[main._MISS_SLUG] != 0).sum()) == int(miss.sum())


def test_crlf_matches_lf(tmp_path):
    rows, cols = 10, 12
    zen, az = _simple(rows, cols)
    miss = np.zeros((rows, cols), bool)
    miss[4, 5] = True
    kw = dict(zen=zen, az=az, rng=np.full((rows, cols), 5.0),
              pose=_pose(t=(1.0, 2.0, 3.0)), miss_mask=miss)
    a = _write_ptx(tmp_path / "lf.ptx", kw)
    b = _write_ptx(tmp_path / "crlf.ptx", kw, newline="\r\n")
    na, _, xa = main._ptx_to_las(a, tmp_path / "a.las")
    nb, _, xb = main._ptx_to_las(b, tmp_path / "b.las")
    assert na == nb == rows * cols
    np.testing.assert_allclose(xa, xb)


def test_multi_block_with_differing_dims_and_poses(tmp_path):
    """The real-file shape: several scan setups in one file, each with its own
    dimensions and pose. Every block's misses must be placed against ITS OWN
    origin, and block 0 supplies the stashed origin/scan_params."""
    z0, a0 = _simple(20, 30)
    z1, a1 = _simple(18, 26, zen_lo=70.0, zen_hi=100.0)
    m0 = np.zeros((20, 30), bool); m0[5:8, 6:9] = True
    m1 = np.zeros((18, 26), bool); m1[4:6, 3:7] = True
    rot0, t0 = _pose(yaw=10.0, t=(0.0, 0.0, 0.0))
    rot1, t1 = _pose(yaw=-25.0, t=(50.0, 20.0, 1.0))
    src = _write_ptx(
        tmp_path / "multi.ptx",
        dict(zen=z0, az=a0, rng=np.full((20, 30), 5.0), pose=(rot0, t0), miss_mask=m0),
        dict(zen=z1, az=a1, rng=np.full((18, 26), 5.0), pose=(rot1, t1), miss_mask=m1),
    )
    out = tmp_path / "multi.las"
    n, _, _ = main._ptx_to_las(src, out)
    assert n == 20 * 30 + 18 * 26

    r = _read(out)
    m = r.extras[main._MISS_SLUG] != 0
    assert int(m.sum()) == int(m0.sum()) + int(m1.sum())
    # Each block's misses are one MISS_GAP_DISTANCE from their own origin.
    p = r.positions[m]
    d0 = np.linalg.norm(p - t0, axis=1)
    d1 = np.linalg.norm(p - t1, axis=1)
    near = np.minimum(np.abs(d0 - main._MISS_GAP_DISTANCE),
                      np.abs(d1 - main._MISS_GAP_DISTANCE))
    assert near.max() < 1.0
    meta = main._import_scan_meta[str(out.resolve())]
    np.testing.assert_allclose(meta["origin"], t0, atol=1e-9)
    assert len(meta["scan_origins"]) == 2
    np.testing.assert_allclose(meta["scan_origins"][1], t1, atol=1e-9)
    assert meta["scan_params"]["n_theta"] == 20 and meta["scan_params"]["n_phi"] == 30


def test_mid_file_desync_is_a_400_naming_the_line(tmp_path):
    """Lines lost inside an interior block shift every later block boundary. With
    a fixed cell count per block that can't show up as a short count — it shows up
    as the NEXT block's header landing on data. Fail loudly and say where, rather
    than importing a scrambled file."""
    z0, a0 = _simple(10, 12)
    z1, a1 = _simple(8, 9)
    src = _write_ptx(
        tmp_path / "short.ptx",
        dict(zen=z0, az=a0, rng=np.full((10, 12), 5.0), pose=_pose()),
        dict(zen=z1, az=a1, rng=np.full((8, 9), 5.0), pose=_pose()),
    )
    lines = src.read_text().split("\n")
    del lines[40:50]                       # gut the middle of block 0's data
    src.write_text("\n".join(lines))
    with pytest.raises(main.HTTPException) as e:
        main._ptx_to_las(src, tmp_path / "short.las")
    assert e.value.status_code == 400
    detail = str(e.value.detail)
    assert "block 1" in detail and "line 131" in detail
    assert "grid dimensions" in detail


def test_truncated_final_block_imports_and_warns(tmp_path):
    rows, cols = 10, 12
    zen, az = _simple(rows, cols)
    src = _write_ptx(tmp_path / "trunc.ptx", dict(
        zen=zen, az=az, rng=np.full((rows, cols), 5.0), pose=_pose(), tokens=4))
    lines = src.read_text().rstrip("\n").split("\n")
    src.write_text("\n".join(lines[:-30]) + "\n")     # lose 30 cells = 2.5 columns
    out = tmp_path / "trunc.las"
    n, _, _ = main._ptx_to_las(src, out)
    assert 0 < n < rows * cols
    assert n % rows == 0                # only whole columns are kept
    assert any("truncated" in w for w in main._import_scan_meta[str(out.resolve())]["warnings"])


def test_malformed_header_is_a_400(tmp_path):
    src = tmp_path / "bad.ptx"
    src.write_text("not-a-number\n10\n" + "0 0 0\n" * 4 + "0 0 0 0\n" * 4 + "1 2 3 0.5\n")
    with pytest.raises(main.HTTPException) as e:
        main._ptx_to_las(src, tmp_path / "bad.las")
    assert e.value.status_code == 400
    assert "grid dimensions" in str(e.value.detail)


def test_chunking_does_not_change_the_result(tmp_path, monkeypatch):
    """Every per-column reduction in the fit is an `axis=0` and every per-row one
    an `axis=1`, which only holds because chunks are WHOLE COLUMNS. Force several
    chunks and demand identical output."""
    rows, cols = 25, 80
    zen, az = _simple(rows, cols)
    miss = np.zeros((rows, cols), bool)
    miss[8:14, 30:50] = True
    src = _write_ptx(tmp_path / "chunk.ptx", dict(
        zen=zen, az=az, rng=np.full((rows, cols), 5.0),
        pose=_pose(yaw=20.0, t=(1.0, 2.0, 3.0)), miss_mask=miss))
    _, _, one = main._ptx_to_las(src, tmp_path / "one.las")
    monkeypatch.setattr(main, "_PTX_CHUNK_CELLS", 25 * 7)   # -> 7 columns per chunk
    _, _, many = main._ptx_to_las(src, tmp_path / "many.las")
    np.testing.assert_allclose(one, many)


# ---------------------------------------------------------------------------
# scan_params
# ---------------------------------------------------------------------------

def test_scan_params_reports_zenith_directly(tmp_path):
    """`zen_full` is ALREADY zenith, so there is deliberately no 90-elevation
    conversion here — the E57 path's swap is absent on purpose."""
    rows, cols = 40, 60
    zen, az = _simple(rows, cols, zen_lo=30.0, zen_hi=130.0, az_lo=-20.0, az_hi=20.0)
    src = _write_ptx(tmp_path / "sp.ptx", dict(
        zen=zen, az=az, rng=np.full((rows, cols), 5.0), pose=_pose(t=(1.0, 2.0, 3.0))))
    out = tmp_path / "sp.las"
    main._ptx_to_las(src, out)
    sp = main._import_scan_meta[str(out.resolve())]["scan_params"]
    assert sp["n_theta"] == rows and sp["n_phi"] == cols
    assert abs(sp["theta_min"] - 30.0) < 0.01
    assert abs(sp["theta_max"] - 130.0) < 0.01
    np.testing.assert_allclose(sp["origin"], [1.0, 2.0, 3.0], atol=1e-9)


def test_scan_params_omits_azimuth_for_a_tilted_pose(tmp_path):
    """The local azimuth sweep is not the world one unless the pose is a pure
    yaw, so a tilted scanner reports tilt and omits phi rather than reporting a
    rotated sweep as if it were the instrument's."""
    rows, cols = 30, 40
    zen, az = _simple(rows, cols)
    kw = dict(zen=zen, az=az, rng=np.full((rows, cols), 5.0))
    flat = _write_ptx(tmp_path / "flat.ptx", dict(pose=_pose(yaw=20.0), **kw))
    tilt = _write_ptx(tmp_path / "tilt.ptx", dict(pose=_pose(yaw=20.0, pitch=9.0), **kw))
    main._ptx_to_las(flat, tmp_path / "flat.las")
    main._ptx_to_las(tilt, tmp_path / "tilt.las")
    sp_flat = main._import_scan_meta[str((tmp_path / "flat.las").resolve())]["scan_params"]
    sp_tilt = main._import_scan_meta[str((tmp_path / "tilt.las").resolve())]["scan_params"]
    assert "phi_min" in sp_flat and "phi_max" in sp_flat
    assert abs(sp_flat["azimuth_offset_deg"] - 20.0) < 1e-6
    assert "phi_min" not in sp_tilt and "azimuth_offset_deg" not in sp_tilt
    assert abs(sp_tilt["tilt_pitch_deg"] - 9.0) < 1e-6


def test_scan_params_reports_a_full_revolution_as_0_to_360(tmp_path):
    rows, cols = 20, 180
    zen = np.radians(np.linspace(60.0, 120.0, rows))
    az = np.radians(np.linspace(0.0, 358.0, cols))
    az = np.arctan2(np.sin(az), np.cos(az))
    src = _write_ptx(tmp_path / "rev.ptx", dict(
        zen=zen, az=az, rng=np.full((rows, cols), 5.0), pose=_pose()))
    out = tmp_path / "rev.las"
    main._ptx_to_las(src, out)
    sp = main._import_scan_meta[str(out.resolve())]["scan_params"]
    assert (sp["phi_min"], sp["phi_max"]) == (0.0, 360.0)


def test_untrusted_fit_omits_the_inferred_sweep_but_keeps_the_grid(tmp_path):
    rows, cols = 12, 15
    zen, az = _simple(rows, cols)
    src = _write_ptx(tmp_path / "u.ptx", dict(
        zen=zen, az=az, rng=np.full((rows, cols), 4.0), pose=_pose(t=(1.0, 1.0, 1.0)),
        miss_mask=np.ones((rows, cols), bool)))
    out = tmp_path / "u.las"
    main._ptx_to_las(src, out)
    sp = main._import_scan_meta[str(out.resolve())]["scan_params"]
    # Declared resolution is from the header, so it survives; the inferred sweep
    # does not ("blank stays blank").
    assert sp["n_theta"] == rows and sp["n_phi"] == cols
    assert "theta_min" not in sp and "phi_min" not in sp


# ---------------------------------------------------------------------------
# Preview / shift / end-to-end
# ---------------------------------------------------------------------------

def test_preview_is_fixed_schema_and_omits_is_miss(tmp_path):
    rows, cols = 10, 12
    zen, az = _simple(rows, cols)
    src = _write_ptx(tmp_path / "p.ptx", dict(
        zen=zen, az=az, rng=np.full((rows, cols), 5.0), pose=_pose()))
    resp = main.preview_pointcloud(main.PointCloudPreviewRequest(file_path=str(src)))
    assert resp.kind == "ptx"
    roles = [c.detected_role for c in resp.columns]
    assert roles == ["x", "y", "z", "intensity", "r255", "g255", "b255"]
    assert all(not c.remappable for c in resp.columns)
    assert main._MISS_SLUG not in roles
    assert "sky/miss" in resp.warning and f"{cols} x {rows}" in resp.warning
    # Fixed schema does NOT mean no preview: PTX is plain ASCII behind a 10-line
    # header, so the rows are free to read, and seeing them is how a user checks
    # the column count and the intensity/colour scales before committing.
    assert resp.sample_rows, "no preview rows for a plain-ASCII format"
    assert all(len(r) == 7 for r in resp.sample_rows)
    # Real returns, not the all-zero sentinel.
    assert all(any(float(t) != 0.0 for t in r[:3]) for r in resp.sample_rows)


def test_preview_prefers_rows_with_a_return(tmp_path):
    """A scan commonly opens on a whole column of sky. Ten rows of zeros would
    tell the user nothing, so the preview skips ahead to real returns."""
    rows, cols = 8, 10
    zen, az = _simple(rows, cols)
    miss = np.zeros((rows, cols), bool)
    miss[:, :3] = True                      # the first three columns are all sky
    src = _write_ptx(tmp_path / "sky.ptx", dict(
        zen=zen, az=az, rng=np.full((rows, cols), 5.0), pose=_pose(),
        miss_mask=miss, tokens=4))
    resp = main.preview_pointcloud(main.PointCloudPreviewRequest(file_path=str(src)))
    assert resp.sample_rows
    assert all(any(float(t) != 0.0 for t in r[:3]) for r in resp.sample_rows)


def test_preview_falls_back_to_raw_rows_for_an_all_miss_head(tmp_path):
    """When there is nothing but sky to show, show the sky rather than nothing."""
    rows, cols = 6, 6
    zen, az = _simple(rows, cols)
    src = _write_ptx(tmp_path / "allsky.ptx", dict(
        zen=zen, az=az, rng=np.full((rows, cols), 5.0), pose=_pose(),
        miss_mask=np.ones((rows, cols), bool), tokens=4))
    resp = main.preview_pointcloud(main.PointCloudPreviewRequest(file_path=str(src)))
    assert resp.sample_rows
    assert all(len(r) == 4 for r in resp.sample_rows)


def test_preview_reports_four_column_files(tmp_path):
    rows, cols = 8, 9
    zen, az = _simple(rows, cols)
    src = _write_ptx(tmp_path / "p4.ptx", dict(
        zen=zen, az=az, rng=np.full((rows, cols), 5.0), pose=_pose(), tokens=4))
    resp = main.preview_pointcloud(main.PointCloudPreviewRequest(file_path=str(src)))
    assert [c.detected_role for c in resp.columns] == ["x", "y", "z", "intensity"]


def test_suggested_shift_comes_from_the_pose_not_the_body(tmp_path):
    """PTX coordinates are scanner-local (small); the registered world position
    is the header translation, so that is the only shift signal — and reading it
    is O(1)."""
    rows, cols = 8, 9
    zen, az = _simple(rows, cols)
    kw = dict(zen=zen, az=az, rng=np.full((rows, cols), 5.0), tokens=4)
    far = _write_ptx(tmp_path / "utm.ptx",
                     dict(pose=_pose(t=(512345.6, 4212345.7, 120.0)), **kw))
    near = _write_ptx(tmp_path / "loc.ptx", dict(pose=_pose(t=(1.0, 2.0, 3.0)), **kw))
    r_far = main.preview_pointcloud(main.PointCloudPreviewRequest(file_path=str(far)))
    r_near = main.preview_pointcloud(main.PointCloudPreviewRequest(file_path=str(near)))
    assert r_far.suggested_shift == [512345.0, 4212345.0, 120.0]
    assert r_near.suggested_shift is None   # unregistered/local: nothing to suggest


@pytest.mark.asyncio
async def test_create_session_keeps_misses_out_of_the_octree(tmp_path, monkeypatch):
    rows, cols = 20, 30
    zen, az = _simple(rows, cols)
    miss = np.zeros((rows, cols), bool)
    miss[5:9, 10:16] = True
    trans = (7.0, -3.0, 2.0)
    src = _write_ptx(tmp_path / "e2e.ptx", dict(
        zen=zen, az=az, rng=np.full((rows, cols), 6.0), pose=_pose(t=trans),
        miss_mask=miss))

    captured = {}

    def _fake_build(las_path, extra_dims_meta, **kw):
        with laspy.open(str(las_path)) as rd:
            las = rd.read()
        if "n" not in captured:
            captured["n"] = len(las.x)
            captured["extent"] = max(
                float(np.ptp(las.x)), float(np.ptp(las.y)), float(np.ptp(las.z)))
        return "fakecache", tmp_path / "cache", {"point_count": len(las.x)}

    monkeypatch.setattr(main, "_build_octree_from_las", _fake_build)
    res = await _create_session_direct(main.CloudSessionCreateRequest(source_path=str(src)))

    n_miss = int(miss.sum())
    assert captured["n"] == rows * cols - n_miss    # hits only
    assert captured["extent"] < 100.0               # no 20 km coordinate leaked in
    assert res["has_misses"] is True
    assert res["miss_count"] == n_miss
    np.testing.assert_allclose(res["scan_origin"], trans, atol=1e-6)
    assert res["scan_params"]["n_theta"] == rows
    sess = main._cloud_sessions[res["session_id"]]
    assert len(sess.positions) == rows * cols
    # row/column indices survive into the session for the C++ grid recovery.
    assert "row_index" in sess.extras and "column_index" in sess.extras
