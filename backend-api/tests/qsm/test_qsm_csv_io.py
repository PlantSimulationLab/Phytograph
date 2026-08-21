"""QSM CSV import (qsm/csv_io.py) -- the inverse of the renderer's CSV export.

The headline property is a LOSSLESS ROUND TRIP: serialize a known QSM to the exact
CSV layout src/renderer/lib/qsmExport.ts writes, read it back, and get the same
model -- same cylinders, same shoot topology, same metrics. Everything else here
guards a specific way that round trip could silently degrade (row order lost,
ranks rejected, null quality columns coerced to 0.0).

The CSV writer below is a deliberate duplicate of the TypeScript exporter rather
than a call into it: it pins the on-disk contract, so if the renderer's header or
column order changes, these tests fail and force the reader to be updated too.
"""

from __future__ import annotations

import numpy as np
import pytest

from qsm.csv_io import QSMCsvError, parse_qsm_csv, read_qsm_csv
from qsm.metrics import compute_metrics
from qsm.model import NO_PARENT, Cylinder, QSM, Shoot
from qsm.validation.synthetic import simple_tree


# Mirrors CSV_HEADER in src/renderer/lib/qsmExport.ts.
CSV_HEADER = (
    "ID,parentID,branchID,branchOrder,segmentID,parentSegmentID,"
    "startX,startY,startZ,endX,endY,endZ,"
    "axisX,axisY,axisZ,radius,length,surfaceCoverage,meanAbsDeviation"
)


def _num(x: float) -> str:
    """repr() round-trips a float64 exactly, matching JS String(number)."""
    return repr(float(x))


def qsm_to_csv(qsm: QSM) -> str:
    """Serialize exactly as qsmToCylinderCsv does (qsmExport.ts:162)."""
    parent_of_shoot = {s.shoot_id: s.parent_shoot_id for s in qsm.shoots}
    lines = [CSV_HEADER]
    for c in qsm.cylinders:
        axis = c.axis
        lines.append(",".join([
            str(c.cyl_id),
            str(c.parent_id),
            str(c.shoot_id),                                  # branchID
            str(c.rank),                                      # branchOrder
            str(c.shoot_id),                                  # segmentID
            str(parent_of_shoot.get(c.shoot_id, NO_PARENT)),  # parentSegmentID
            _num(c.start[0]), _num(c.start[1]), _num(c.start[2]),
            _num(c.end[0]), _num(c.end[1]), _num(c.end[2]),
            _num(axis[0]), _num(axis[1]), _num(axis[2]),
            _num(c.radius),
            _num(c.length),
            "" if c.surf_cov is None else _num(c.surf_cov),
            "" if c.mad is None else _num(c.mad),
        ]))
    return "\n".join(lines) + "\n"


def continuation_tree() -> QSM:
    """A trunk that CONTINUES across a fork: the continuation child keeps rank 0.

    simple_tree() only ever increments rank, so it cannot detect a reader that
    enforces the `child.rank == parent.rank + 1` invariant from
    validation.gt_io._validate. Real Phytograph QSMs continue axes, so a reader
    that rejects this shape would reject the app's own exports.
    """
    cylinders = [
        # Trunk shoot 0, rank 0.
        Cylinder(cyl_id=0, start=[0, 0, 0], end=[0, 0, 1], radius=0.05,
                 parent_id=NO_PARENT, shoot_id=0, rank=0),
        Cylinder(cyl_id=1, start=[0, 0, 1], end=[0, 0, 2], radius=0.04,
                 parent_id=0, shoot_id=0, rank=0),
        # Shoot 1 continues the trunk: SAME rank 0, new shoot id.
        Cylinder(cyl_id=2, start=[0, 0, 2], end=[0, 0, 3], radius=0.03,
                 parent_id=1, shoot_id=1, rank=0),
        # Shoot 2 is a true lateral off cylinder 1: rank 1.
        Cylinder(cyl_id=3, start=[0, 0, 2], end=[1, 0, 2.5], radius=0.02,
                 parent_id=1, shoot_id=2, rank=1),
        Cylinder(cyl_id=4, start=[1, 0, 2.5], end=[2, 0, 3.0], radius=0.015,
                 parent_id=3, shoot_id=2, rank=1),
    ]
    shoots = [
        Shoot(shoot_id=0, rank=0, cylinder_ids=[0, 1],
              parent_shoot_id=NO_PARENT, parent_cyl_id=NO_PARENT,
              child_shoot_ids=[1, 2]),
        Shoot(shoot_id=1, rank=0, cylinder_ids=[2],
              parent_shoot_id=0, parent_cyl_id=1),
        Shoot(shoot_id=2, rank=1, cylinder_ids=[3, 4],
              parent_shoot_id=0, parent_cyl_id=1),
    ]
    return QSM(cylinders=cylinders, shoots=shoots)


