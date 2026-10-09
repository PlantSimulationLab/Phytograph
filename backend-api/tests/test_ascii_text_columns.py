"""A column of WORDS in an ASCII cloud imports as named classes.

A carried column is a float32 extra dimension, so a text column ('leaf', a
plant id) used to raise in the cast and take the whole import with it — the
user saw "could not convert string to float" blamed on the column format. It
is now coded 1..N with its names in a class palette, the same channel a
Phytograph LAS export's palettes arrive by.

Asserted on the real create endpoint: the fix is half in the converter and half
in the wiring that carries the palette past the intermediate LAS, which holds
only the codes.
"""

import numpy as np
import pytest
from fastapi import HTTPException

import main
from tests.binframe import decode_streamed_json

# Rows deliberately NOT grouped by label, and with ids that sort differently
# as text ('p-10' < 'p-2') than by number.
_ROWS = [
    (0.0, 0.0, 0.0, "leaf", "p-10"),
    (1.0, 0.0, 0.1, "stem", "p-2"),
    (0.0, 1.0, 0.2, "leaf", "p-2"),
    (1.0, 1.0, 0.3, "embryonic_leaf", "p-1"),
    (0.5, 0.5, 0.4, "stem", "p-10"),
    (0.2, 0.8, 0.5, "leaf", "p-1"),
]


def _write(path, rows=_ROWS, header="# x_mm y_mm z_mm category plant\n"):
    path.write_text(header + "".join(" ".join(str(v) for v in r) + "\n" for r in rows))
    return path


def _plan(**slugs):
    cols = [{"index": 0, "role": "x"}, {"index": 1, "role": "y"}, {"index": 2, "role": "z"}]
    for i, (slug, categorical) in enumerate(slugs.items()):
        cols.append({"index": 3 + i, "role": "extra", "slug": slug, "label": slug,
                     "categorical": categorical})
    return {"columns": cols}


def _create(client, path, **body):
    res = client.post("/api/cloud/session/create-multi",
                      json={"source_path": str(path), **body})
    assert res.status_code == 200, res.text
    scans = decode_streamed_json(res.content)["scans"]
    assert len(scans) == 1 and not scans[0].get("error"), scans
    return scans[0]["session"]


def test_text_columns_import_as_named_classes(client, tmp_path):
    p = _write(tmp_path / "labeled.txt")
    meta = _create(client, p, column_plan=_plan(category=True, plant=True))
    try:
        sess = main._cloud_sessions[meta["session_id"]]
        assert len(sess.positions) == len(_ROWS)

        pal = meta["class_palettes"]
        names = {slug: {c["label"]: c["value"] for c in pal[slug]["classes"]}
                 for slug in ("category", "plant")}
        # 0 stays Unclassified; names take 1..N in natural-sorted order, so
        # 'p-2' precedes 'p-10'.
        assert names["category"] == {
            "Unclassified": 0, "embryonic_leaf": 1, "leaf": 2, "stem": 3}
        assert names["plant"] == {"Unclassified": 0, "p-1": 1, "p-2": 2, "p-10": 3}

        # Each point carries the code of ITS OWN row's name.
        for slug, col in (("category", 3), ("plant", 4)):
            want = [names[slug][r[col]] for r in _ROWS]
            assert np.asarray(sess.extras[slug]).astype(int).tolist() == want

        # Only the classes that own a point are listed - no phantom class 0.
        assert meta["observed_classes"]["category"] == [1, 2, 3]
        assert meta["observed_classes"]["plant"] == [1, 2, 3]
    finally:
        main._cloud_sessions.pop(meta["session_id"], None)


def test_text_column_imports_without_a_wizard_plan(client, tmp_path):
    """The auto-detected layout names the columns from the '# x_mm ...' header
    and carries the text ones the same way."""
    p = _write(tmp_path / "auto.txt")
    meta = _create(client, p)
    try:
        assert {c["label"] for c in meta["class_palettes"]["category"]["classes"]} == {
            "Unclassified", "embryonic_leaf", "leaf", "stem"}
        assert "plant" in meta["class_palettes"]
    finally:
        main._cloud_sessions.pop(meta["session_id"], None)


