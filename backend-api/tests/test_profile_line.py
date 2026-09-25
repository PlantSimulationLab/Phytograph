"""The `polyline_halfspace` region: "above / below / near a line drawn in a
cross-section" (TerraScan's Above/Below Line).

``src/shared/profileLine.contract.json`` holds the golden vectors;
``src/renderer/lib/profileLine.test.ts`` asserts the same cases against the
renderer's live-preview predicate. A preview that disagrees with what the
session labels shows the user a cut they did not make.

The end-to-end case goes through `label_region` with the stroke's slab, which
is how the Label tool sends it: the line picks heights, the slab picks depth.
"""
import json
import pathlib

import numpy as np
import pytest
from fastapi import HTTPException

import main
from tests.binframe import decode_streamed_json

CONTRACT = (pathlib.Path(__file__).resolve().parents[2]
            / "src" / "shared" / "profileLine.contract.json")
_DATA = json.loads(CONTRACT.read_text(encoding="utf-8"))


@pytest.mark.parametrize("case", _DATA["cases"], ids=[c["name"] for c in _DATA["cases"]])
def test_region_mask_matches_the_contract(case):
    pts = np.asarray(case.get("points", _DATA["points"]), dtype=np.float64)
    main._canonical_region(case["region"])   # every contract region is valid
    got = main._region_mask(pts, case["region"])
    assert got.tolist() == case["expected"]


BASE = {"kind": "polyline_halfspace", "a": [0, 0], "b": [10, 0],
        "line": [[2, 1], [8, 3]], "side": "above"}


@pytest.mark.parametrize("patch, message", [
    ({"line": [[2, 1]]}, "at least 2"),
    ({"line": [[2, 1], [8, float("nan")]]}, "at least 2"),
    ({"line": [[2, 1, 0], [8, 3, 0]]}, "at least 2"),
    ({"side": "left"}, "region.side"),
    ({"side": "near"}, "required for side 'near'"),
    ({"band": 0}, "positive"),
    ({"band": -1}, "positive"),
    ({"b": [0, 0]}, "must differ"),
    ({"a": [0]}, "region.a"),
])
def test_invalid_regions_are_400(patch, message):
    with pytest.raises(HTTPException) as exc:
        main._canonical_region({**BASE, **patch})
    assert exc.value.status_code == 400
    assert message in exc.value.detail


def test_canonical_form_distinguishes_side_band_and_line():
    keys = {
        main._canonical_region(BASE),
        main._canonical_region({**BASE, "side": "below"}),
        main._canonical_region({**BASE, "band": 0.5}),
        main._canonical_region({**BASE, "line": [[2, 1], [8, 4]]}),
    }
    assert len(keys) == 4


# ── Through label_region, with the slab ──────────────────────────────────────

def _converter_available() -> bool:
    try:
        main._resolve_potree_converter_path()
        return True
    except Exception:
        return False


@pytest.fixture
def cache_root(tmp_path, monkeypatch):
    root = tmp_path / "octree_cache"
    monkeypatch.setenv("PHYTOGRAPH_OCTREE_CACHE_ROOT", str(root))
    return root


@pytest.mark.skipif(not _converter_available(), reason="PotreeConverter binary not found")
def test_label_region_paints_only_the_in_slab_points_below_the_line(client, cache_root, tmp_path):
    # A 10 x 10 x 10 grid over [0, 0.9]^3. The section runs along +x at y = 0.4,
    # 0.25 thick (rows y = 0.3, 0.4, 0.5); the line slopes from z = 0.2 at x = 0
    # to z = 0.6 at x = 0.9. Every point below it IN THE SLAB gets class 7 —
    # and none behind the section, which is the whole reason for the slab.
    f = tmp_path / "grid.xyz"
    f.write_text("\n".join(
        f"{i*0.1:.4f} {j*0.1:.4f} {k*0.1:.4f}"
        for i in range(10) for j in range(10) for k in range(10)) + "\n")
    res = client.post("/api/cloud/session/create",
                      json={"source_path": str(f), "ascii_format": "x y z"})
    assert res.status_code == 200, res.text
    sid = decode_streamed_json(res.content)["session_id"]

    slab = {"kind": "slab", "a": [0, 0.4], "b": [0.9, 0.4], "depth": 0.25,
            "zMin": -1, "zMax": 2, "offset": 0}
    region = {"kind": "polyline_halfspace", "a": [0, 0.4], "b": [0.9, 0.4],
              "line": [[0, 0.2], [0.9, 0.6]], "side": "below"}
    res = client.post(f"/api/cloud/session/{sid}/label_region", json={"strokes": [
        {"region": region, "slab": slab, "to_class": 7, "stroke_id": "s1"},
    ]})
    assert res.status_code == 200, res.text

    pts = main._cloud_sessions[sid].positions
    labels = main._cloud_sessions[sid].extras[main.MANUAL_CLASS_SLUG]
    line_z = 0.2 + (0.6 - 0.2) * pts[:, 0] / 0.9
    in_slab = np.abs(pts[:, 1] - 0.4) <= 0.125
    expected = in_slab & (pts[:, 2] <= line_z)
    assert 0 < expected.sum() < in_slab.sum()
    assert np.array_equal(labels == 7, expected)
