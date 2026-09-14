"""Outlier-resistant per-attribute colorbar ranges (`_robust_attribute_ranges`).

A colormap stretches its domain across the full ramp, so a domain taken from a
column's absolute extrema is set by that column's single most extreme value. One
saturated specular return in reflectance, one noise spike in deviation, and every
real point crowds into a few percent of the ramp: the cloud renders as one flat
colour and the structure the user is reading disappears, with nothing on screen
to explain why.

These tests pin both halves — the tail is rejected, the real spread is not — plus
the contract the renderer depends on: degenerate columns are OMITTED (so the
consumer keeps its raw extrema) and categorical columns are INCLUDED (the gate
lives in the renderer, which alone knows which columns are labels).
"""
import numpy as np
import pytest

from main import (
    _EXTENT_HIGH_PERCENTILE,
    _EXTENT_LOW_PERCENTILE,
    _robust_attribute_ranges,
)


def _clean(n=10_000, lo=10.0, hi=40.0):
    """A dense, evenly spread column over [lo, hi]."""
    return np.linspace(lo, hi, n)


def test_rejects_a_high_outlier_tail():
    # 9,990 real returns over 10..40, plus 10 saturated spikes at 900. The raw
    # max is 900, which would spend 96% of the colormap on empty value space;
    # the percentile has to stay with the data.
    col = np.concatenate([_clean(9_990), np.full(10, 900.0)])
    lo, hi = _robust_attribute_ranges(None, {"reflectance": col})["reflectance"]
    assert hi < 45.0, "the 900 spike still set the top of the ramp"
    # The whole point is resolution: the robust span must be a small fraction of
    # the raw one, so the real data gets essentially the whole colormap.
    assert (hi - lo) < 0.1 * (float(col.max()) - float(col.min()))


def test_rejects_a_low_outlier_tail():
    col = np.concatenate([_clean(9_990), np.full(10, -5000.0)])
    lo, hi = _robust_attribute_ranges(None, {"dev": col})["dev"]
    assert lo > 0.0, "the -5000 spike still set the bottom of the ramp"
    assert (hi - lo) < 0.1 * (float(col.max()) - float(col.min()))


def test_keeps_the_real_spread_on_a_clean_column():
    # The fix must not cost meaningful resolution when there are no outliers.
    # A percentile over a uniform column trims exactly 1% off each end by
    # construction, so assert that bound rather than the raw extrema.
    col = _clean()
    lo, hi = _robust_attribute_ranges(None, {"r": col})["r"]
    span = float(col.max()) - float(col.min())
    assert (hi - lo) > 0.97 * span
    assert lo == pytest.approx(10.0, abs=0.02 * span)
    assert hi == pytest.approx(40.0, abs=0.02 * span)


def test_matches_the_extent_percentiles_exactly():
    # One definition of "robust" in the codebase — same constants as the extent
    # box, so the two can never drift into disagreeing about what a tail is.
    col = _clean()
    lo, hi = _robust_attribute_ranges(None, {"r": col})["r"]
    assert lo == pytest.approx(float(np.percentile(col, _EXTENT_LOW_PERCENTILE)))
    assert hi == pytest.approx(float(np.percentile(col, _EXTENT_HIGH_PERCENTILE)))


def test_covers_intensity_and_every_extra():
    out = _robust_attribute_ranges(_clean(), {"a": _clean(), "b": _clean()})
    assert set(out) == {"intensity", "a", "b"}


def test_omits_a_constant_column():
    # Degenerate: carries nothing the raw extrema don't, and a zero-width range
    # would make the consumer guard against a zero divisor. Absent ⇒ fall back.
    assert "flat" not in _robust_attribute_ranges(None, {"flat": np.full(500, 3.0)})


def test_omits_an_empty_or_all_nonfinite_column():
    out = _robust_attribute_ranges(
        None, {"empty": np.array([]), "nan": np.full(100, np.nan)}
    )
    assert out == {}


def test_ignores_nonfinite_values_but_keeps_the_column():
    col = np.concatenate([_clean(1_000), np.full(50, np.nan), np.full(50, np.inf)])
    lo, hi = _robust_attribute_ranges(None, {"r": col})["r"]
    assert np.isfinite(lo) and np.isfinite(hi)
    assert hi == pytest.approx(40.0, rel=0.02)


def test_includes_categorical_columns_on_purpose():
    # The backend CANNOT know a column is a class ID: that is the user's import-
    # wizard choice, held in the renderer's registries and changeable after
    # import. So report the percentile for everything and let the renderer gate.
    # (Trimming one of these would delete the rarest class from the palette —
    # see robustColorRange.ts, which is what actually prevents that.)
    classes = np.concatenate([np.zeros(9_000), np.ones(990), np.full(10, 2.0)])
    out = _robust_attribute_ranges(None, {"ground_class": classes})
    assert "ground_class" in out
    # And it really would have dropped class 2 — which is why the gate matters.
    assert out["ground_class"][1] < 2.0


def test_handles_a_none_extras_dict():
    assert _robust_attribute_ranges(None, None) == {}


def test_ignores_multidimensional_columns():
    # rgb-style (n,3) arrays have no single scalar domain; skip rather than
    # collapse them into a meaningless pair.
    assert _robust_attribute_ranges(None, {"rgb": np.zeros((100, 3))}) == {}
