"""The ground-segmentation cost advisory: ETA + memory estimate, the 409
confirmation prompt, and the hard refusal of a cloth too fine for its extent.

A large cloud used to run to completion with no warning - minutes of CSF plus
a full octree reconvert (and two more for the split) - and a fine cloth on a
field-sized extent used to hang the worker outright. Now the endpoint says how
long it thinks the run will take BEFORE spawning anything, and the renderer's
existing `CostWarningError` path turns that into "Segment Anyway".
"""
import math

import numpy as np
import pytest

import main
import memory_budget as mb


def test_cloth_node_count_is_the_square_grid_csf_builds():
    assert main._cloth_node_count(60.0, 0.5) == 121 ** 2
    assert main._cloth_node_count(0.0, 0.5) == 0
    assert main._cloth_node_count(60.0, 0.0) == 0


def test_estimate_grows_with_points_cloth_density_and_rebuild_size():
    base, _b, _ = main._ground_cost_estimate(1_000_000, 50.0, 0.5, 500, 1_000_000)
    more_points, _b2, _ = main._ground_cost_estimate(20_000_000, 50.0, 0.5, 500, 1_000_000)
    finer_cloth, _b3, _ = main._ground_cost_estimate(1_000_000, 50.0, 0.05, 500, 1_000_000)
    bigger_rebuild, _b4, _ = main._ground_cost_estimate(1_000_000, 50.0, 0.5, 500, 40_000_000)
    assert more_points > base
    assert finer_cloth > base
    assert bigger_rebuild > base
    # The rebuild term honours the converter's sampling policy: a rebuild past
    # the random-sampling knee is estimated at the faster rate.
    slow_small = main._convert_seconds(main._POTREE_RANDOM_SAMPLING_MIN_POINTS - 1)
    fast_large = main._convert_seconds(main._POTREE_RANDOM_SAMPLING_MIN_POINTS)
    assert fast_large < slow_small * 1.2


def test_estimated_memory_is_the_transient_working_set():
    _s, b, _ = main._ground_cost_estimate(10_000_000, 50.0, 0.5, 500, 10_000_000)
    assert b >= 10_000_000 * 56


def test_advisory_is_silent_for_a_cheap_run(monkeypatch):
    monkeypatch.setattr(main, "_COST_WARNING_SECONDS", 90.0)
    monkeypatch.setenv("PHYTOGRAPH_MEMORY_BUDGET_BYTES", str(8 * mb.GiB))
    assert main._cost_advisory("x", 5.0, 100 * 1024 ** 2) is None


def test_advisory_fires_on_time_and_names_the_breakdown(monkeypatch):
    monkeypatch.setattr(main, "_COST_WARNING_SECONDS", 90.0)
    monkeypatch.setenv("PHYTOGRAPH_MEMORY_BUDGET_BYTES", str(8 * mb.GiB))
    w = main._cost_advisory("Ground segmentation of 120,000,000 points", 200.0,
                            2 * mb.GiB, breakdown="cloth filter ~20 s, octree rebuild ~3 min")
    assert w is not None
    assert w["over_time"] and not w["over_memory"]
    assert "about 3 min" in w["message"]
    assert "cloth filter" in w["message"]
    assert "cancel" in w["message"].lower()
    assert w["budget_bytes"] == 8 * mb.GiB


def test_advisory_fires_on_memory_even_when_fast(monkeypatch):
    monkeypatch.setattr(main, "_COST_WARNING_SECONDS", 90.0)
    monkeypatch.setenv("PHYTOGRAPH_MEMORY_BUDGET_BYTES", str(1 * mb.GiB))
    w = main._cost_advisory("x", 5.0, 3 * mb.GiB)
    assert w is not None
    assert w["over_memory"] and not w["over_time"]
    assert "more than this machine's 1.0 GB budget" in w["message"]


def test_fmt_duration():
    assert main._fmt_duration(42) == "42 s"
    assert main._fmt_duration(90) == "1.5 min"
    assert main._fmt_duration(600) == "10 min"
    assert main._fmt_duration(7200) == "2.0 h"


def test_oversized_cloth_is_refused_with_a_usable_alternative():
    with pytest.raises(main.HTTPException) as ei:
        main._refuse_oversized_cloth(1000.0, 0.05)     # 20001^2 = 400 M nodes
    assert ei.value.status_code == 400
    detail = ei.value.detail
    suggested = float(detail.split("at least ")[1].split(" m")[0])
    assert main._cloth_node_count(1000.0, suggested) <= main._MAX_CLOTH_NODES * 1.01
    # And the alternative is real: a 1000 m extent at that cloth fits.
    main._refuse_oversized_cloth(1000.0, suggested * 1.01)
    main._refuse_oversized_cloth(1.5, 0.05)             # a plant scan is fine


# ---- endpoint contract --------------------------------------------------------

XYZ_FORMAT = "x y z"


@pytest.fixture
def flat_cloud_session(client, tmp_path, monkeypatch):
    """A tiny real session (needs PotreeConverter, like every session test)."""
    from tests.binframe import decode_streamed_json

    monkeypatch.setenv("PHYTOGRAPH_OCTREE_CACHE_ROOT", str(tmp_path / "octrees"))
    rng = np.random.default_rng(0)
    n = 4000
    xy = rng.uniform(0, 5, size=(n, 2))
    z = np.where(rng.random(n) < 0.5, rng.normal(0, 0.005, n), rng.uniform(0.5, 2.0, n))
    src = tmp_path / "flat.xyz"
    np.savetxt(src, np.column_stack([xy, z]), fmt="%.4f")
    res = client.post("/api/cloud/session/create",
                      json={"source_path": str(src), "ascii_format": XYZ_FORMAT})
    assert res.status_code == 200, res.text
    return decode_streamed_json(res.content)["session_id"]


def test_session_ground_answers_409_past_the_guideline_and_runs_when_acknowledged(
        client, flat_cloud_session, monkeypatch):
    monkeypatch.setattr(main, "_COST_WARNING_SECONDS", 0.0)   # everything is "expensive"
    body = {"cloth_resolution": 0.5, "class_threshold": 0.05}
    res = client.post(f"/api/cloud/session/{flat_cloud_session}/segment_ground", json=body)
    assert res.status_code == 409, res.text
    detail = res.json()["detail"]
    assert detail["cost_warning"]["over_time"] is True
    assert "Ground segmentation of 4,000 points" in detail["message"]
    assert detail["cost_warning"]["estimated_seconds"] > 0

    res = client.post(f"/api/cloud/session/{flat_cloud_session}/segment_ground",
                      json={**body, "acknowledge_cost": True})
    assert res.status_code == 200, res.text
    out = res.json()
    assert out["point_count"] == 4000
    assert "cache_id" in out


def test_session_ground_refuses_a_cloth_that_would_hang(client, flat_cloud_session):
    res = client.post(f"/api/cloud/session/{flat_cloud_session}/segment_ground",
                      json={"cloth_resolution": 0.0005})   # 5 m / 0.5 mm = 10001^2 nodes
    assert res.status_code == 400, res.text
    assert "cloth resolution of at least" in res.json()["detail"]