def assert_qsm_equal(got: QSM, want: QSM) -> None:
    """Full structural equality: cylinders, shoot topology, ordering."""
    assert len(got.cylinders) == len(want.cylinders)
    for g, w in zip(got.cylinders, want.cylinders):
        assert g.cyl_id == w.cyl_id
        assert g.parent_id == w.parent_id
        assert g.shoot_id == w.shoot_id
        assert g.rank == w.rank
        np.testing.assert_allclose(g.start, w.start, rtol=0, atol=1e-12)
        np.testing.assert_allclose(g.end, w.end, rtol=0, atol=1e-12)
        assert g.radius == pytest.approx(w.radius, abs=1e-12)
        if w.surf_cov is None:
            assert g.surf_cov is None
        else:
            assert g.surf_cov == pytest.approx(w.surf_cov, abs=1e-12)
        if w.mad is None:
            assert g.mad is None
        else:
            assert g.mad == pytest.approx(w.mad, abs=1e-12)

    assert len(got.shoots) == len(want.shoots)
    got_shoots = {s.shoot_id: s for s in got.shoots}
    for w in want.shoots:
        g = got_shoots[w.shoot_id]
        assert g.rank == w.rank
        assert g.cylinder_ids == w.cylinder_ids, f"shoot {w.shoot_id} ordering"
        assert g.parent_shoot_id == w.parent_shoot_id
        assert g.parent_cyl_id == w.parent_cyl_id
        assert sorted(g.child_shoot_ids) == sorted(w.child_shoot_ids)


# ---------------------------------------------------------------- round trip

def test_round_trip_preserves_the_whole_model():
    """Export -> import returns an identical QSM. The headline property."""
    original = simple_tree()
    assert_qsm_equal(parse_qsm_csv(qsm_to_csv(original)), original)


def test_round_trip_preserves_metrics():
    """The results panel must show identical numbers after a re-import."""
    original = simple_tree()
    want = compute_metrics(original)
    got = compute_metrics(parse_qsm_csv(qsm_to_csv(original)))

    for field in (
        "tcsa_m2", "trunk_diameter_mm", "tree_height_m", "n_scaffolds",
        "n_shoots_total", "max_rank", "total_woody_volume_m3", "stem_volume_m3",
        "branch_volume_m3", "total_length_m", "canopy_width_m", "canopy_height_m",
    ):
        assert getattr(got, field) == pytest.approx(getattr(want, field), rel=1e-9), field

    assert len(got.per_rank) == len(want.per_rank)
    for g, w in zip(got.per_rank, want.per_rank):
        assert g.rank == w.rank
        assert g.n_shoots == w.n_shoots
        for field in ("total_length_m", "mean_shoot_length_m", "woody_volume_m3",
                      "mean_diameter_mm"):
            assert getattr(g, field) == pytest.approx(getattr(w, field), rel=1e-9), field
        if w.mean_branch_angle_deg is None:
            assert g.mean_branch_angle_deg is None
        else:
            assert g.mean_branch_angle_deg == pytest.approx(
                w.mean_branch_angle_deg, rel=1e-9
            )


def test_round_trip_preserves_axis_continuation_ranks():
    """A continuation shoot keeps its parent's rank; the reader must allow it.

    Fails if validation.gt_io._validate (child.rank == parent.rank + 1) is ever
    wired into the CSV path.
    """
    original = continuation_tree()
    got = parse_qsm_csv(qsm_to_csv(original))
    assert_qsm_equal(got, original)

    by_id = {s.shoot_id: s for s in got.shoots}
    assert by_id[1].rank == by_id[0].rank == 0  # continuation kept rank 0
    assert by_id[1].parent_shoot_id == 0
    assert by_id[2].rank == 1                    # the true lateral did not


