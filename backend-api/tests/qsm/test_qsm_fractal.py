"""Box-counting fractal dimension of a QSM (qsm/fractal.py).

Asserted against geometry whose answer is known: a straight stick is exactly
1-dimensional at every scale, and a self-similar branching tree's dimension
rises with its branch-length ratio. The fit diagnostics are checked for what
they are meant to say (a stick is a perfect power law; a crown is not).
"""

from __future__ import annotations

import numpy as np
import pytest

from qsm.fractal import MIN_SCALES, compute_fractal_dimension
from qsm.metrics import compute_metrics
from qsm.model import QSM, Cylinder
from qsm.validation.synthetic import simple_tree


def _binary_tree(ratio: float, generations: int = 10) -> QSM:
    """Each branch forks into two children `ratio` times as long and thick,
    35 deg off the parent axis, the fork plane rolled 90 deg every generation
    so the crown is 3-D."""
    cyls: list[Cylinder] = []

    def grow(p, d, length, r, gen, parent):
        e = p + d * length
        cid = len(cyls)
        cyls.append(Cylinder(cid, p, e, r, parent_id=parent))
        if gen == 0:
            return
        perp = np.cross(d, [1.0, 0, 0]) if abs(d[0]) < 0.9 else np.cross(d, [0, 1.0, 0])
        perp /= np.linalg.norm(perp)
        if gen % 2:
            perp = np.cross(d, perp)
        a = np.radians(35.0)
        for sgn in (1.0, -1.0):
            nd = np.cos(a) * d + sgn * np.sin(a) * perp
            grow(e, nd / np.linalg.norm(nd), length * ratio, r * ratio, gen - 1, cid)

    grow(np.zeros(3), np.array([0, 0, 1.0]), 2.0, 0.05, generations, -1)
    return QSM(cylinders=cyls)


def test_empty_qsm_has_no_dimension():
    assert compute_fractal_dimension(QSM()) is None
    assert compute_metrics(QSM()).fractal is None


def test_straight_stick_is_one_dimensional():
    """A 10 m, 1 cm twig: N doubles exactly with every halving of the box."""
    f = compute_fractal_dimension(QSM(cylinders=[Cylinder(0, [0, 0, 0], [0, 0, 10], 0.005)]))
    assert f is not None
    assert f.dimension == pytest.approx(1.0, abs=0.02)
    assert f.r_squared == pytest.approx(1.0, abs=1e-4)
    assert f.local_slope_min == pytest.approx(1.0, abs=0.05)
    assert f.local_slope_max == pytest.approx(1.0, abs=0.05)
    # Box sizes halve from the extent; counts grow 1, 2, 4, ...
    assert f.box_sizes_m[0] == pytest.approx(10.01, rel=1e-3)
    assert np.allclose(np.array(f.box_sizes_m[:-1]) / np.array(f.box_sizes_m[1:]), 2.0)
    assert f.box_counts[:4] == [1, 2, 4, 8]


def test_stubby_model_spanning_too_few_scales_reports_none():
    """Diameter comparable to length: no range of scales to fit a slope over."""
    f = compute_fractal_dimension(QSM(cylinders=[Cylinder(0, [0, 0, 0], [0, 0, 0.5], 0.1)]))
    assert f is None


def test_dimension_rises_with_branch_length_ratio():
    """Longer children fill space more densely -> higher dimension, and every
    branching tree is clearly more than a line and less than a solid."""
    dims = [compute_fractal_dimension(_binary_tree(r)).dimension for r in (0.5, 0.6, 0.7)]
    assert dims[0] < dims[1] < dims[2]
    assert 1.3 < dims[0] and dims[2] < 2.3


def test_crown_fit_diagnostics_are_consistent():
    f = compute_fractal_dimension(_binary_tree(0.6))
    assert len(f.box_sizes_m) == len(f.box_counts) >= MIN_SCALES
    assert all(a <= b for a, b in zip(f.box_counts, f.box_counts[1:]))
    assert 0.9 < f.r_squared < 1.0
    # A finite tree is not a perfect power law: the local slope varies across
    # octaves, and the fitted slope lies within that spread.
    assert f.local_slope_min < f.dimension < f.local_slope_max


def test_compute_metrics_carries_the_fractal():
    m = compute_metrics(simple_tree())
    assert m.fractal is not None
    assert 1.0 < m.fractal.dimension < 2.0


def test_grid_offset_invariance_under_translation():
    """Moving the tree must not change the answer (the grid is anchored to the
    model's own bounding box)."""
    q = _binary_tree(0.6, generations=8)
    f0 = compute_fractal_dimension(q)
    shifted = QSM(cylinders=[
        Cylinder(c.cyl_id, c.start + [123.4, -56.7, 8.9], c.end + [123.4, -56.7, 8.9], c.radius)
        for c in q.cylinders
    ])
    f1 = compute_fractal_dimension(shifted)
    assert f1.dimension == pytest.approx(f0.dimension, abs=1e-6)
