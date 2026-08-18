"""Brush sphere-union region — mask correctness and validation.

Like the slab, and unlike every other brush/lasso region, this one involves NO
CAMERA: a sphere is world-space, so the renderer's preview and this backend
replay agree by construction rather than by two projection implementations
happening to match. That is the whole reason the brush uses spheres rather than
the erase brush's screen-space squares.

The property that matters most is depth limiting. A square stamp is a 2-D
screen test, so it removes points at EVERY depth behind it — lasso a leaf
cluster and the trunk behind it goes too. A sphere cannot do that, and the
tests below pin it.
"""

import numpy as np
import pytest
from fastapi import HTTPException

import main


def grid(n=20, step=0.1):
    """A dense cube of points, so a sphere's membership count is meaningful."""
    return np.array(
        [[x * step, y * step, z * step]
         for x in range(n) for y in range(n) for z in range(n)],
        dtype=np.float64,
    )


def test_matches_brute_force_distance():
    # The mask IS "within r of c" — assert against the definition rather than a
    # restatement of the implementation.
    pos = grid()
    region = {"kind": "spheres_union", "centers": [[0.5, 0.5, 0.5]], "radii": [0.25]}
    got = main._region_mask(pos, region)
    want = np.linalg.norm(pos - np.array([0.5, 0.5, 0.5]), axis=1) <= 0.25
    assert got.tolist() == want.tolist()
    assert got.sum() > 0, "fixture must actually contain points in the sphere"


def test_is_depth_limited_not_an_extrusion():
    # THE point of the sphere brush. A screen-space square stamp centred here
    # would also take the far point, because it extrudes through the cloud.
    region = {"kind": "spheres_union", "centers": [[0.0, 0.0, 0.0]], "radii": [1.0]}
    pos = np.array([[0.0, 0.0, 0.0], [0.0, 0.0, 0.5], [0.0, 0.0, 50.0]])
    assert main._region_mask(pos, region).tolist() == [True, True, False]


def test_union_of_overlapping_spheres_is_not_double_counted():
    pos = grid()
    a = {"kind": "spheres_union", "centers": [[0.5, 0.5, 0.5]], "radii": [0.3]}
    both = {"kind": "spheres_union",
            "centers": [[0.5, 0.5, 0.5], [0.6, 0.5, 0.5]], "radii": [0.3, 0.3]}
    m_a = main._region_mask(pos, a)
    m_both = main._region_mask(pos, both)
    # A union only ever grows, and overlapping spheres share points.
    assert m_both.sum() > m_a.sum()
    assert np.all(m_both[m_a]), "every point in one sphere stays in the union"


def test_disjoint_spheres_select_both_clusters():
    pos = np.array([[0.0, 0.0, 0.0], [5.0, 5.0, 5.0], [50.0, 50.0, 50.0]])
    region = {"kind": "spheres_union",
              "centers": [[0.0, 0.0, 0.0], [5.0, 5.0, 5.0]], "radii": [0.1, 0.1]}
    assert main._region_mask(pos, region).tolist() == [True, True, False]


def test_boundary_is_inclusive():
    # <= not <, matching the squares union. A point exactly on the surface is in.
    region = {"kind": "spheres_union", "centers": [[0.0, 0.0, 0.0]], "radii": [1.0]}
    pos = np.array([[1.0, 0.0, 0.0], [1.0 + 1e-9, 0.0, 0.0]])
    got = main._region_mask(pos, region)
    assert bool(got[0]) is True
    assert bool(got[1]) is False


def test_invert_keeps_the_complement():
    # The erase path sends invert=True; the region vocabulary is shared, so the
    # flag has to work here too.
    pos = np.array([[0.0, 0.0, 0.0], [50.0, 0.0, 0.0]])
    region = {"kind": "spheres_union", "centers": [[0.0, 0.0, 0.0]], "radii": [1.0],
              "invert": True}
    assert main._region_mask(pos, region).tolist() == [False, True]


def test_needs_no_camera_matrices():
    # Explicitly: no projection/view/canvas anywhere in the payload. If this
    # ever starts failing, the region has grown a camera dependency and the
    # preview/apply parity argument no longer holds.
    region = {"kind": "spheres_union", "centers": [[0.0, 0.0, 0.0]], "radii": [1.0]}
    assert main._canonical_region(dict(region))
    assert main._region_mask(np.array([[0.0, 0.0, 0.0]]), region).tolist() == [True]


def test_canonical_form_is_stable_and_distinguishing():
    a = {"kind": "spheres_union", "centers": [[1.0, 2.0, 3.0]], "radii": [0.5]}
    b = {"kind": "spheres_union", "centers": [[1.0, 2.0, 3.0]], "radii": [0.5]}
    c = {"kind": "spheres_union", "centers": [[1.0, 2.0, 3.0]], "radii": [0.6]}
    assert main._canonical_region(a) == main._canonical_region(b)
    assert main._canonical_region(a) != main._canonical_region(c)


@pytest.mark.parametrize("region,why", [
    ({"kind": "spheres_union", "centers": [[0, 0, 0]], "radii": []}, "length mismatch"),
    ({"kind": "spheres_union", "centers": [], "radii": []}, "no spheres"),
    ({"kind": "spheres_union", "centers": [[0, 0]], "radii": [1]}, "2-D centre"),
    ({"kind": "spheres_union", "centers": [[0, 0, 0]], "radii": [0]}, "zero radius"),
    ({"kind": "spheres_union", "centers": [[0, 0, 0]], "radii": [-1]}, "negative radius"),
    ({"kind": "spheres_union", "centers": "nope", "radii": [1]}, "centers not a list"),
])
def test_malformed_regions_are_rejected_with_400(region, why):
    # Rejected loudly rather than silently selecting nothing — a brush that
    # quietly paints zero points is the hardest kind of bug to notice.
    with pytest.raises(HTTPException) as exc:
        main._canonical_region(dict(region))
    assert exc.value.status_code == 400, why


def test_many_stamps_accumulate():
    # A drag emits many stamps in one batch; the union must handle them all.
    pos = grid()
    centers = [[i * 0.1, 0.5, 0.5] for i in range(20)]
    region = {"kind": "spheres_union", "centers": centers, "radii": [0.12] * 20}
    got = main._region_mask(pos, region)
    # A swept tube of 20 overlapping spheres takes far more than any one of them.
    single = main._region_mask(
        pos, {"kind": "spheres_union", "centers": [centers[10]], "radii": [0.12]})
    assert got.sum() > single.sum() * 3
