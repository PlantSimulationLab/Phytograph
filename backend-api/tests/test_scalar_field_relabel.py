"""A scalar-field rename or delete must RELABEL the octree, not reconvert it.

THE BUG THIS PINS: `/scalar_fields/manage` ended every action with a full
`_session_rebuild` — a PotreeConverter run over the whole cloud — even for a
rename, which changes no point data at all. On a large cloud that is minutes of
work plus a status pill for what is a few hundred bytes of JSON. A rename or
delete now hard-links the existing octree's binaries into a new cache entry and
patches only `metadata.json` and the label sidecar.

These run the real PotreeConverter once, to have a genuine octree to relabel,
and then assert that the manage call does NOT run it again.
"""
import json
import os
import sys
from pathlib import Path

import numpy as np
import pytest

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import main  # noqa: E402


@pytest.fixture
def built(monkeypatch, tmp_path):
    """A registered session whose octree is CURRENT (built from its arrays).

    `reflectance` carries a hand-set label that differs from its slug, which is
    what every imported field looks like — and what hid the original rename bug,
    since the visible name is the label.
    """
    monkeypatch.setenv("PHYTOGRAPH_OCTREE_CACHE_ROOT", str(tmp_path / "octrees"))
    rng = np.random.default_rng(0)
    n = 300
    positions = rng.uniform(0.0, 5.0, size=(n, 3)).astype(np.float64)
    refl = (positions[:, 2] * 10.0).astype(np.float32)
    band = rng.integers(0, 4, size=n).astype(np.float32)
    s = main.CloudSession(
        session_id="relabel-test", source_path="mem", ascii_format=None,
        column_plan=None, positions=positions, colors=None, intensity=None,
        extras={"reflectance": refl, "band": band},
        extra_dims_meta=[{"slug": "reflectance", "label": "Reflectance [dB]"},
                         {"slug": "band", "label": "band"}],
        world_shift=None, deleted=np.zeros(n, dtype=bool),
        deleted_history=[], octree_cache_id=None, created_at=0.0,
        last_accessed=0.0,
    )
    main._session_rebuild(s)
    main._cloud_sessions[s.session_id] = s
    yield s
    main._cloud_sessions.pop(s.session_id, None)


def _no_rebuild(monkeypatch):
    def boom(*a, **k):
        raise AssertionError("manage reconverted the octree for a relabel")
    monkeypatch.setattr(main, "_session_rebuild", boom)
    monkeypatch.setattr(main, "_build_octree_from_las", boom)


def _manage(client, sess, **body):
    return client.post(
        f"/api/cloud/session/{sess.session_id}/scalar_fields/manage", json=body)


def _attr_names(cache_dir: Path) -> list:
    return [a["name"] for a in main._read_octree_metadata(cache_dir)["attributes"]]


@pytest.mark.parametrize("defer", [False, True])
def test_rename_relabels_without_reconverting(client, built, monkeypatch, defer):
    """Both the small-cloud and the large-cloud (`defer_octree`) request take
    the relabel — the large cloud is where the rebuild actually hurt."""
    old_id = built.octree_cache_id
    old_dir = main._octree_cache_root() / old_id
    _no_rebuild(monkeypatch)

    res = _manage(client, built, action="rename", slug="reflectance",
                  new_slug="refl_db", new_label="Refl dB", defer_octree=defer)
    assert res.status_code == 200, res.text
    body = res.json()

    assert body.get("octree_relabeled") is True
    assert "octree_deferred" not in body
    assert body["cache_id"] != old_id
    assert built.octree_cache_id == body["cache_id"]

    new_dir = Path(body["cache_dir"])
    names = _attr_names(new_dir)
    assert "refl_db" in names and "reflectance" not in names
    # The label the pickers show is the NEW one.
    by_name = {a["name"]: a for a in body["attributes"]}
    assert by_name["refl_db"]["label"] == "Refl dB"
    # The bytes are shared, not re-encoded.
    for f in ("octree.bin", "hierarchy.bin"):
        assert os.path.samefile(old_dir / f, new_dir / f) or \
            (old_dir / f).read_bytes() == (new_dir / f).read_bytes()
    # The source entry is content-addressed and shared — never edited in place.
    assert "reflectance" in _attr_names(old_dir)
    # Colorbar domains follow the new slug.
    assert "refl_db" in body["robust_attribute_ranges"]