def test_round_trip_preserves_shoot_and_rank_for_every_cylinder():
    """The two viewer color modes read cylinder.shoot_id and cylinder.rank."""
    original = simple_tree()
    got = parse_qsm_csv(qsm_to_csv(original))
    assert [c.shoot_id for c in got.cylinders] == [c.shoot_id for c in original.cylinders]
    assert [c.rank for c in got.cylinders] == [c.rank for c in original.cylinders]


def test_round_trip_preserves_null_quality_columns():
    """surf_cov / mad are written as '' when None and must come back None, not 0.0."""
    original = simple_tree()
    original.cylinders[0].surf_cov = 0.87
    original.cylinders[0].mad = 0.0031
    original.cylinders[1].surf_cov = None
    original.cylinders[1].mad = None

    got = parse_qsm_csv(qsm_to_csv(original))
    assert got.cylinders[0].surf_cov == pytest.approx(0.87)
    assert got.cylinders[0].mad == pytest.approx(0.0031)
    assert got.cylinders[1].surf_cov is None
    assert got.cylinders[1].mad is None


def test_round_trip_preserves_utm_magnitude_coordinates():
    """Exported coordinates are absolute world-frame and can be UTM-sized; the
    text round trip must not lose millimeters at 1e6 magnitude."""
    original = simple_tree()
    offset = np.array([548123.456789, 4183456.123456, 87.654321])
    for c in original.cylinders:
        c.start = c.start + offset
        c.end = c.end + offset

    got = parse_qsm_csv(qsm_to_csv(original))
    for g, w in zip(got.cylinders, original.cylinders):
        np.testing.assert_allclose(g.start, w.start, rtol=0, atol=1e-9)
        np.testing.assert_allclose(g.end, w.end, rtol=0, atol=1e-9)


def test_row_order_is_preserved_as_base_to_tip_ordering():
    """Row order is the ONLY encoding of base->tip order; the reader must not sort.

    QSM3D.buildShootPolylines assumes cylinder_ids run base->tip; a scrambled
    order draws a giant span across the tree (QSM3D.test.ts has the mirror test).
    """
    original = simple_tree()
    got = parse_qsm_csv(qsm_to_csv(original))

    trunk = next(s for s in got.shoots if s.rank == 0)
    by_id = got.cylinder_by_id()
    zs = [by_id[cid].start[2] for cid in trunk.cylinder_ids]
    assert zs == sorted(zs), "trunk cylinders must run base->tip"

    # Each cylinder's start must meet the previous one's end.
    for prev_id, cur_id in zip(trunk.cylinder_ids, trunk.cylinder_ids[1:]):
        np.testing.assert_allclose(by_id[cur_id].start, by_id[prev_id].end, atol=1e-9)


def test_reversed_rows_are_not_silently_reordered():
    """A file whose rows are tip->base keeps that order rather than being sorted
    into ids -- the reader trusts row order, and this pins that it really does."""
    original = simple_tree()
    reversed_qsm = QSM(cylinders=list(reversed(original.cylinders)),
                       shoots=original.shoots)
    got = parse_qsm_csv(qsm_to_csv(reversed_qsm))
    assert [c.cyl_id for c in got.cylinders] == [
        c.cyl_id for c in reversed_qsm.cylinders
    ]


def test_parent_cyl_id_is_the_fork_cylinder():
    """parent_cyl_id comes straight from the first cylinder's parentID column."""
    original = simple_tree()
    got = parse_qsm_csv(qsm_to_csv(original))
    by_id = got.cylinder_by_id()
    for s in got.shoots:
        if s.parent_shoot_id == NO_PARENT:
            assert s.parent_cyl_id == NO_PARENT
            continue
        assert s.parent_cyl_id == by_id[s.cylinder_ids[0]].parent_id
        assert by_id[s.parent_cyl_id].shoot_id == s.parent_shoot_id


def test_child_shoot_ids_are_derived_and_consistent():
    got = parse_qsm_csv(qsm_to_csv(simple_tree()))
    by_id = {s.shoot_id: s for s in got.shoots}
    for s in got.shoots:
        for child in s.child_shoot_ids:
            assert by_id[child].parent_shoot_id == s.shoot_id
        if s.parent_shoot_id != NO_PARENT:
            assert s.shoot_id in by_id[s.parent_shoot_id].child_shoot_ids


