"""Tests for importing per-point beam-origin columns (ox/oy/oz) from ASCII/CSV/
XYZ point clouds, so they feed the LAD inversion exactly like the LAS ExtraBytes
ox/oy/oz path (see test_beam_origins.py).

The CRITICAL contract is precision: the ASCII -> LAS conversion writes a 1 mm-
quantized LAS and stores extra dims as float32, so beam origins (world/UTM
coordinates) must NOT ride through the float32 extras. They are instead captured
straight from the source columns into a float64 side-channel (`capture_origins`),
mirroring `capture_full_xyz` for positions. These exercise the in-RAM IO helpers
directly (no PotreeConverter / octree).
"""

import time
from pathlib import Path

import numpy as np
import pytest

import main
from main import ColumnPlan, ColumnPlanEntry

laspy = pytest.importorskip("laspy")


# Five points at UTM scale. Origins sit ~30 m above/away from the xyz returns and
# step by 0.01 m — a magnitude where float32 loses ~decimeters, so a correct
# round-trip PROVES the float64 side-channel (float32 would collapse the steps).
# Columns: x y z ox oy oz.
_BASE_XYZ = np.array([456789.111, 5432109.222, 412.333], dtype=np.float64)
_BASE_ORIGIN = np.array([456800.444, 5432140.555, 442.666], dtype=np.float64)
_N = 5
_XYZ = _BASE_XYZ + np.column_stack([np.arange(_N) * 0.01,
                                    np.arange(_N) * 0.02,
                                    np.zeros(_N)])
_ORIGINS = _BASE_ORIGIN + np.column_stack([np.arange(_N) * 0.01,
                                           np.zeros(_N),
                                           np.arange(_N) * 0.03])
_FORMAT = "x y z ox oy oz"


def _write_origin_xyz(path: Path) -> None:
    rows = []
    for i in range(_N):
        rows.append(" ".join(
            f"{v:.3f}" for v in (*_XYZ[i].tolist(), *_ORIGINS[i].tolist())))
    path.write_text("\n".join(rows) + "\n")


def _origin_plan() -> ColumnPlan:
    """The column plan the wizard sends when the user picks the three origin roles."""
    cols = [
        ColumnPlanEntry(index=0, role='x', slug=None, label=None, categorical=False),
        ColumnPlanEntry(index=1, role='y', slug=None, label=None, categorical=False),
        ColumnPlanEntry(index=2, role='z', slug=None, label=None, categorical=False),
        ColumnPlanEntry(index=3, role='origin_x', slug=None, label=None, categorical=False),
        ColumnPlanEntry(index=4, role='origin_y', slug=None, label=None, categorical=False),
        ColumnPlanEntry(index=5, role='origin_z', slug=None, label=None, categorical=False),
    ]
    return ColumnPlan(columns=cols, rgb_is_255=True)


# --------------------------------------------------------------------------- #
# Column planning: origins ride as origin:* sentinel tokens, NOT extra dims
# --------------------------------------------------------------------------- #

def test_column_plan_emits_origin_sentinels_not_extras():
    """The wizard's origin_x/y/z roles emit `origin:<canonical>` tokens in `names`
    (so the streaming reader captures them) and add NO extra dims (origins are
    float64, never float32 LAS extras)."""
    names, extras = main._plan_columns_from_column_plan(_origin_plan())
    assert names[:3] == ["x", "y", "z"]
    assert names[3:] == ["origin:origin_x", "origin:origin_y", "origin:origin_z"]
    # No origin slug leaked into the float32 extra dims.
    assert extras == []


def test_origin_role_via_extra_slug_also_recognised():
    """An 'extra' column whose slug is an ox/oy/oz alias is canonicalised to an
    origin sentinel too (mirrors the multi-return / grid handling)."""
    cols = [
        ColumnPlanEntry(index=0, role='x', slug=None, label=None, categorical=False),
        ColumnPlanEntry(index=1, role='y', slug=None, label=None, categorical=False),
        ColumnPlanEntry(index=2, role='z', slug=None, label=None, categorical=False),
        ColumnPlanEntry(index=3, role='extra', slug='XOrigin', label='X Origin', categorical=False),
        ColumnPlanEntry(index=4, role='extra', slug='YOrigin', label='Y Origin', categorical=False),
        ColumnPlanEntry(index=5, role='extra', slug='ZOrigin', label='Z Origin', categorical=False),
    ]
    names, extras = main._plan_columns_from_column_plan(ColumnPlan(columns=cols, rgb_is_255=True))
    assert names[3:] == ["origin:origin_x", "origin:origin_y", "origin:origin_z"]
    assert extras == []


