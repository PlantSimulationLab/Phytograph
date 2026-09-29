"""Generated plants steered toward a prescribed leaf-inclination distribution.

`leaf_inclination` (a Beta (mu, nu) in Helios's convention, the same one the LAD
G(theta) override uses) is applied to the library MODEL before the build
(helios-core v1.3.88 `setPlantModelLeafInclinationDistribution`), so every leaf
is steered as it emerges. These build real plants through the endpoints the
renderer calls and measure the leaves Helios actually grew -- a stub could only
confirm that the call was made, not that it bent a single leaf.

Targets are the Goel & Strebel (1984) Beta fits to de Wit's distributions, the
same presets the renderer offers: planophile (2.770, 1.172) has a mean
inclination of 26.8 deg, erectophile (1.172, 2.770) 63.2 deg.
"""

import asyncio
import json

import numpy as np
import pytest

import main

pytest.importorskip("pyhelios")

PLANOPHILE = main.LeafInclinationSpec(beta_mu=2.770, beta_nu=1.172)
ERECTOPHILE = main.LeafInclinationSpec(beta_mu=1.172, beta_nu=2.770)
PLANOPHILE_MEAN = 90.0 * 1.172 / (2.770 + 1.172)
ERECTOPHILE_MEAN = 90.0 * 2.770 / (2.770 + 1.172)


@pytest.fixture(autouse=True)
def _clear_plant_sessions():
    with main._session_lock:
        before = dict(main._plant_sessions)
    yield
    with main._session_lock:
        for sid in list(main._plant_sessions):
            if sid not in before:
                main._plant_sessions.pop(sid, None)


def _session_mean_inclination(session_id):
    s = main._plant_sessions[session_id]
    inc = np.asarray(s.plantarch.getPlantLeafInclinations(s.plant_id), dtype=np.float64)
    assert inc.size > 20
    return float(inc.mean())


def _stream(**body):
    """Drive the SSE endpoint the renderer uses; return the result payload."""
    class _Req:
        async def is_disconnected(self):
            return False

    req = main.PlantStreamRequest(**body)

    async def drive():
        resp = await main.generate_plant_stream(req, _Req())
        event, buf = None, ""
        async for chunk in resp.body_iterator:
            buf += chunk if isinstance(chunk, str) else chunk.decode("utf-8")
        for raw in buf.split("\n"):
            if raw.startswith("event:"):
                event = raw.split(":", 1)[1].strip()
            elif raw.startswith("data:") and event in ("result", "error"):
                return event, json.loads(raw.split(":", 1)[1])
        return event, None

    event, data = asyncio.run(drive())
    assert event == "result", data
    return data


def _mesh_leaf_inclination(result):
    """Area-weighted mean inclination (deg from horizontal) of the leaf
    triangles in a streamed mesh -- the only view of a canopy's leaves once the
    canopy's Context is gone."""
    v = np.asarray(result["vertices"], dtype=np.float64).reshape(-1, 3)
    f = np.asarray(result["indices"], dtype=np.int64).reshape(-1, 3)
    leaf = np.asarray(result["organ_codes"]) == main._ORGAN_LABEL_TO_CODE["leaf"]
    f = f[leaf]
    n = np.cross(v[f[:, 1]] - v[f[:, 0]], v[f[:, 2]] - v[f[:, 0]])
    area = np.linalg.norm(n, axis=1)
    ok = area > 0
    incl = np.degrees(np.arccos(np.clip(np.abs(n[ok, 2]) / area[ok], 0.0, 1.0)))
    return float(np.average(incl, weights=area[ok]))


def test_session_plant_follows_the_prescribed_distribution():
    """The age slider / growth animation / GIF rebuild through this endpoint."""
    means = {}
    for name, spec in (("none", None), ("plano", PLANOPHILE), ("erecto", ERECTOPHILE)):
        r = main.create_plant_session(main.PlantSessionCreateRequest(
            plant_type="bean", initial_age=20, random_seed=3, leaf_inclination=spec))
        assert r.success, r.error
        means[name] = _session_mean_inclination(r.session_id)

    assert means["plano"] == pytest.approx(PLANOPHILE_MEAN, abs=6.0)
    assert means["erecto"] == pytest.approx(ERECTOPHILE_MEAN, abs=6.0)
    # The unsteered bean (~53 deg) sits between the two.
    assert means["plano"] < means["none"] - 10 and means["erecto"] > means["none"] + 5


def test_steered_plant_keeps_tracking_as_it_grows():
    r = main.create_plant_session(main.PlantSessionCreateRequest(
        plant_type="bean", initial_age=10, random_seed=3, leaf_inclination=ERECTOPHILE))
    main.advance_plant_session(r.session_id, main.PlantSessionAdvanceRequest(dt=15))
    assert _session_mean_inclination(r.session_id) == pytest.approx(ERECTOPHILE_MEAN, abs=6.0)


def test_stream_single_plant_is_steered():
    res = _stream(mode="single", plant_type="soybean", age=25, random_seed=3,
                  leaf_inclination={"beta_mu": 2.770, "beta_nu": 1.172})
    assert _session_mean_inclination(res["session_id"]) == pytest.approx(
        PLANOPHILE_MEAN, abs=6.0)


def test_stream_canopy_is_steered():
    common = dict(mode="canopy", plant_type="bean", age=20, random_seed=3,
                  count_x=2, count_y=2, spacing_x=0.5, spacing_y=0.5)
    plano = _mesh_leaf_inclination(_stream(**common, leaf_inclination={
        "beta_mu": 2.770, "beta_nu": 1.172}))
    erecto = _mesh_leaf_inclination(_stream(**common, leaf_inclination={
        "beta_mu": 1.172, "beta_nu": 2.770}))
    # Triangles of curved blades spread wider than the per-blade angle Helios
    # steers, so compare the two canopies rather than each to its target.
    assert erecto - plano > 20.0


def test_stateless_generate_is_steered():
    """The age slider's last-resort fallback when a session can't be made."""
    res = main.generate_plant_model(main.PlantGenerationRequest(
        plant_type="bean", age=20, random_seed=3, leaf_inclination=ERECTOPHILE))
    flat = main.generate_plant_model(main.PlantGenerationRequest(
        plant_type="bean", age=20, random_seed=3, leaf_inclination=PLANOPHILE))
    assert res.success and flat.success
    assert (_mesh_leaf_inclination(res.model_dump())
            - _mesh_leaf_inclination(flat.model_dump())) > 20.0


def test_stateless_canopy_is_steered():
    common = dict(plant_type="bean", age=20, random_seed=3, count_x=2, count_y=2)
    erecto = main.generate_plant_canopy(main.PlantCanopyRequest(
        **common, leaf_inclination=ERECTOPHILE))
    plano = main.generate_plant_canopy(main.PlantCanopyRequest(
        **common, leaf_inclination=PLANOPHILE))
    assert erecto.success and plano.success
    assert (_mesh_leaf_inclination(erecto.model_dump())
            - _mesh_leaf_inclination(plano.model_dump())) > 20.0


def test_both_beta_parameters_must_be_positive():
    with pytest.raises(ValueError):
        main.LeafInclinationSpec(beta_mu=0.0, beta_nu=1.0)
