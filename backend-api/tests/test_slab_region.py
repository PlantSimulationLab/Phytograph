"""Cross-section slab region — mask correctness and TS/Python parity.

The slab is the one region kind that involves NO CAMERA: it is a world-space
prism, so the renderer's preview and this backend replay agree by construction
rather than by two projection implementations happening to match. That property
is only worth anything if the two predicates really are the same function, which
is what the golden-vector test below pins down.

`slab_golden.json` is generated FROM the TypeScript predicate's own math (see
the generator in the Phase 2 commit message), so it checks the Python against
what the renderer actually does, not against a restatement of the spec.
"""

import json
from pathlib import Path

import numpy as np
import pytest

import main

GOLDEN = Path(__file__).parent / "fixtures" / "slab_golden.json"

SLAB = {
    "kind": "slab",
    "a": [0.0, 0.0], "b": [10.0, 0.0],
    "depth": 2.0, "zMin": 0.0, "zMax": 10.0, "offset": 0.0,
}


def _mask(region, pts):
    return main._region_mask(np.asarray(pts, dtype=np.float64), region)


def test_matches_the_renderer_predicate_on_golden_vectors():
    """The parity gate. A divergence here means the preview shows one thing and
    the applied result is another — silently."""
    cases = json.loads(GOLDEN.read_text())
    assert cases, "golden fixture is empty"
    total = 0
    for case in cases:
        region = {"kind": "slab", **case["slab"]}
        got = _mask(region, case["points"])
        expected = np.asarray(case["expected"], dtype=bool)
        # Report the first disagreement concretely rather than "arrays differ".
        bad = np.flatnonzero(got != expected)
        assert bad.size == 0, (
            f"slab {case['slab']} disagrees at point {case['points'][bad[0]]}: "
            f"python={got[bad[0]]} renderer={expected[bad[0]]}"
        )
        total += len(case["points"])
    assert total >= 500, "golden fixture should cover a meaningful sample"


def test_selects_inside_and_rejects_outside():
    pts = [
        [5.0, 0.0, 5.0],     # centreline
        [5.0, 0.9, 5.0],     # inside the face
        [5.0, 1.1, 5.0],     # past the face
        [-0.5, 0.0, 5.0],    # before the centreline start
        [10.5, 0.0, 5.0],    # past its end
        [5.0, 0.0, -0.5],    # below
        [5.0, 0.0, 10.5],    # above
    ]
    assert _mask(SLAB, pts).tolist() == [True, True, False, False, False, False, False]


def test_offset_moves_the_slab_along_its_normal():
    pts = [[5.0, 0.0, 5.0], [5.0, 5.0, 5.0]]
    assert _mask(SLAB, pts).tolist() == [True, False]
    stepped = {**SLAB, "offset": 5.0}
    assert _mask(stepped, pts).tolist() == [False, True]


def test_works_on_a_diagonal_centreline():
    region = {**SLAB, "a": [0.0, 0.0], "b": [3.0, 4.0], "depth": 1.0}
    # Midpoint of the centreline is inside; a point 2 units off its normal is not.
    assert _mask(region, [[1.5, 2.0, 5.0]]).tolist() == [True]
    assert _mask(region, [[1.5 - 1.6, 2.0 + 1.2, 5.0]]).tolist() == [False]


def test_invert_flips_the_selection():
    pts = [[5.0, 0.0, 5.0], [5.0, 5.0, 5.0]]
    assert _mask({**SLAB, "invert": True}, pts).tolist() == [False, True]


def test_empty_positions_is_handled():
    assert _mask(SLAB, np.zeros((0, 3))).shape == (0,)


# ── Validation ───────────────────────────────────────────────────────────────

def test_canonical_region_accepts_a_slab():
    key = main._canonical_region(dict(SLAB))
    assert key.startswith("slab|")


@pytest.mark.parametrize("bad", [
    {"a": None},                                          # missing a
    {"b": None},                                          # missing b
    {"a": [0.0], "b": [1.0, 1.0]},                        # malformed a
    {"zMin": "nope"},                                     # non-numeric extent
    {"depth": 0.0},                                       # non-positive depth
    {"depth": -1.0},
    {"zMax": -5.0},                                       # zMax < zMin
    {"b": [0.0, 0.0]},                                    # zero-length centreline
])
def test_canonical_region_rejects_malformed_slabs(bad):
    from fastapi import HTTPException
    region = {**SLAB, **bad}
    with pytest.raises(HTTPException) as e:
        main._canonical_region(region)
    assert e.value.status_code == 400


def test_a_zero_length_centreline_is_rejected_by_the_mask_too():
    from fastapi import HTTPException
    with pytest.raises(HTTPException):
        _mask({**SLAB, "b": [0.0, 0.0]}, [[0.0, 0.0, 0.0]])
