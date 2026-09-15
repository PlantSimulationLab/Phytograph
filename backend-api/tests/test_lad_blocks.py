"""Block-tiled leaf-area inversion (helios-core v1.3.86).

A voxel grid whose inversion scratch would not fit is inverted one block of the
lattice at a time, so the per-voxel accumulators are sized to the block. The
planner must tile the lattice exactly once, and a tiled inversion must give the
whole-grid result exactly, on both the triangulated and supplied-G(theta) paths.
"""
import os

import numpy as np
import pytest

import main

_FIXTURE_DIR = os.path.join(os.path.dirname(__file__), "fixtures", "lad-leafcube")
_FIXTURE_XYZ = os.path.join(_FIXTURE_DIR, "leafcube.xyz")


@pytest.mark.parametrize("dims,max_cells", [
    ((5, 4, 3), 1), ((5, 4, 3), 7), ((5, 4, 3), 12), ((5, 4, 3), 1000),
    ((1, 1, 9), 4), ((7, 1, 2), 5), ((3, 3, 3), 9),
])
def test_blocks_tile_the_lattice_exactly_once(dims, max_cells):
    nx, ny, nz = dims
    seen = np.zeros(dims, dtype=np.int32)
    for lo, hi in main._lad_lattice_blocks(nx, ny, nz, max_cells):
        size = (hi[0] - lo[0] + 1) * (hi[1] - lo[1] + 1) * (hi[2] - lo[2] + 1)
        assert size <= max_cells
        seen[lo[0]:hi[0] + 1, lo[1]:hi[1] + 1, lo[2]:hi[2] + 1] += 1
    assert (seen == 1).all()


def test_blocks_keep_whole_columns_when_a_column_fits():
    for lo, hi in main._lad_lattice_blocks(6, 6, 4, 16):
        assert lo[2] == 0 and hi[2] == 3


def test_block_limit_is_off_for_ordinary_grids_and_pinnable(monkeypatch):
    monkeypatch.delenv("PHYTOGRAPH_LAD_BLOCK_CELLS", raising=False)
    assert main._lad_block_cells_limit(40 * 40 * 20) is None
    monkeypatch.setattr(main.memory_budget, "budget_bytes", lambda: 4 * 2**20)
    limit = main._lad_block_cells_limit(10_000_000)
    assert limit is not None and 1 <= limit < 10_000_000
    monkeypatch.setenv("PHYTOGRAPH_LAD_BLOCK_CELLS", "3")
    assert main._lad_block_cells_limit(8) == 3


def _request(gtheta=None):
    scan = main.HeliosScanEntry(
        file_path=_FIXTURE_XYZ, ascii_format="x y z is_miss", origin=[-5.0, 0.0, 0.5],
        n_theta=2600, n_phi=5200, theta_min=0, theta_max=180,
        phi_min=0, phi_max=360, return_type="single")
    # A static scan takes the supplied-G(theta) path only with the override set.
    extra = {} if gtheta is None else {"gtheta": gtheta, "gtheta_override": True}
    return main.LADComputeRequest(
        scans=[scan],
        grid=main.HeliosGrid(center=[0, 0, 0.5], size=[1, 1, 1], nx=2, ny=2, nz=2),
        lmax=0.04, max_aspect_ratio=10, min_voxel_hits=1, **extra)


def _cells(result):
    return {tuple(round(v, 6) for v in c["center"]): c for c in result["cells"]}


@pytest.mark.skipif(not os.path.isfile(_FIXTURE_XYZ), reason="lad-leafcube fixture not present")
@pytest.mark.parametrize("gtheta", [None, 0.5], ids=["triangulated", "supplied-gtheta"])
def test_tiled_inversion_gives_the_whole_grid_result(monkeypatch, gtheta):
    pytest.importorskip("pyhelios")
    from pyhelios import LiDARCloud

    monkeypatch.delenv("PHYTOGRAPH_LAD_BLOCK_CELLS", raising=False)
    whole = main._do_lad_computation(_request(gtheta))
    assert whole["success"] is True, whole.get("error")

    calls = []
    real = LiDARCloud.calculateLeafAreaBlock

    def spy(self, *args, **kwargs):
        calls.append(kwargs.get("Gtheta"))
        return real(self, *args, **kwargs)

    monkeypatch.setattr(LiDARCloud, "calculateLeafAreaBlock", spy)
    monkeypatch.setenv("PHYTOGRAPH_LAD_BLOCK_CELLS", "1")
    tiled = main._do_lad_computation(_request(gtheta))
    assert tiled["success"] is True, tiled.get("error")
    # Not vacuous: all eight voxels were inverted as single-voxel blocks.
    assert len(calls) == 8
    # ...and on the path this case names: G(theta) supplied, or triangulated.
    assert all((g is None) == (gtheta is None) for g in calls), calls

    a, b = _cells(whole), _cells(tiled)
    assert a.keys() == b.keys() and len(a) == 8
    for key in a:
        for field in ("lad", "gtheta", "beam_count"):
            if field in a[key]:
                assert b[key][field] == a[key][field], (key, field, a[key][field], b[key][field])
    assert tiled.get("cropped_returns") == whole.get("cropped_returns")
