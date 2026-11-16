"""The renderer's LAD result travels as per-voxel columns, not JSON.

JSON cost 576 B per voxel (765 with the wood split) and the renderer decodes a
response into ONE string before parsing it, so a grid past ~0.93 M voxels failed
after the whole inversion had finished. `?voxel_columns=1` returns a PHB1 frame
instead (`_lad_cells_frame`). These pin that the records the renderer rebuilds
from it are EXACTLY the ones JSON gives, nulls and booleans included, and that
JSON is still the default for everyone else (the Python client).
"""

import copy
import json
import math

import numpy as np
import pytest

import main
from tests.binframe import _frames, decode_streamed_json   # binframe puts the client on sys.path
from tests.test_lad_wood import _FIXTURE_ORIGIN, _wood_labeled_fixture


def _records_from_frame(meta: dict, buffers: dict) -> list:
    """The renderer's `ladResponseFromFrame`, record by record."""
    n = meta["cell_count"]
    cells = [{} for _ in range(n)]
    for col in meta["cell_columns"]:
        name, kind = col["name"], col["kind"]
        data = buffers[f"cells.{name}"]
        present = buffers.get(f"cells.{name}.present")
        for i in range(n):
            if present is not None and not present[i]:
                continue
            if kind == "vec3":
                cells[i][name] = [float(x) for x in data[3 * i:3 * i + 3]]
            else:
                x = float(data[i])
                cells[i][name] = None if math.isnan(x) else (x != 0 if kind == "bool" else x)
    return cells


def _decode(content: bytes):
    return _frames.decode_frame(content)


@pytest.fixture(scope="module")
def real_result(tmp_path_factory):
    """One real inversion: wood split on, a 3x3x3 grid wider than the leafcube
    (so margin voxels carry nulls), occlusion fill on."""
    pytest.importorskip("pyhelios")
    path = _wood_labeled_fixture(tmp_path_factory.mktemp("lad"))
    scan = main.HeliosScanEntry(
        file_path=path, ascii_format="x y z is_miss wood_class", origin=_FIXTURE_ORIGIN,
        n_theta=2600, n_phi=5200, theta_min=0, theta_max=180,
        phi_min=0, phi_max=360, return_type="single")
    grid = main.HeliosGrid(center=[0, 0, 0.5], size=[1.5, 1.5, 1.5], nx=3, ny=3, nz=3)
    result = main._do_lad_computation(main.LADComputeRequest(
        scans=[scan], grid=grid, lmax=0.04, max_aspect_ratio=10,
        min_voxel_hits=1, fill_occluded=True))
    assert result["success"], result.get("error")
    return result


def _post(client, result, monkeypatch, query=""):
    monkeypatch.setattr(main, "_do_lad_computation",
                        lambda *a, **k: copy.deepcopy(result))
    grid = {"center": [0, 0, 0], "size": [1, 1, 1], "nx": 1, "ny": 1, "nz": 1}
    return client.post(f"/api/lad/compute{query}", json={"scans": [], "grid": grid})


def test_columns_rebuild_exactly_the_json_records(client, real_result, monkeypatch):
    result = copy.deepcopy(real_result)
    cells = result["cells"]
    assert len(cells) == 27
    assert all(c.get("wad") is not None for c in cells), "no wood split"
    # Every voxel of this fixture is probed and solved, so nothing is null. Null
    # the fields an unprobed or CI-gated voxel would, on one record.
    for k in ("beam_count", "mean_path_length", "lad_variance", "lad_std",
              "leaf_area_ci_lower", "leaf_area_ci_upper", "path_length_total"):
        cells[4][k] = None
    cells[4]["ci_valid"] = False

    as_json = decode_streamed_json(_post(client, result, monkeypatch).content)
    meta, buffers = _decode(_post(client, result, monkeypatch, "?voxel_columns=1").content)
    got = _records_from_frame(meta, buffers)
    assert got == as_json["cells"]
    assert got[4]["beam_count"] is None and got[4]["ci_valid"] is False
    # Booleans come back as booleans, not 0/1 (== would not tell them apart).
    assert all(type(c[k]) is bool for c in got
               for k in ("ci_valid", "lad_solved", "under_sampled", "lad_filled"))
    rest = {k: v for k, v in meta.items() if k not in ("cell_columns", "cell_count")}
    assert rest == {k: v for k, v in as_json.items() if k != "cells"}


def test_world_centers_survive_at_utm(client, real_result, monkeypatch):
    """float64 columns: a float32 center at a UTM northing would snap to 0.5 m."""
    shifted = copy.deepcopy(real_result)
    for c in shifted["cells"]:
        c["center"] = [c["center"][0] + 512_345.123, c["center"][1] + 4_271_234.567,
                       c["center"][2]]
    meta, buffers = _decode(_post(client, shifted, monkeypatch, "?voxel_columns=1").content)
    got = _records_from_frame(meta, buffers)
    assert [c["center"] for c in got] == [c["center"] for c in shifted["cells"]]


def test_a_field_missing_from_some_records_stays_missing():
    result = {"success": True, "cells": [
        {"index": 0, "lad": 1.5, "center": [0, 0, 0]},
        {"index": 1, "lad": None, "center": [1, 0, 0], "wad": 0.25, "ci_valid": True},
        {"index": 2, "lad": 2.0, "center": [2, 0, 0], "ci_valid": False},
    ]}
    meta, buffers = _decode(main._lad_cells_frame(result))
    assert _records_from_frame(meta, buffers) == [
        {"index": 0, "lad": 1.5, "center": [0, 0, 0]},
        {"index": 1, "lad": None, "center": [1, 0, 0], "wad": 0.25, "ci_valid": True},
        {"index": 2, "lad": 2.0, "center": [2, 0, 0], "ci_valid": False},
    ]
    assert {c["name"]: c["kind"] for c in meta["cell_columns"]}["ci_valid"] == "bool"


def test_a_failed_result_is_a_frame_with_no_cells():
    meta, buffers = _decode(main._lad_cells_frame({"success": False, "error": "no hits"}))
    assert meta["success"] is False and meta["error"] == "no hits"
    assert meta["cell_count"] == 0 and buffers == {}


def test_an_unsupported_field_type_fails_loudly():
    with pytest.raises(TypeError, match="label"):
        main._lad_cells_frame({"cells": [{"index": 0, "label": "leaf"}]})


def test_the_frame_is_a_fraction_of_the_json():
    n = 20_000
    rng = np.random.default_rng(0)
    cells = [{"index": i, "center": list(rng.uniform(0, 50, 3)), "size": [0.5] * 3,
              "leaf_area": float(rng.uniform()), "lad": float(rng.uniform()),
              "gtheta": 0.5, "hit_count": int(rng.integers(100)), "beam_count": None,
              "lad_variance": float(rng.uniform()), "ci_valid": False,
              "under_sampled": bool(i % 3), "lad_filled": False} for i in range(n)]
    frame = main._lad_cells_frame({"success": True, "cells": cells})
    assert len(frame) < 0.5 * len(json.dumps({"cells": cells}))