def test_read_qsm_csv_from_disk(tmp_path):
    original = simple_tree()
    path = tmp_path / "tree.csv"
    path.write_text(qsm_to_csv(original), encoding="utf-8")
    assert_qsm_equal(read_qsm_csv(path), original)


# ------------------------------------------------------------ dialects

def test_accepts_lowercase_and_underscored_headers():
    csv_text = (
        "id,parent_id,branch_id,branch_order,segment_id,parent_segment_id,"
        "start_x,start_y,start_z,end_x,end_y,end_z,radius\n"
        "0,-1,0,0,0,-1,0,0,0,0,0,1,0.05\n"
        "1,0,1,1,1,0,0,0,1,1,0,1.5,0.02\n"
    )
    qsm = parse_qsm_csv(csv_text)
    assert len(qsm.cylinders) == 2
    assert qsm.cylinders[1].rank == 1
    assert qsm.cylinders[1].parent_id == 0
    assert {s.shoot_id for s in qsm.shoots} == {0, 1}


def test_accepts_semicolon_delimiter():
    csv_text = (
        "ID;parentID;branchID;branchOrder;segmentID;parentSegmentID;"
        "startX;startY;startZ;endX;endY;endZ;radius\n"
        "0;-1;0;0;0;-1;0;0;0;0;0;1;0.05\n"
    )
    qsm = parse_qsm_csv(csv_text)
    assert len(qsm.cylinders) == 1
    assert qsm.cylinders[0].radius == pytest.approx(0.05)


def test_accepts_a_realistic_third_party_dialect():
    """An rTwig/TreeQSM-style file: semicolon-delimited, snake_case, columns in a
    different order, 1-BASED ids, and extra derived columns we don't consume."""
    csv_text = (
        "start_x;start_y;start_z;end_x;end_y;end_z;radius;ID;parentID;"
        "branchID;branchOrder;segmentID;parentSegmentID;growthLength;reverseBranchOrder\n"
        "0;0;0;0;0;1.2;0.061;1;-1;1;0;1;-1;5.4;3\n"
        "0;0;1.2;0;0;2.1;0.052;2;1;1;0;1;-1;4.2;3\n"
        "0;0;2.1;0.9;0;2.6;0.024;3;2;2;1;2;1;1.8;2\n"
        "0.9;0;2.6;1.5;0.4;2.9;0.013;4;3;3;2;3;2;0.7;1\n"
    )
    qsm = parse_qsm_csv(csv_text)
    assert len(qsm.cylinders) == 4
    assert len(qsm.shoots) == 3

    # 1-based ids are preserved as-is, not renumbered onto our 0-based convention.
    assert [c.cyl_id for c in qsm.cylinders] == [1, 2, 3, 4]
    assert qsm.cylinders[0].parent_id == NO_PARENT

    by_id = {s.shoot_id: s for s in qsm.shoots}
    assert by_id[1].rank == 0 and by_id[1].cylinder_ids == [1, 2]
    assert by_id[2].parent_shoot_id == 1 and by_id[2].parent_cyl_id == 2
    assert by_id[3].rank == 2

    m = compute_metrics(qsm)
    assert m.max_rank == 2
    assert m.tree_height_m == pytest.approx(2.9, abs=1e-6)
    assert m.trunk_diameter_mm == pytest.approx(122.0, abs=0.1)


def test_accepts_bom_prefixed_header():
    """Excel writes a UTF-8 BOM on the first cell; it must not break `ID`."""
    csv_text = (
        "﻿ID,parentID,branchID,branchOrder,startX,startY,startZ,"
        "endX,endY,endZ,radius\n"
        "0,-1,0,0,0,0,0,0,0,1,0.05\n"
    )
    assert len(parse_qsm_csv(csv_text).cylinders) == 1


def test_ignores_derived_axis_and_length_columns():
    """axis/length are recomputed from start/end, so a wrong value in the file
    cannot corrupt the model."""
    csv_text = (
        "ID,parentID,branchID,branchOrder,startX,startY,startZ,endX,endY,endZ,"
        "axisX,axisY,axisZ,radius,length\n"
        "0,-1,0,0,0,0,0,0,0,2,999,999,999,0.05,12345\n"
    )
    c = parse_qsm_csv(csv_text).cylinders[0]
    assert c.length == pytest.approx(2.0)
    np.testing.assert_allclose(c.axis, [0, 0, 1], atol=1e-12)


