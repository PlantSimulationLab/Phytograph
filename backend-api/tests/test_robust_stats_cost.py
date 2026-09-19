"""What the import's robust statistics are allowed to COST, and why the cheaper
form is still the same number.

`_robust_extent` and `_robust_aabb` used to compute the identical 1st/99th
percentiles independently, so every import — which wants both — did the whole
thing twice: two full-array copies and two triple-percentile passes. On one
23 M-point VZ-1000 position that was 3.4 s of a 22.7 s session build, for a
result the first call already held. The extent is now derived from the box.

The remaining single pass then asks `np.percentile` for both cutoffs in ONE
call. That halves the partitioning, and it is bit-identical — but only for
float64 input, which is the subtlety this file exists to pin. numpy returns
float32 for a scalar `q` over a float32 array and float64 for a sequence of
them, so the final interpolation happens at different precisions and the two
forms disagree in the last few ULPs (measured: 290 of 300 random float32
trials, 0 of 300 float64 ones). `CloudSession.positions` is float64 by
invariant, so `_robust_aabb` may do this; `_robust_attribute_ranges` works on
float32 columns and deliberately may not.

The copies are elided the same way throughout: probing `np.isfinite(...).all()`
costs ~10 ms against ~350 ms to materialise the mask-selected copy, and the
arrays an importer produces are all-finite.
"""

import numpy as np
import pytest

from main import (
    _EXTENT_HIGH_PERCENTILE,
    _EXTENT_LOW_PERCENTILE,
    _GROUND_PERCENTILE,
    _extent_of_aabb,
    _finite_xyz,
    _robust_aabb,
    _robust_attribute_ranges,
    _robust_extent,
    _robust_ground_z,
)

LO, HI = _EXTENT_LOW_PERCENTILE, _EXTENT_HIGH_PERCENTILE


# --------------------------------------------------------------------------
# Verbatim copies of the implementations these replaced. Not a restatement of
# the new code — a frozen reference to measure it against.
# --------------------------------------------------------------------------


def _legacy_aabb(p):
    if p is None or len(p) == 0 or p.shape[1] < 3:
        return None
    f = p[np.isfinite(p[:, :3]).all(axis=1), :3]
    if f.shape[0] == 0:
        return None
    lo = np.percentile(f, LO, axis=0)
    hi = np.percentile(f, HI, axis=0)
    return {
        "min": [float(lo[i]) for i in range(3)],
        "max": [float(max(hi[i], lo[i])) for i in range(3)],
    }


def _legacy_extent(p):
    if p is None or len(p) == 0 or p.shape[1] < 3:
        return None
    f = p[np.isfinite(p[:, :3]).all(axis=1), :3]
    if f.shape[0] == 0:
        return None
    lo = np.percentile(f, LO, axis=0)
    hi = np.percentile(f, HI, axis=0)
    return [float(max(0.0, hi[i] - lo[i])) for i in range(3)]


def _legacy_ground_z(p):
    if p is None or len(p) == 0 or p.shape[1] < 3:
        return None
    z = p[:, 2]
    z = z[np.isfinite(z)]
    if z.size == 0:
        return None
    return float(np.percentile(z, _GROUND_PERCENTILE))


def _legacy_ranges(intensity, extras):
    out = {}

    def add(slug, arr):
        if arr is None:
            return
        a = np.asarray(arr)
        if a.ndim != 1 or a.size == 0:
            return
        f = a[np.isfinite(a)]
        if f.size == 0:
            return
        lo = float(np.percentile(f, LO))
        hi = float(np.percentile(f, HI))
        if not (hi > lo):
            return
        out[slug] = [lo, hi]

    add("intensity", intensity)
    for slug, arr in (extras or {}).items():
        add(slug, arr)
    return out


def _clouds():
    """float64 position arrays covering what an importer can hand these."""
    rng = np.random.default_rng(20240216)
    yield "empty", np.empty((0, 3))
    yield "single point", np.zeros((1, 3))
    yield "two columns", rng.normal(size=(500, 2))
    yield "all identical", np.ones((5_000, 3))
    yield "degenerate z", np.column_stack(
        [rng.normal(size=4_000), rng.normal(size=4_000), np.zeros(4_000)]
    )
    yield "clean", rng.normal(size=(50_000, 3)) * 12.0
    yield "all NaN", np.full((1_000, 3), np.nan)
    with_nan = rng.normal(size=(50_000, 3))
    with_nan[rng.integers(0, 50_000, 500)] = np.nan
    yield "sparse NaNs", with_nan
    with_inf = rng.normal(size=(50_000, 3))
    with_inf[rng.integers(0, 50_000, 500)] = np.inf
    yield "sparse infs", with_inf
    # The failure the robust box exists for, and the coordinate magnitude that
    # has broken other parts of this pipeline (UTM northings ~5.4e6).
    strays = rng.normal(size=(50_000, 3))
    strays[:50] *= 1e5
    yield "far strays", strays + np.array([5.4e5, 5.4e6, 100.0])
    # A miss shell: a few million points parked ~1 km out along the beam.
    hits = rng.normal(size=(40_000, 3)) * 8.0
    misses = rng.normal(size=(20_000, 3))
    misses /= np.linalg.norm(misses, axis=1, keepdims=True)
    yield "hits plus a 1 km miss shell", np.vstack([hits, misses * 1000.0])


@pytest.mark.parametrize("label,cloud", list(_clouds()), ids=lambda v: v if isinstance(v, str) else "")
def test_the_cheaper_box_is_the_same_box(label, cloud):
    assert _robust_aabb(cloud) == _legacy_aabb(cloud)
    assert _robust_ground_z(cloud) == _legacy_ground_z(cloud)


