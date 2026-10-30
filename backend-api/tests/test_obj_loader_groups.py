"""OBJ `o`/`g` object groups survive import.

`load_obj_template` tags every triangle with the group it was written under, and
`/api/mesh/import` ships that as a `triangle_group_ids` buffer plus
`group_names` in the frame meta, so the renderer can list a multi-object OBJ's
parts under one mesh. A file with no group lines must come back exactly as
before (no group keys at all), since every single-object mesh takes that path.
"""
from pathlib import Path

from qsm.obj_loader import load_obj_template
from tests.binframe import decode_bin_frame

# Three triangles' worth of vertices, reused by every fixture below.
_VERTS = """v 0 0 0
v 1 0 0
v 1 1 0
v 0 1 0
"""


def _write(tmp_path: Path, body: str) -> Path:
    p = tmp_path / "groups.obj"
    p.write_text(_VERTS + body)
    return p


def test_groups_tagged_per_triangle(tmp_path):
    obj = _write(tmp_path, """o alpha
f 1 2 3
g beta
f 1 3 4
f 2 3 4
""")
    tpl = load_obj_template(obj)
    assert tpl["group_names"] == ["alpha", "beta"]
    assert tpl["tri_group"] == [0, 1, 1]


def test_quad_triangulates_into_its_group(tmp_path):
    obj = _write(tmp_path, """g first
f 1 2 3
g quad
f 1 2 3 4
""")
    tpl = load_obj_template(obj)
    # The quad fans into two triangles, both in "quad".
    assert tpl["group_names"] == ["first", "quad"]
    assert tpl["tri_group"] == [0, 1, 1]


def test_reentered_name_rejoins_its_group(tmp_path):
    obj = _write(tmp_path, """g a
f 1 2 3
g b
f 1 3 4
g a
f 2 3 4
""")
    tpl = load_obj_template(obj)
    assert tpl["group_names"] == ["a", "b"]
    assert tpl["tri_group"] == [0, 1, 0]


def test_faces_before_first_group_are_ungrouped(tmp_path):
    obj = _write(tmp_path, """f 1 2 3
g named
f 1 3 4
""")
    tpl = load_obj_template(obj)
    assert tpl["group_names"] == ["(ungrouped)", "named"]
    assert tpl["tri_group"] == [0, 1]


def test_multi_name_group_and_empty_groups_compacted(tmp_path):
    # `g` with no faces after it, then a multi-name group line.
    obj = _write(tmp_path, """g unused
g left leaf
f 1 2 3
""")
    tpl = load_obj_template(obj)
    assert tpl["group_names"] == ["left leaf"]
    assert tpl["tri_group"] == [0]


def test_no_group_lines_means_no_group_keys(tmp_path):
    obj = _write(tmp_path, "f 1 2 3\nf 1 3 4\n")
    tpl = load_obj_template(obj)
    assert "tri_group" not in tpl
    assert "group_names" not in tpl


def test_mesh_import_frame_carries_groups(client, tmp_path):
    obj = _write(tmp_path, """o one
f 1 2 3
o two
f 1 3 4
f 2 3 4
""")
    resp = client.post("/api/mesh/import", json={"path": str(obj)})
    assert resp.status_code == 200, resp.text
    meta, buffers = decode_bin_frame(resp.content)
    assert meta["group_names"] == ["one", "two"]
    assert buffers["triangle_group_ids"].tolist() == [0, 1, 1]
    assert len(buffers["triangle_group_ids"]) == meta["triangle_count"]


def test_mesh_import_frame_without_groups(client, tmp_path):
    obj = _write(tmp_path, "f 1 2 3\n")
    resp = client.post("/api/mesh/import", json={"path": str(obj)})
    assert resp.status_code == 200, resp.text
    meta, buffers = decode_bin_frame(resp.content)
    assert meta.get("group_names") is None
    assert "triangle_group_ids" not in buffers