def test_ignores_unknown_trailing_columns_and_blank_lines():
    csv_text = (
        "ID,parentID,branchID,branchOrder,startX,startY,startZ,endX,endY,endZ,"
        "radius,growthLength,reverseBranchOrder\n"
        "0,-1,0,0,0,0,0,0,0,1,0.05,3.2,2\n"
        "\n"
        "1,0,0,0,0,0,1,0,0,2,0.04,1.1,1\n"
    )
    qsm = parse_qsm_csv(csv_text)
    assert len(qsm.cylinders) == 2


def test_derives_shoots_when_no_shoot_column_present():
    """A dialect with neither segmentID nor branchID: shoots come from topology.

    Trunk 0->1 continues (same rank), 2 forks off at rank 1 and 3 continues it.
    """
    csv_text = (
        "ID,parentID,branchOrder,startX,startY,startZ,endX,endY,endZ,radius\n"
        "0,-1,0,0,0,0,0,0,1,0.05\n"
        "1,0,0,0,0,1,0,0,2,0.04\n"
        "2,1,1,0,0,2,1,0,2.5,0.02\n"
        "3,2,1,1,0,2.5,2,0,3,0.015\n"
    )
    qsm = parse_qsm_csv(csv_text)
    by_id = qsm.cylinder_by_id()

    # 0 and 1 share the trunk shoot; 2 and 3 share the lateral shoot.
    assert by_id[0].shoot_id == by_id[1].shoot_id
    assert by_id[2].shoot_id == by_id[3].shoot_id
    assert by_id[0].shoot_id != by_id[2].shoot_id
    assert len(qsm.shoots) == 2

    lateral = next(s for s in qsm.shoots if s.rank == 1)
    assert lateral.cylinder_ids == [2, 3]
    assert lateral.parent_shoot_id == by_id[0].shoot_id
    assert lateral.parent_cyl_id == 1


def test_derives_shoots_when_rows_are_not_parent_first():
    """Shoot derivation must not assume a parent's row precedes its children's.

    A third-party file with no shoot column is free to order rows any way it
    likes (we already accept tip->base order when a shoot column IS present).
    Before this was handled, an unresolved parent left a None shoot id and the
    reader died with a TypeError -- an HTTP 500 with a stack trace instead of the
    parse error the module is designed to raise.
    """
    csv_text = (
        "ID,parentID,branchOrder,startX,startY,startZ,endX,endY,endZ,radius\n"
        "2,1,1,0,0,2,1,0,2.5,0.02\n"   # child listed FIRST
        "1,0,0,0,0,1,0,0,2,0.04\n"
        "0,-1,0,0,0,0,0,0,1,0.05\n"    # root listed LAST
    )
    qsm = parse_qsm_csv(csv_text)
    by_id = qsm.cylinder_by_id()

    # 0 and 1 are the same rank-0 axis; 2 forks off at rank 1.
    assert by_id[0].shoot_id == by_id[1].shoot_id
    assert by_id[2].shoot_id != by_id[0].shoot_id
    assert len(qsm.shoots) == 2

    lateral = next(s for s in qsm.shoots if s.rank == 1)
    assert lateral.cylinder_ids == [2]
    assert lateral.parent_shoot_id == by_id[0].shoot_id
    assert lateral.parent_cyl_id == 1
    # Every cylinder got a real shoot id (no None leaked through).
    assert all(isinstance(c.shoot_id, int) for c in qsm.cylinders)


def test_derived_shoots_split_second_child_of_a_fork():
    """Two children of one parent at the same rank: only the first continues."""
    csv_text = (
        "ID,parentID,branchOrder,startX,startY,startZ,endX,endY,endZ,radius\n"
        "0,-1,0,0,0,0,0,0,1,0.05\n"
        "1,0,0,0,0,1,0,0,2,0.04\n"
        "2,0,0,0,0,1,1,0,1.5,0.03\n"
    )
    qsm = parse_qsm_csv(csv_text)
    by_id = qsm.cylinder_by_id()
    assert by_id[1].shoot_id == by_id[0].shoot_id   # continuation
    assert by_id[2].shoot_id != by_id[0].shoot_id   # second child starts a shoot