@pytest.mark.parametrize("label,cloud", list(_clouds()), ids=lambda v: v if isinstance(v, str) else "")
def test_the_derived_extent_is_the_computed_one(label, cloud):
    """The whole point of the change: nobody needs to measure this twice."""
    assert _extent_of_aabb(_robust_aabb(cloud)) == _legacy_extent(cloud)
    assert _robust_extent(cloud) == _legacy_extent(cloud)


def test_the_two_agree_on_random_float64_clouds():
    """A sweep, because the single-call percentile equivalence is a numpy
    property rather than something this code enforces."""
    rng = np.random.default_rng(7)
    for _ in range(80):
        n = int(rng.integers(1, 40_000))
        cloud = rng.normal(size=(n, 3)) * rng.uniform(1e-6, 1e6)
        if rng.random() < 0.3:
            cloud[rng.integers(0, n, max(1, n // 50))] = np.nan
        assert _robust_aabb(cloud) == _legacy_aabb(cloud)
        assert _robust_extent(cloud) == _legacy_extent(cloud)


def test_attribute_ranges_are_unchanged_including_on_float32_columns():
    """The columns are float32, which is exactly where the single-call form
    would shift the answer — so that optimisation stops at the box."""
    rng = np.random.default_rng(99)
    n = 200_000
    cols = {
        "reflectance": (rng.normal(size=n) * 6.0 - 12.0).astype(np.float32),
        "amplitude": (rng.gamma(2.0, 3.0, size=n)).astype(np.float32),
        "target_index": rng.integers(1, 5, size=n).astype(np.float32),
        "constant": np.ones(n, np.float32),
        "all nan": np.full(n, np.nan, np.float32),
        "some nan": np.where(rng.random(n) < 0.02, np.nan,
                             rng.normal(size=n)).astype(np.float32),
        "empty": np.empty(0, np.float32),
        "float64 column": rng.normal(size=n),
    }
    intensity = (rng.random(n) * 1000.0).astype(np.float32)
    assert _robust_attribute_ranges(intensity, cols) == _legacy_ranges(intensity, cols)
    assert _robust_attribute_ranges(None, None) == _legacy_ranges(None, None)


def test_the_float32_hazard_is_real_and_not_theoretical():
    """Pins WHY `_robust_attribute_ranges` keeps two percentile calls. If numpy
    ever makes these agree this test fails and the comment can come out —
    which is the outcome worth being told about."""
    rng = np.random.default_rng(3)
    col = (rng.normal(size=500_000) * 1e3).astype(np.float32)
    scalar_form = float(np.percentile(col, HI))
    sequence_form = float(np.percentile(col, [LO, HI])[1])
    assert scalar_form == pytest.approx(sequence_form, rel=1e-5)
    assert scalar_form != sequence_form

    # ...and that it is genuinely absent in float64, which is what lets the box
    # take the cheaper form.
    col64 = col.astype(np.float64)
    assert float(np.percentile(col64, HI)) == float(np.percentile(col64, [LO, HI])[1])


def test_positions_reaching_the_box_are_float64():
    """The invariant the single-call optimisation rests on: every production
    caller of `_robust_aabb` passes `sess.positions`, which is float64. Asserted
    against the declaration so a future float32 positions array fails here
    rather than shifting camera framing by a few ULPs in silence."""
    import inspect

    import main

    decl = [
        line
        for line in inspect.getsource(main.CloudSession).splitlines()
        if line.strip().startswith("positions:")
    ]
    assert decl, "CloudSession no longer declares `positions` — check this test"
    assert "float64" in decl[0], decl[0]


def test_the_import_path_measures_the_percentiles_once():
    """A correctness test cannot catch this one: computing the extent separately
    again would give the same answer, just twice as slowly. So read the source.

    Two properties, together: `_robust_extent` is the composition (so it cannot
    drift from the box it is supposed to be the span of), and the session build
    derives rather than recomputes.
    """
    import ast
    import inspect

    import main

    extent = ast.parse(inspect.getsource(main._robust_extent))
    attrs = {
        node.func.attr
        for node in ast.walk(extent)
        if isinstance(node, ast.Call) and isinstance(node.func, ast.Attribute)
    }
    assert "percentile" not in attrs, (
        "_robust_extent measures its own percentiles again — it should be "
        "_extent_of_aabb(_robust_aabb(...))"
    )

    build = ast.parse(inspect.getsource(main._do_create_cloud_session_inner))
    called = {
        node.func.id
        for node in ast.walk(build)
        if isinstance(node, ast.Call) and isinstance(node.func, ast.Name)
    }
    assert "_robust_aabb" in called
    assert "_extent_of_aabb" in called
    assert "_robust_extent" not in called, (
        "the session build recomputes the extent instead of deriving it from "
        "the box it already has"
    )


def test_finite_xyz_returns_a_view_when_it_can_and_a_copy_when_it_must():
    """The copy elision, which is where the rest of the saving comes from."""
    clean = np.arange(30.0).reshape(10, 3)
    got = _finite_xyz(clean)
    assert np.shares_memory(got, clean), "an all-finite cloud must not be copied"
    assert np.array_equal(got, clean)

    dirty = clean.copy()
    dirty[4, 1] = np.nan
    got = _finite_xyz(dirty)
    assert not np.shares_memory(got, dirty)
    assert got.shape[0] == 9
    assert np.isfinite(got).all()

    # Extra columns beyond xyz are dropped either way.
    wide = np.hstack([clean, np.arange(10.0).reshape(10, 1)])
    assert _finite_xyz(wide).shape[1] == 3
