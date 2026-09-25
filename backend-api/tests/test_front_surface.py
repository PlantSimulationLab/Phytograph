"""Front-surface and limiting-box bounds on a label stroke.

`depth_limit` carries a grid of view-depth thresholds built by the renderer at
the lasso's frozen camera (src/renderer/lib/frontSurface.ts); the backend only
compares. ``src/shared/frontSurface.contract.json`` pins the comparison on both
sides. `limit_box` is ANDed in like the slab.
"""
import base64
import json
import pathlib

import numpy as np
import pytest
from fastapi import HTTPException

import main
from tests.binframe import decode_streamed_json

CONTRACT = json.loads((pathlib.Path(__file__).resolve().parents[2]
                       / "src" / "shared" / "frontSurface.contract.json").read_text("utf-8"))


def test_depth_limit_mask_matches_the_contract():
    dl = main.DepthLimit(**CONTRACT["limit"])
    got = main._depth_limit_mask(np.asarray(CONTRACT["points"], dtype=np.float64), dl)
    assert got.tolist() == CONTRACT["expected"]


def _limit(**patch):
    return main.DepthLimit(**{**CONTRACT["limit"], **patch})


@pytest.mark.parametrize("patch, message", [
    ({"cols": 3}, "cols*rows float32"),
    ({"thresholds": "not base64!"}, "base64"),
    ({"cell": 0}, "positive size"),
    ({"cols": 0}, "cells"),
    ({"projection": [1.0] * 15}, "16 numbers"),
    ({"canvas": {"width": 0, "height": 20}}, "positive"),
    ({"canvas": {}}, "width and height"),
])
def test_invalid_depth_limits_are_400(patch, message):
    with pytest.raises(HTTPException) as exc:
        main._decode_depth_limit(_limit(**patch))
    assert exc.value.status_code == 400
    assert message in exc.value.detail


def test_points_behind_the_camera_pass():
    # Behind the camera there is no pixel, so no cell: the limit only removes.
    got = main._depth_limit_mask(np.array([[0.0, 0.0, 50.0]]), _limit())
    assert got.tolist() == [True]


# ── Through label_region ─────────────────────────────────────────────────────

def _converter_available() -> bool:
    try:
        main._resolve_potree_converter_path()
        return True
    except Exception:
        return False


@pytest.fixture
def two_sheets(tmp_path, monkeypatch):
    monkeypatch.setenv("PHYTOGRAPH_OCTREE_CACHE_ROOT", str(tmp_path / "octree_cache"))
    f = tmp_path / "sheets.xyz"
    # Two 11 x 11 sheets over x, y in [-0.5, 0.5]: z = 2 (front, seen from
    # above) and z = 0 (behind it).
    f.write_text("\n".join(
        f"{i*0.1:.3f} {j*0.1:.3f} {z:.3f}"
        for z in (2.0, 0.0) for i in range(-5, 6) for j in range(-5, 6)) + "\n")
    return f


# Orthographic camera at z = 10 looking down, x, y in [-1, 1], 20 x 20 canvas.
P = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, -2 / 99.9, 0, 0, 0, -100.1 / 99.9, 1]
V = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, -10, 1]
EVERYWHERE = {"kind": "polygon", "points": [[0, 0], [20, 0], [20, 20], [0, 20]],
              "projection": P, "view": V, "canvas": {"width": 20, "height": 20}}


@pytest.mark.skipif(not _converter_available(), reason="PotreeConverter binary not found")
def test_label_region_honours_depth_limit_and_limit_box(client, two_sheets):
    res = client.post("/api/cloud/session/create",
                      json={"source_path": str(two_sheets), "ascii_format": "x y z"})
    assert res.status_code == 200, res.text
    sid = decode_streamed_json(res.content)["session_id"]
    # One cell over the whole canvas, threshold depth 8.5: the front sheet is at
    # depth 8, the back one at 10.
    thresholds = base64.b64encode(np.array([8.5], dtype="<f4").tobytes()).decode()
    depth_limit = {"projection": P, "view": V, "canvas": {"width": 20, "height": 20},
                   "x0": 0, "y0": 0, "cell": 20, "cols": 1, "rows": 1, "thresholds": thresholds}
    box = {"kind": "box", "min": [-0.25, -1, -1], "max": [0.25, 1, 5]}
    res = client.post(f"/api/cloud/session/{sid}/label_region", json={"strokes": [
        {"region": EVERYWHERE, "depth_limit": depth_limit, "to_class": 3, "stroke_id": "a"},
        {"region": EVERYWHERE, "limit_box": box, "to_class": 5, "stroke_id": "b"},
    ]})
    assert res.status_code == 200, res.text

    pts = main._cloud_sessions[sid].positions
    labels = main._cloud_sessions[sid].extras[main.MANUAL_CLASS_SLUG]
    in_box = np.abs(pts[:, 0]) <= 0.25
    front = pts[:, 2] > 1
    assert np.array_equal(labels == 5, in_box)
    assert np.array_equal(labels == 3, front & ~in_box)
    assert (labels == 0).sum() == (~front & ~in_box).sum() > 0


@pytest.mark.skipif(not _converter_available(), reason="PotreeConverter binary not found")
def test_limit_box_must_be_a_box(client, two_sheets):
    res = client.post("/api/cloud/session/create",
                      json={"source_path": str(two_sheets), "ascii_format": "x y z"})
    sid = decode_streamed_json(res.content)["session_id"]
    res = client.post(f"/api/cloud/session/{sid}/label_region", json={"strokes": [
        {"region": EVERYWHERE, "limit_box": EVERYWHERE, "to_class": 3, "stroke_id": "a"},
    ]})
    assert res.status_code == 400
    assert "limit_box" in res.text