def test_numeric_looking_names_keep_their_spelling(tmp_path):
    """One word in the column makes it text, and then '007' is a name, not 7."""
    rows = [(0, 0, 0, "007"), (1, 0, 0, "7"), (0, 1, 0, "x")]
    p = _write(tmp_path / "ids.txt", rows, header="")
    plan = main.ColumnPlan(**{"columns": _plan(tag=True)["columns"]})
    _, dims, _, _ = main._xyz_to_las(p, None, tmp_path / "o.las", plan)
    labels = [c["label"] for c in dims[0]["palette"]["classes"]]
    assert labels[0] == "Unclassified" and sorted(labels[1:]) == ["007", "7", "x"]


def test_headerless_file_keeps_its_first_labeled_row(tmp_path):
    """'0 0 0 leaf' has a token that is not a number, which used to make it the
    column legend: the point was skipped and its values became the names."""
    p = _write(tmp_path / "bare.txt", header="")
    assert main._ascii_skiprows(str(p)) == 0
    assert main._read_ascii_header_names(str(p)) is None
    plan = main.ColumnPlan(**{"columns": _plan(category=True, plant=True)["columns"]})
    n, _, _, _ = main._xyz_to_las(p, None, tmp_path / "o.las", plan)
    assert n == len(_ROWS)


def test_numeric_label_column_is_untouched(tmp_path):
    """A column of class NUMBERS keeps its own values and gets no palette."""
    rows = [(0, 0, 0, 5), (1, 0, 0, 9), (0, 1, 0, 5)]
    p = _write(tmp_path / "num.txt", rows, header="")
    plan = main.ColumnPlan(**{"columns": _plan(cls=True)["columns"]})
    import laspy
    _, dims, _, _ = main._xyz_to_las(p, None, tmp_path / "o.las", plan)
    assert "palette" not in dims[0]
    assert np.asarray(laspy.read(str(tmp_path / "o.las"))["cls"]).tolist() == [5.0, 9.0, 5.0]


def test_free_text_column_is_refused_by_name(tmp_path):
    rows = [(i, 0, 0, f"note-{i}") for i in range(main._TEXT_COLUMN_MAX_CLASSES + 1)]
    p = _write(tmp_path / "free.txt", rows, header="")
    plan = main.ColumnPlan(**{"columns": _plan(remark=False)["columns"]})
    with pytest.raises(HTTPException) as ei:
        main._xyz_to_las(p, None, tmp_path / "o.las", plan)
    assert ei.value.status_code == 400
    assert '"remark"' in ei.value.detail and "Skip" in ei.value.detail


def test_text_mapped_to_timestamp_is_refused(tmp_path):
    p = _write(tmp_path / "ts.txt", header="")
    plan = main.ColumnPlan(columns=[
        {"index": 0, "role": "x"}, {"index": 1, "role": "y"}, {"index": 2, "role": "z"},
        {"index": 3, "role": "skip"}, {"index": 4, "role": "timestamp"}])
    with pytest.raises(HTTPException) as ei:
        main._xyz_to_las(p, None, tmp_path / "o.las", plan)
    assert ei.value.status_code == 400 and "Timestamp" in ei.value.detail


# ---- Cases a review of the first version found --------------------------------

def test_capitalized_header_still_delivers_its_palette(client, tmp_path):
    """The renderer resolves a palette by the LOWERCASED attribute and drops one
    whose own slug disagrees with its key, so both must be lowercase even though
    the column keeps the file's capitals."""
    p = _write(tmp_path / "caps.txt", header="X Y Z Category Plant_ID\n")
    meta = _create(client, p)
    try:
        pals = meta["class_palettes"]
        assert set(pals) == {"category", "plant_id"}
        assert all(pal["slug"] == key for key, pal in pals.items())
    finally:
        main._cloud_sessions.pop(meta["session_id"], None)


def test_true_false_column_is_not_text(tmp_path):
    """pandas reads True/False as booleans and they cast to 1/0 - which is how
    a True/False is_miss column imports. Coding them 1/2 made every point a miss."""
    import laspy
    rows = [(0, 0, 0, "False"), (1, 0, 0, "True"), (0, 1, 0, "False")]
    p = _write(tmp_path / "miss.txt", rows, header="# x y z is_miss\n")
    _, dims, _, _ = main._xyz_to_las(p, None, tmp_path / "o.las")
    assert "palette" not in dims[0]
    assert np.asarray(laspy.read(str(tmp_path / "o.las"))["is_miss"]).tolist() == [0.0, 1.0, 0.0]


