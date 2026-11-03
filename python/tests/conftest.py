"""Client tests run against a REAL backend (CLAUDE.md E2E rule 1: no mocking the
FastAPI server). One backend is launched per test session from the dev
checkout's venv, exactly as `phytograph.Backend(source="dev")` does for a user."""
from __future__ import annotations

import sys
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / "python"))

import phytograph as pg  # noqa: E402

E2E_FIXTURES = ROOT / "tests" / "e2e" / "fixtures"
BACKEND_FIXTURES = ROOT / "backend-api" / "tests" / "fixtures"


@pytest.fixture(scope="session")
def backend():
    be = pg.Backend(source="dev")
    yield be
    be.close()


@pytest.fixture
def forest_plot() -> Path:
    return E2E_FIXTURES / "forest-plot.xyz"


@pytest.fixture
def scalars_xyz() -> Path:
    return BACKEND_FIXTURES / "scalars.xyz"


def write_ptx(path: Path, blocks) -> Path:
    """A minimal PTX file: one block per (translation, miss_mask) pair.

    Each block is a 12x16 angular grid at 5 m range, in PTX's row-vector pose
    convention (translation in the last matrix row), column-major data lines.
    A cell in `miss_mask` is written as 0 0 0 — a beam with no return, which the
    importer turns into a sky/miss point. Mirrors the writer in
    backend-api/tests/test_ptx_import.py, which can't be imported here (it loads
    the backend in-process)."""
    import numpy as np
    rows, cols = 12, 16
    zen = np.radians(np.linspace(70, 110, rows))
    az = np.radians(np.linspace(-20, 20, cols))
    out = []
    for trans, miss in blocks:
        miss = np.zeros((rows, cols), bool) if miss is None else miss
        out += [str(cols), str(rows), " ".join(map(str, trans)),
                "1 0 0", "0 1 0", "0 0 1",
                "1 0 0 0", "0 1 0 0", "0 0 1 0", " ".join(map(str, trans)) + " 1"]
        for c in range(cols):
            for r in range(rows):
                if miss[r, c]:
                    out.append("0 0 0 0.5 0 0 0")
                else:
                    x = 5 * np.sin(zen[r]) * np.cos(az[c])
                    y = 5 * np.sin(zen[r]) * np.sin(az[c])
                    z = 5 * np.cos(zen[r])
                    out.append(f"{x:.6f} {y:.6f} {z:.6f} 0.25 128 64 32")
    path.write_text("\n".join(out) + "\n")
    return path