@pytest.mark.parametrize("header,expected", [
    ("ox", "origin_x"), ("oy", "origin_y"), ("oz", "origin_z"),
    ("XOrigin", "origin_x"), ("YOrigin", "origin_y"), ("ZOrigin", "origin_z"),
    ("BeamOriginX", "origin_x"), ("BeamOriginZ", "origin_z"),
])
def test_role_from_header_name_recognises_origin_aliases(header, expected):
    assert main._role_from_header_name(header) == expected


def test_preview_reports_origin_roles_for_wizard(client, tmp_path):
    """The preview endpoint pre-selects the dedicated Beam Origin X/Y/Z roles (not
    the generic 'extra') so the wizard dropdown lands on them for an ox/oy/oz
    header — mirroring the grid-index / miss preview pre-selection."""
    f = tmp_path / "origins.xyz"
    f.write_text(
        "X Y Z ox oy oz\n"
        "0 0 0 1 2 3\n"
        "1 1 1 1 2 3\n"
    )
    res = client.post("/api/pointcloud/preview", json={"file_path": str(f)})
    assert res.status_code == 200, res.text
    cols = res.json()["columns"]
    assert [c["detected_role"] for c in cols[:3]] == ["x", "y", "z"]
    assert [c["detected_role"] for c in cols[3:6]] == ["origin_x", "origin_y", "origin_z"]
    assert cols[3]["suggested_slug"] == "origin_x"


def test_header_named_origin_columns_auto_detect(tmp_path):
    """Auto-detect (no ascii_format / no column plan): an `ox oy oz` header maps to
    the origin sentinels."""
    f = tmp_path / "hdr.xyz"
    f.write_text(
        "X Y Z ox oy oz\n"
        "0 0 0 1 2 3\n"
        "1 1 1 1 2 3\n"
    )
    names, extras = main._xyz_column_plan(f, None, None)
    assert names[:3] == ["x", "y", "z"]
    assert names[3:] == ["origin:origin_x", "origin:origin_y", "origin:origin_z"]
    assert extras == []


# --------------------------------------------------------------------------- #
# ASCII import round-trip: float64 origins reach the session, NOT float32 extras
# --------------------------------------------------------------------------- #

def _build_session(las_path, source_origins, world_shift=None):
    """Mirror the relevant slice of create_cloud_session: read the LAS, prefer the
    captured float64 origins, apply the same world_shift to positions + origins."""
    r = main._read_las_into_arrays(las_path)
    positions = r.positions
    beam_origins = r.beam_origins
    if source_origins is not None:
        assert source_origins.shape[0] == positions.shape[0]
        beam_origins = source_origins
    if world_shift is not None:
        ws = np.asarray(world_shift, dtype=np.float64)
        positions = positions - ws
        if beam_origins is not None:
            beam_origins = beam_origins - ws
    n = len(positions)
    return main.CloudSession(
        session_id="orisess",
        source_path="<test>",
        ascii_format=_FORMAT,
        column_plan=None,
        positions=positions,
        colors=r.colors,
        intensity=r.intensity,
        extras=r.extras,
        extra_dims_meta=r.extra_dims_meta,
        world_shift=(np.asarray(world_shift, dtype=np.float64)
                     if world_shift is not None else None),
        beam_origins=beam_origins,
        deleted=np.zeros(n, dtype=bool),
        deleted_history=[],
        octree_cache_id=None,
        created_at=time.time(),
    )


def test_ascii_import_preserves_float64_origins(tmp_path):
    """The full ASCII -> _source_to_las -> session path yields (N,3) float64
    beam_origins that match the input to <1 mm — proving the float64 side-channel,
    NOT a lossy float32 extra round-trip — and the origin columns are NOT in the
    session's float32 scalar extras."""
    f = tmp_path / "scan.xyz"
    _write_origin_xyz(f)
    (las_path, is_temp, source_extra_dims,
     full_xyz, source_origins) = main._source_to_las(f, _FORMAT, tmp_path, _origin_plan())

    # Captured origins: shape, dtype, sub-mm accuracy.
    assert source_origins is not None
    assert source_origins.shape == (_N, 3)
    assert source_origins.dtype == np.float64
    np.testing.assert_allclose(source_origins, _ORIGINS, rtol=0, atol=1e-4)

    # Control: float32 cannot resolve the 0.01 m steps at UTM magnitude, so a
    # float32 round-trip would NOT preserve the distinct values our float64 path does.
    assert len(np.unique(source_origins[:, 0])) == _N
    assert len(np.unique(source_origins[:, 0].astype(np.float32))) < _N

    sess = _build_session(las_path, source_origins)
    assert sess.beam_origins is not None
    assert sess.beam_origins.dtype == np.float64
    assert sess.beam_origins.shape == (_N, 3)
    np.testing.assert_allclose(sess.beam_origins, _ORIGINS, rtol=0, atol=1e-4)
    # The origin columns must NOT have leaked into the float32 scalar extras.
    for slug in main._ORIGIN_SLUGS:
        assert slug not in sess.extras
    assert not any(k.lower().startswith("o") and k.lower() in ("ox", "oy", "oz")
                   for k in sess.extras)
    if is_temp:
        Path(las_path).unlink(missing_ok=True)