def test_trunk_self_referencing_parent_segment_is_treated_as_no_parent():
    """Some exporters write the trunk's own id in parentSegmentID."""
    csv_text = (
        "ID,parentID,branchID,branchOrder,segmentID,parentSegmentID,"
        "startX,startY,startZ,endX,endY,endZ,radius\n"
        "0,-1,0,0,0,0,0,0,0,0,0,1,0.05\n"
    )
    trunk = parse_qsm_csv(csv_text).shoots[0]
    assert trunk.parent_shoot_id == NO_PARENT
    assert trunk.parent_cyl_id == NO_PARENT


def test_integer_columns_written_as_floats_are_accepted():
    csv_text = (
        "ID,parentID,branchID,branchOrder,startX,startY,startZ,endX,endY,endZ,radius\n"
        "0.0,-1.0,0.0,0.0,0,0,0,0,0,1,0.05\n"
    )
    c = parse_qsm_csv(csv_text).cylinders[0]
    assert c.cyl_id == 0 and c.parent_id == NO_PARENT and c.rank == 0


# ------------------------------------------------------------ rejection

def test_rejects_point_cloud_csv():
    """The wrong kind of CSV must fail with a clear message, not a stack trace."""
    csv_text = "x,y,z,intensity\n1.0,2.0,3.0,120\n4.0,5.0,6.0,130\n"
    with pytest.raises(QSMCsvError, match="missing required column"):
        parse_qsm_csv(csv_text)


def test_rejects_missing_required_column_naming_it():
    csv_text = (
        "ID,parentID,branchID,branchOrder,startX,startY,startZ,endX,endY,endZ\n"
        "0,-1,0,0,0,0,0,0,0,1\n"
    )
    with pytest.raises(QSMCsvError, match="radius"):
        parse_qsm_csv(csv_text)


def test_rejects_non_numeric_cell():
    csv_text = (
        "ID,parentID,branchID,branchOrder,startX,startY,startZ,endX,endY,endZ,radius\n"
        "0,-1,0,0,0,0,0,0,0,1,thick\n"
    )
    with pytest.raises(QSMCsvError, match="radius"):
        parse_qsm_csv(csv_text)


def test_rejects_cyclic_parent_chain():
    csv_text = (
        "ID,parentID,branchID,branchOrder,startX,startY,startZ,endX,endY,endZ,radius\n"
        "0,1,0,0,0,0,0,0,0,1,0.05\n"
        "1,0,0,0,0,0,1,0,0,2,0.04\n"
    )
    with pytest.raises(QSMCsvError, match="cycle"):
        parse_qsm_csv(csv_text)


def test_rejects_dangling_parent_id():
    csv_text = (
        "ID,parentID,branchID,branchOrder,startX,startY,startZ,endX,endY,endZ,radius\n"
        "0,-1,0,0,0,0,0,0,0,1,0.05\n"
        "1,99,0,0,0,0,1,0,0,2,0.04\n"
    )
    with pytest.raises(QSMCsvError, match="unknown parentID"):
        parse_qsm_csv(csv_text)


def test_rejects_non_positive_radius():
    csv_text = (
        "ID,parentID,branchID,branchOrder,startX,startY,startZ,endX,endY,endZ,radius\n"
        "0,-1,0,0,0,0,0,0,0,1,0\n"
    )
    with pytest.raises(QSMCsvError, match="radius"):
        parse_qsm_csv(csv_text)


def test_rejects_duplicate_cylinder_ids():
    csv_text = (
        "ID,parentID,branchID,branchOrder,startX,startY,startZ,endX,endY,endZ,radius\n"
        "0,-1,0,0,0,0,0,0,0,1,0.05\n"
        "0,-1,0,0,0,0,1,0,0,2,0.04\n"
    )
    with pytest.raises(QSMCsvError, match="duplicate"):
        parse_qsm_csv(csv_text)


def test_rejects_empty_file():
    with pytest.raises(QSMCsvError, match="empty"):
        parse_qsm_csv("")


def test_rejects_header_only_file():
    with pytest.raises(QSMCsvError, match="no cylinder rows"):
        parse_qsm_csv(CSV_HEADER + "\n")
