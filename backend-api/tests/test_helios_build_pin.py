"""A plant builds whatever the working directory is, once HELIOS_BUILD is pinned.

PyHelios `os.chdir`s around each PlantArchitecture call, and the working
directory belongs to the whole process, so a build that overlaps another (cancel
a canopy, start a plant while it unwinds) can have it moved mid-call. Helios then
falls back to HELIOS_BUILD, which PyHelios doesn't set in a packaged build, and
the second build died with "Could not resolve asset file". The E2E spec
plant-generate-cancel.spec.ts covers the real overlap against the bundle; here
the moved directory is held still, so the outcome doesn't depend on timing.
"""

import contextlib
import sys

import pytest

import main

pytest.importorskip("pyhelios")

from pyhelios import Context, PlantArchitecture  # noqa: E402
from pyhelios.wrappers.DataTypes import vec3  # noqa: E402


@pytest.fixture
def moved_cwd(monkeypatch, tmp_path):
    """The state mid-race: the working directory is not the asset directory, and
    this call's own chdir has already been undone by the other build."""
    monkeypatch.chdir(tmp_path)
    monkeypatch.setattr(
        sys.modules["pyhelios.PlantArchitecture"],
        "_plantarchitecture_working_directory",
        contextlib.nullcontext,
    )
    monkeypatch.delenv("HELIOS_BUILD", raising=False)


def _build_bean():
    with Context() as context, PlantArchitecture(context) as plantarch:
        plantarch.loadPlantModelFromLibrary("bean")
        plant_id = plantarch.buildPlantInstanceFromLibrary(base_position=vec3(0, 0, 0), age=5)
        return plantarch.getPlantHeight(plant_id)


def test_build_needs_the_pin_when_the_working_directory_moves(moved_cwd):
    with pytest.raises(Exception, match="Could not resolve asset file"):
        _build_bean()


def test_pinned_helios_build_survives_a_moved_working_directory(moved_cwd):
    main._pin_helios_build()
    assert _build_bean() > 0


def test_pin_keeps_an_explicit_helios_build(monkeypatch, tmp_path):
    monkeypatch.setenv("HELIOS_BUILD", str(tmp_path))
    main._pin_helios_build()
    assert main.os.environ["HELIOS_BUILD"] == str(tmp_path)
