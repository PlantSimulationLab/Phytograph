"""A plant request that fails releases the native objects it created.

Session create entered a pyhelios Context and PlantArchitecture and, on any
failure after that (an unknown model, a build or leaf-angle error), returned an
error with both still allocated. Morph released them unconditionally, so a
failure AFTER it had registered its session freed that session's own Context.
"""

import pyhelios
import pytest

import main


class _Handle:
    live: list = []

    def __init__(self, *a, **k):
        self.exited = False
        _Handle.live.append(self)

    def __enter__(self):
        return self

    def __exit__(self, *exc):
        self.exited = True


class _FakeContext(_Handle):
    def seedRandomGenerator(self, seed):
        pass


class _FakeArch(_Handle):
    def getAvailablePlantModels(self):
        return ["bean"]

    def loadPlantModelFromLibrary(self, name):
        raise RuntimeError("model library is corrupt")


@pytest.fixture
def fakes(monkeypatch):
    _Handle.live.clear()
    monkeypatch.setattr(pyhelios, "Context", _FakeContext)
    monkeypatch.setattr(pyhelios, "PlantArchitecture", _FakeArch)
    yield _Handle.live
    _Handle.live.clear()


def test_a_failed_session_create_releases_its_handles(fakes):
    before = set(main._plant_sessions)
    res = main.create_plant_session(main.PlantSessionCreateRequest(plant_type="bean"))
    assert res.success is False and "corrupt" in (res.error or "")
    assert len(fakes) == 2, "the fixture did not reach the native handles"
    assert all(h.exited for h in fakes), "a failed create left its Context allocated"
    assert set(main._plant_sessions) == before


def test_each_handle_is_released_even_if_the_first_release_raises():
    """Morph and the streaming generator released both inside ONE try, so a
    PlantArchitecture whose exit raised (or that was never created) left the
    Context allocated."""
    class _Raises(_Handle):
        def __exit__(self, *exc):
            raise RuntimeError("exit failed")

    arch, ctx = _Raises(), _FakeContext()
    main._close_plant_handles(arch, ctx)
    assert ctx.exited
    ctx2 = _FakeContext()
    main._close_plant_handles(None, ctx2)          # plantarch never created
    assert ctx2.exited
