"""A plant built with a `random_seed` is the same plant every time.

Every plant endpoint seeds the Context RNG, but used to do it AFTER
`loadPlantModelFromLibrary`. Loading already draws from that RNG (the model's
random parameters), and a fresh Context is time-seeded, so the seed never made
a plant reproducible: the same seed gave a different bean on every call, and a
seeded test of its leaves (test_plant_leaf_inclination) flaked on CI. Each
endpoint that takes a seed is checked here by building twice and comparing the
geometry exactly.
"""

import numpy as np
import pytest

import main

pytest.importorskip("pyhelios")

from tests.test_plant_leaf_inclination import _stream  # noqa: E402  (drives the SSE endpoint)


@pytest.fixture(autouse=True)
def _clear_plant_sessions():
    with main._session_lock:
        before = dict(main._plant_sessions)
    yield
    with main._session_lock:
        for sid in list(main._plant_sessions):
            if sid not in before:
                main._plant_sessions.pop(sid, None)


def _assert_same_mesh(a, b):
    va = np.asarray(a["vertices"] if isinstance(a, dict) else a.vertices, dtype=np.float64)
    vb = np.asarray(b["vertices"] if isinstance(b, dict) else b.vertices, dtype=np.float64)
    assert va.size > 0
    assert va.shape == vb.shape, f"vertex counts differ: {va.shape} vs {vb.shape}"
    assert np.array_equal(va, vb), f"max vertex difference {np.abs(va - vb).max()}"


def test_seeded_session_plant_is_reproducible():
    def leaves():
        r = main.create_plant_session(main.PlantSessionCreateRequest(
            plant_type="bean", initial_age=20, random_seed=3))
        assert r.success, r.error
        s = main._plant_sessions[r.session_id]
        return np.asarray(s.plantarch.getPlantLeafInclinations(s.plant_id), dtype=np.float64)

    a, b = leaves(), leaves()
    assert a.size > 20
    assert np.array_equal(a, b), f"max leaf-angle difference {np.abs(a - b).max()}"


def test_seeded_generate_is_reproducible():
    req = dict(plant_type="bean", age=20, random_seed=3)
    a = main.generate_plant_model(main.PlantGenerationRequest(**req))
    b = main.generate_plant_model(main.PlantGenerationRequest(**req))
    assert a.success and b.success
    _assert_same_mesh(a, b)


def test_seeded_canopy_is_reproducible():
    req = dict(plant_type="bean", age=15, random_seed=3, count_x=2, count_y=1)
    a = main.generate_plant_canopy(main.PlantCanopyRequest(**req))
    b = main.generate_plant_canopy(main.PlantCanopyRequest(**req))
    assert a.success and b.success
    _assert_same_mesh(a, b)


def test_seeded_stream_is_reproducible():
    req = dict(mode="single", plant_type="bean", age=20, random_seed=3)
    _assert_same_mesh(_stream(**req), _stream(**req))
