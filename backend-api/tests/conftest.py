"""Shared pytest fixtures.

`main.py` lives in the parent directory; tests is a sibling. Add the parent
to sys.path so `import main` works without needing an editable install.
"""

import sys
from pathlib import Path

import numpy as np
import pytest

BACKEND_DIR = Path(__file__).resolve().parent.parent
if str(BACKEND_DIR) not in sys.path:
    sys.path.insert(0, str(BACKEND_DIR))


@pytest.fixture(scope="session")
def client():
    """FastAPI TestClient bound to the real app. No mocks."""
    from fastapi.testclient import TestClient
    import main

    return TestClient(main.app)


@pytest.fixture
def cylinder_points() -> np.ndarray:
    """A thin vertical cylinder, r=0.3, h=1.5, 60 points (matches tests/e2e/fixtures/tiny.xyz)."""
    pts = []
    for ring in range(5):
        z = ring * 0.375
        for k in range(12):
            theta = k * (2 * np.pi / 12)
            pts.append([0.3 * np.cos(theta), 0.3 * np.sin(theta), z])
    return np.array(pts, dtype=np.float64)