@pytest.mark.parametrize("role", ["is_miss", "row_index", "target_count"])
def test_text_in_a_numeric_role_is_refused(tmp_path, role):
    p = _write(tmp_path / "role.txt", header="")
    plan = main.ColumnPlan(columns=[
        {"index": 0, "role": "x"}, {"index": 1, "role": "y"}, {"index": 2, "role": "z"},
        {"index": 3, "role": role}, {"index": 4, "role": "skip"}])
    with pytest.raises(HTTPException) as ei:
        main._xyz_to_las(p, None, tmp_path / "o.las", plan)
    assert ei.value.status_code == 400 and "holds text" in ei.value.detail


@pytest.mark.parametrize("header", ["x y z 450 550 650", "x,y,z,450,550,650", "x y z 1 2 3"])
def test_legend_with_numeric_column_names_is_still_a_legend(tmp_path, header):
    sep = "," if "," in header else " "
    p = tmp_path / "bands.txt"
    p.write_text(header + "\n" + sep.join(["1.5", "2.5", "3.5", "7", "8", "9"]) + "\n")
    assert main._ascii_skiprows(str(p)) == 1
    assert main._read_ascii_header_names(str(p))[:3] == ["x", "y", "z"]


def test_axis_named_twice_keeps_the_first(tmp_path):
    p = tmp_path / "dup.txt"
    p.write_text("x y z x_mm y_mm z_mm\n1 2 3 1000 2000 3000\n")
    assert main._autodetect_xyz_columns(str(p)) == ["x", "y", "z", "skip", "skip", "skip"]
    n, dims, _, _ = main._xyz_to_las(p, None, tmp_path / "o.las")
    assert n == 1 and len(dims) == 3


@pytest.mark.parametrize("name,role", [("x_mm", "x"), ("Y (m)", "y"), ("z-cm", "z"),
                                       ("xm", None), ("zin", None), ("x_in", None)])
def test_unit_suffix_needs_a_separator(name, role):
    assert main._role_from_header_name(name) == role


def test_headerless_xyz_label_autodetects(client, tmp_path):
    """Position says a lone 4th column is intensity; a column of words is not."""
    p = _write(tmp_path / "four.txt", [r[:4] for r in _ROWS], header="")
    assert main._autodetect_xyz_columns(str(p)) == ["x", "y", "z", "skip"]
    meta = _create(client, p)
    try:
        (pal,) = meta["class_palettes"].values()
        assert [c["label"] for c in pal["classes"]] == [
            "Unclassified", "embryonic_leaf", "leaf", "stem"]
        assert meta["point_count"] == len(_ROWS)
    finally:
        main._cloud_sessions.pop(meta["session_id"], None)


def test_na_like_names_are_classes_and_padding_is_not(tmp_path):
    """'NA' and 'None' are names, not missing cells; a comma file's padded
    ' leaf' is the same name as 'leaf'; an empty cell is Unclassified; and a
    numeric column beside them still reads its own NA as missing."""
    import laspy
    p = tmp_path / "na.csv"
    p.write_text("x,y,z,kind,score\n"
                 "0,0,0,NA,1.5\n1,0,0,None,NA\n0,1,0,leaf,2.5\n1,1,0, leaf ,3.5\n2,2,0,,4.5\n")
    _, dims, _, _ = main._xyz_to_las(p, None, tmp_path / "o.las")
    by = {d["slug"]: d for d in dims}
    codes = {c["label"]: c["value"] for c in by["kind"]["palette"]["classes"]}
    assert set(codes) == {"Unclassified", "NA", "None", "leaf"}
    las = laspy.read(str(tmp_path / "o.las"))
    assert np.asarray(las["kind"]).astype(int).tolist() == [
        codes["NA"], codes["None"], codes["leaf"], codes["leaf"], 0]
    score = np.asarray(las["score"])
    assert np.isnan(score[1]) and score[[0, 2, 3, 4]].tolist() == [1.5, 2.5, 3.5, 4.5]
