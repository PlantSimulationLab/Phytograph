"""A plant builds while an overlapping PlantArchitecture call unwinds.

Helios resolves a plant's textures against the working directory, then against
HELIOS_BUILD, which PyHelios doesn't set in a packaged build. PyHelios moves into
the asset directory around each PlantArchitecture call, and the working
directory belongs to the whole process. Before PyHelios v0.1.42 each call saved
and restored it on its own, so when two builds overlapped (cancel a canopy,
start a plant while it unwinds) the first to finish moved it out from under the
second, which died with "Could not resolve asset file". The backend worked
around that by pinning HELIOS_BUILD at startup; v0.1.42 (PyHelios#22) counts the
callers inside instead and restores the directory only when the last one leaves,
so the pin is gone.

This holds the overlap still, so the outcome doesn't depend on timing: a caller
enters, a second enters, the first leaves while the second is inside, and the
second then builds a plant with HELIOS_BUILD unset. The E2E spec
plant-generate-cancel.spec.ts covers the real overlap against the bundle.
"""

import os

import pytest

import main  # noqa: F401  (puts the pyhelios submodule on sys.path)

pytest.importorskip("pyhelios")

from pyhelios import Context, PlantArchitecture  # noqa: E402
from pyhelios.PlantArchitecture import _plantarchitecture_working_directory  # noqa: E402
from pyhelios.wrappers.DataTypes import vec3  # noqa: E402


def _build_bean():
    with Context() as context, PlantArchitecture(context) as plantarch:
        plantarch.loadPlantModelFromLibrary("bean")
        plant_id = plantarch.buildPlantInstanceFromLibrary(base_position=vec3(0, 0, 0), age=5)
        return plantarch.getPlantHeight(plant_id)


def test_a_build_survives_an_overlapping_call_leaving_first(monkeypatch, tmp_path):
    monkeypatch.chdir(tmp_path)
    monkeypatch.delenv("HELIOS_BUILD", raising=False)

    first = _plantarchitecture_working_directory()
    second = _plantarchitecture_working_directory()
    asset_dir = first.__enter__()
    second.__enter__()
    try:
        first.__exit__(None, None, None)  # the canceled build unwinds first
        assert os.path.realpath(os.getcwd()) == os.path.realpath(asset_dir)
        assert _build_bean() > 0
    finally:
        second.__exit__(None, None, None)

    # The last caller out restores the directory instead of stranding the
    # process in the asset directory.
    assert os.path.realpath(os.getcwd()) == os.path.realpath(tmp_path)