def test_ascii_import_origins_share_positions_frame_under_world_shift(tmp_path):
    """beam_origins are in the SAME frame as positions: applying a world_shift
    subtracts it from BOTH, so the origin->point geometry is preserved exactly."""
    f = tmp_path / "scan.xyz"
    _write_origin_xyz(f)
    (las_path, is_temp, _ed, _fx, source_origins) = main._source_to_las(
        f, _FORMAT, tmp_path, _origin_plan())

    # Shift by the UTM base so the in-RAM arrays are small/precision-friendly.
    ws = np.floor(_BASE_XYZ)
    sess = _build_session(las_path, source_origins, world_shift=ws)

    # Origins are shifted in lockstep with positions.
    np.testing.assert_allclose(sess.beam_origins, _ORIGINS - ws, rtol=0, atol=1e-4)
    # The origin->point vector is frame-invariant (same in world and shifted frames).
    shifted_vec = sess.positions - sess.beam_origins
    world_vec = _XYZ - _ORIGINS
    np.testing.assert_allclose(shifted_vec, world_vec, rtol=0, atol=1e-4)
    if is_temp:
        Path(las_path).unlink(missing_ok=True)


def test_ascii_import_no_origins_when_absent(tmp_path):
    """A plain x y z cloud (no origin columns) captures no origins — the session
    has beam_origins=None and the LAD path falls back to the trajectory join."""
    f = tmp_path / "plain.xyz"
    f.write_text("0 0 0\n1 1 1\n2 2 2\n")
    (_lp, _it, _ed, _fx, source_origins) = main._source_to_las(f, "x y z", f.parent, None)
    assert source_origins is None


# --------------------------------------------------------------------------- #
# LAS preview: a complete ox/oy/oz triple is auto-consumed as beam_origins, so it
# must NOT appear in the wizard as user-mappable scalar columns (mirrors x/y/z and
# the is_miss flag). A LONE origin column with no full set stays a normal scalar.
# --------------------------------------------------------------------------- #

def _write_las_with_extra_dims(path: Path, names, n=4):
    """Write a tiny LAS (point format 6) carrying float64 ExtraBytes `names`."""
    hdr = laspy.LasHeader(point_format=6, version="1.4")
    for nm in names:
        hdr.add_extra_dim(laspy.ExtraBytesParams(name=nm, type=np.float64))
    d = laspy.LasData(hdr)
    d.x = np.arange(n, dtype=np.float64)
    d.y = np.arange(n, dtype=np.float64)
    d.z = np.arange(n, dtype=np.float64)
    for j, nm in enumerate(names):
        d[nm] = np.arange(n, dtype=np.float64) + j
    d.write(str(path))


def test_las_preview_hides_complete_origin_triple(client, tmp_path):
    """A LAS with a full ox/oy/oz set: the reader consumes it into float64
    beam_origins, so the wizard preview must NOT list ox/oy/oz as scalar columns —
    they're not user-mappable, exactly like x/y/z."""
    f = tmp_path / "las_origins.las"
    _write_las_with_extra_dims(f, ["ox", "oy", "oz"])
    res = client.post("/api/pointcloud/preview", json={"file_path": str(f)})
    assert res.status_code == 200, res.text
    shown = {c["header_name"].lower() for c in res.json()["columns"]}
    assert shown.isdisjoint({"ox", "oy", "oz"})
    # And the reader still captures them.
    assert main._read_las_into_arrays(str(f)).beam_origins is not None


def test_las_preview_keeps_lone_origin_column_as_scalar(client, tmp_path):
    """A LONE `ox` (no oy/oz) is NOT a beam-origin set — the reader leaves it as a
    scalar, so the wizard must still offer it as a mappable column."""
    f = tmp_path / "las_lone_ox.las"
    _write_las_with_extra_dims(f, ["ox"])
    res = client.post("/api/pointcloud/preview", json={"file_path": str(f)})
    assert res.status_code == 200, res.text
    shown = {c["header_name"].lower() for c in res.json()["columns"]}
    assert "ox" in shown
    assert main._read_las_into_arrays(str(f)).beam_origins is None


def test_las_extra_dim_labels_excludes_origin_triple(tmp_path):
    """The octree slug->label sidecar likewise omits a consumed origin triple (the
    origins aren't a renderer scalar field), but keeps other extras."""
    f = tmp_path / "las_sidecar.las"
    _write_las_with_extra_dims(f, ["ox", "oy", "oz", "treeid"])
    slugs = {d["slug"].lower() for d in main._las_extra_dim_labels(f)}
    assert slugs.isdisjoint({"ox", "oy", "oz"})
    assert "treeid" in slugs