def test_delete_hides_the_attribute_without_reconverting(client, built, monkeypatch):
    _no_rebuild(monkeypatch)
    res = _manage(client, built, action="delete", slug="band", defer_octree=True)
    assert res.status_code == 200, res.text
    body = res.json()
    assert body.get("octree_relabeled") is True
    # Gone from what the renderer is told about...
    assert "band" not in {a["name"] for a in body["attributes"]}
    assert not any(a["name"].startswith(main._OCTREE_HIDDEN_ATTRIBUTE_PREFIX)
                   for a in body["attributes"])
    # ...but still in the record layout, which a delete cannot change without
    # re-encoding every point.
    raw = (Path(body["cache_dir"]) / "metadata.json").read_text()
    assert f'"{main._OCTREE_HIDDEN_ATTRIBUTE_PREFIX}band"' in raw


def test_relabeled_octree_matches_a_real_rebuild(client, built):
    """The relabel must describe the same octree a reconvert would produce:
    same attributes in the same order, apart from the renamed one."""
    res = _manage(client, built, action="rename", slug="band",
                  new_slug="strip", defer_octree=False)
    relabeled = res.json()
    assert relabeled.get("octree_relabeled") is True
    _, rebuilt_dir, _ = main._session_rebuild(built)
    assert _attr_names(Path(relabeled["cache_dir"])) == _attr_names(rebuilt_dir)


def test_stale_octree_falls_back_to_the_deferred_rebuild(client, built, monkeypatch):
    """Unbaked deletions mean the octree no longer describes the arrays; a
    relabel of it would still be stale, so the refresh must stay queued."""
    with main._cloud_session_lock:
        main._mark_octree_stale_locked(built)
    res = _manage(client, built, action="rename", slug="band",
                  new_slug="strip", defer_octree=True)
    body = res.json()
    assert body.get("octree_deferred") is True
    assert "octree_relabeled" not in body
    assert built.octree_cache_id is None


def test_posed_octree_falls_back(client, built, monkeypatch):
    """A posed cloud is drawn through a renderer pose keyed on the cache id, so
    a new id would silently drop the pose."""
    built.octree_pose = list(np.eye(4).ravel())
    res = _manage(client, built, action="rename", slug="band",
                  new_slug="strip", defer_octree=True)
    body = res.json()
    assert body.get("octree_deferred") is True
    assert "octree_relabeled" not in body


def test_relabel_refuses_an_ambiguous_attribute_list(built):
    """A `name` that already exists would make the buffer key ambiguous."""
    assert main._relabel_octree_attribute(
        built.octree_cache_id, "band", "reflectance", None) is None
    assert main._relabel_octree_attribute(
        built.octree_cache_id, "not_there", "x2", None) is None
    assert main._relabel_octree_attribute(None, "band", "x2", None) is None


def test_label_sidecar_is_rewritten_not_appended(built):
    key, cache_dir, _ = main._relabel_octree_attribute(
        built.octree_cache_id, "reflectance", "refl", "Refl")
    labels = json.loads((cache_dir / main._OCTREE_LABELS_FILENAME).read_text())
    assert "reflectance" not in labels
    assert labels["refl"] == "Refl"


def test_label_only_rename_keeps_the_slug(client, built, monkeypatch):
    """The visible name is the LABEL. Changing just that ("Reflectance [dB]" →
    "Reflectance dB") must not be refused as a clash with the field's own slug,
    and must reach the octree's label sidecar, which is what every picker reads."""
    _no_rebuild(monkeypatch)
    res = _manage(client, built, action="rename", slug="reflectance",
                  new_slug="reflectance", new_label="Reflectance dB",
                  defer_octree=True)
    assert res.status_code == 200, res.text
    body = res.json()
    assert body.get("octree_relabeled") is True
    assert list(built.extras) == ["reflectance", "band"]
    assert {f["slug"]: f["label"] for f in body["fields"]}["reflectance"] == \
        "Reflectance dB"
    by_name = {a["name"]: a for a in body["attributes"]}
    assert by_name["reflectance"]["label"] == "Reflectance dB"
