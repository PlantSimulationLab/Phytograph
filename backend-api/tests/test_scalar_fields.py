"""Unit tests for backend-api/scalar_fields.py — the pure expression/stats layer.

Endpoint-level behaviour (session mutation, octree rebuild, miss masking against
a real CloudSession) lives in test_scalar_field_endpoints.py.
"""

import math

import numpy as np
import pytest

import scalar_fields as sf


@pytest.fixture
def cols():
    return {
        "intensity": np.array([1.0, 2.0, 3.0, 4.0, 100.0], dtype=np.float32),
        "z": np.array([0.0, 1.0, 2.0, 3.0, 4.0], dtype=np.float32),
        "curvature": np.array([0.01, 0.05, 0.2, 0.4, 0.02], dtype=np.float32),
    }


def ev(expr, cols, mask=None):
    parsed = sf.parse(expr, available=cols)
    return sf.evaluate(parsed, cols, mask=mask)


# ── Arithmetic correctness, against a hand-computed numpy oracle ─────────────

def test_elementwise_arithmetic(cols):
    values, _ = ev("intensity * 2 + 1", cols)
    np.testing.assert_allclose(values, cols["intensity"] * 2 + 1, rtol=1e-6)


def test_operator_precedence_follows_python(cols):
    values, _ = ev("1 + z * 2 ** 2", cols)
    np.testing.assert_allclose(values, 1 + cols["z"] * 4, rtol=1e-6)


def test_two_columns(cols):
    values, _ = ev("intensity / (z + 1)", cols)
    np.testing.assert_allclose(
        values, cols["intensity"] / (cols["z"] + 1), rtol=1e-6)


def test_trig_round_trip(cols):
    values, _ = ev("degrees(atan2(z, 1))", cols)
    np.testing.assert_allclose(
        values, np.degrees(np.arctan2(cols["z"], 1)), rtol=1e-5)


def test_constants_available(cols):
    values, _ = ev("pi", cols)
    assert np.allclose(values, math.pi)


def test_ifelse_builds_a_class_column(cols):
    values, _ = ev("ifelse(curvature > 0.1, 1, 2)", cols)
    np.testing.assert_array_equal(values, [2, 2, 1, 1, 2])


def test_python_ternary_is_equivalent_to_ifelse(cols):
    a, _ = ev("ifelse(curvature > 0.1, 1, 2)", cols)
    b, _ = ev("1 if curvature > 0.1 else 2", cols)
    np.testing.assert_array_equal(a, b)


def test_chained_comparison_folds_to_and(cols):
    values, _ = ev("0 < z < 3", cols)
    np.testing.assert_array_equal(values, [0, 1, 1, 0, 0])


def test_boolean_operators(cols):
    values, _ = ev("z > 1 and z < 4", cols)
    np.testing.assert_array_equal(values, [0, 0, 1, 1, 0])


def test_a_field_may_share_a_name_with_a_function():
    """A column called `sqrt` is legal, and does not break calls to sqrt().

    Nothing stops an ASCII header naming a column `mean` or `sqrt`, and in
    `sqrt + sqrt(z)` the same spelling is a field reference AND a call target.
    Resolving call targets by NAME rather than by node identity dropped the bare
    reference and rejected the expression as "Unknown name 'sqrt'" — naming the
    one field the cloud demonstrably has.
    """
    cols = {"sqrt": np.array([4.0, 9.0, 16.0], dtype=np.float32),
            "mean": np.array([1.0, 2.0, 3.0], dtype=np.float32),
            "z": np.array([1.0, 2.0, 3.0], dtype=np.float32)}
    both, _ = ev("sqrt + sqrt(z)", cols)
    np.testing.assert_allclose(both, cols["sqrt"] + np.sqrt(cols["z"]), rtol=1e-6)
    # Same for an aggregate name used as both a field and an aggregate.
    mixed, _ = ev("mean + mean(z)", cols)
    np.testing.assert_allclose(mixed, cols["mean"] + 2.0, rtol=1e-6)
    # And the degenerate case: aggregating the field that shares the name.
    agg, _ = ev("mean(mean)", cols)
    assert np.allclose(agg, 2.0)


def test_min_max_arity_overload(cols):
    """One argument is the whole-field aggregate, two is elementwise."""
    agg, _ = ev("min(intensity)", cols)
    assert np.allclose(agg, 1.0)              # every row gets the scalar
    elem, _ = ev("min(intensity, z)", cols)
    np.testing.assert_allclose(elem, np.minimum(cols["intensity"], cols["z"]))


# ── Two-pass aggregates ─────────────────────────────────────────────────────

def test_zscore_normalizes(cols):
    """The canonical two-pass case: result has mean 0 and std 1 by construction."""
    values, meta = ev("(intensity - mean(intensity)) / std(intensity)", cols)
    assert values.mean() == pytest.approx(0.0, abs=1e-5)
    assert values.std() == pytest.approx(1.0, abs=1e-5)
    assert meta["aggregates"]["__agg_mean_intensity"] == pytest.approx(22.0)


def test_percentile_aggregate(cols):
    values, _ = ev("percentile(intensity, 50)", cols)
    assert np.allclose(values, 3.0)


def test_aggregate_honours_the_mask(cols):
    """An aggregate is measured over the masked rows only.

    This is what keeps `mean(intensity)` equal to the mean the Stats tab shows,
    rather than one polluted by deleted rows or by sky returns 1 km out.
    """
    mask = np.array([True, True, True, True, False])     # drop the 100 outlier
    values, meta = ev("mean(intensity)", cols, mask=mask)
    assert meta["aggregates"]["__agg_mean_intensity"] == pytest.approx(2.5)
    assert np.allclose(values, 2.5)


def test_aggregate_ignores_non_finite(cols):
    cols["withnan"] = np.array([1.0, 2.0, np.nan, 3.0, np.inf], dtype=np.float32)
    _, meta = ev("mean(withnan)", cols)
    assert meta["aggregates"]["__agg_mean_withnan"] == pytest.approx(2.0)


def test_aggregate_over_all_nan_column_is_an_error(cols):
    cols["allnan"] = np.full(5, np.nan, dtype=np.float32)
    with pytest.raises(sf.ExpressionError):
        ev("mean(allnan)", cols)


# ── Non-finite results are reported, not raised ─────────────────────────────

def test_division_by_zero_yields_inf_and_is_counted(cols):
    values, meta = ev("1 / (z - 1)", cols)
    assert meta["inf_count"] == 1
    assert np.isinf(values[1])
    # The other rows are still correct — one bad row must not fail the field.
    assert values[0] == pytest.approx(-1.0)


def test_log_of_negative_yields_nan_and_is_counted(cols):
    values, meta = ev("log(z - 2)", cols)
    assert meta["nan_count"] == 2
    assert np.isnan(values[0])


# ── Chunking ────────────────────────────────────────────────────────────────

def test_chunked_evaluation_matches_unchunked():
    """A tiny chunk size must not change the answer."""
    n = 10_000
    cols = {"a": np.linspace(0, 100, n).astype(np.float32),
            "b": np.linspace(5, 50, n).astype(np.float32)}
    expr = "(a - mean(a)) / std(a) + sqrt(b)"
    parsed = sf.parse(expr, available=cols)
    whole, _ = sf.evaluate(parsed, cols, chunk_rows=n * 2)
    tiny, _ = sf.evaluate(parsed, cols, chunk_rows=97)
    np.testing.assert_allclose(whole, tiny, rtol=1e-6)


def test_a_constant_expression_needs_an_explicit_row_count(cols):
    """`pi * 2` references no column, so the row count must be supplied.

    Seeding a column with a constant (before hand-editing it, say) is a real
    use, and the grammar accepts it. Inferring the length from the referenced
    columns made it fail while `mean(z) * 0 + 1` succeeded — the aggregate pulls
    `z` into the column set — which reads as arbitrary.
    """
    parsed = sf.parse("pi * 2", available=cols)
    assert parsed.columns_needed == set()
    values, _ = sf.evaluate(parsed, {}, n_points=5)
    assert values.shape == (5,)
    assert np.allclose(values, math.pi * 2)

    # And without a row count there is genuinely nothing to size against, so it
    # says that rather than reporting an internal-sounding failure.
    with pytest.raises(sf.ExpressionError) as exc:
        sf.evaluate(parsed, {})
    assert "references no field" in exc.value.message


def test_result_is_full_length_float32(cols):
    values, _ = ev("z * 2", cols)
    assert values.dtype == np.float32
    assert values.shape == (5,)


# ── Rejections ──────────────────────────────────────────────────────────────

@pytest.mark.parametrize("expr", [
    '__import__("os").system("x")',
    "intensity.__class__",
    "().__class__.__bases__[0].__subclasses__()",
    "[x for x in range(10)]",
    "{k: 1 for k in range(3)}",
    "lambda: 1",
    "(y := 5)",
    "intensity[0]",
    'open("/etc/passwd")',
    'exec("1")',
    'eval("1")',
    "globals()",
    'f"{intensity}"',
])
def test_dangerous_expressions_are_rejected(expr, cols):
    """The whitelist refuses everything outside the arithmetic grammar.

    These are the shapes every published 'sandboxed eval' escape walks, which is
    why the module parses to an AST and whitelists node types instead.
    """
    with pytest.raises(sf.ExpressionError):
        sf.parse(expr, available=cols)


@pytest.mark.parametrize("expr,fragment", [
    ("unknown_field * 2", "Unknown field"),
    ("nosuchfunc(intensity)", "Unknown function"),
    ("intensity *", "Could not parse"),
    ("sqrt(intensity, 2)", "takes 1 argument"),
    ("atan2(z)", "takes 2 arguments"),
    ("percentile(intensity)", "field and a number"),
    ("percentile(intensity, 150)", "between 0 and 100"),
    ("mean(nosuch)", "must be given a field name"),
    ("", "Enter an expression"),
])
def test_error_messages_are_specific(expr, fragment, cols):
    with pytest.raises(sf.ExpressionError) as exc:
        sf.parse(expr, available=cols)
    assert fragment in exc.value.message


def test_error_carries_a_column_offset(cols):
    """The panel underlines the offending token, so the offset must be real."""
    with pytest.raises(sf.ExpressionError) as exc:
        sf.parse("intensity + bogus", available=cols)
    assert exc.value.col == len("intensity + ")


def test_parse_does_not_evaluate(cols):
    """parse() is called on every keystroke, so it must not touch the data."""
    huge = {"a": np.zeros(1, dtype=np.float32)}
    parsed = sf.parse("a / 0", available=huge)   # would be inf if evaluated
    assert parsed.variables == {"a"}


# ── Slug validation ─────────────────────────────────────────────────────────

def test_valid_slugs_pass():
    for slug in ("ndvi", "my_field", "_x", "a1", "A" * sf.MAX_SLUG_LEN):
        assert sf.validate_slug(slug) == slug


@pytest.mark.parametrize("slug,fragment", [
    ("", "empty"),
    ("1abc", "start with a letter"),
    ("has space", "letters, digits and underscores"),
    ("has-dash", "letters, digits and underscores"),
    ("a" * (sf.MAX_SLUG_LEN + 1), "limit is"),
])
def test_malformed_slugs_are_rejected(slug, fragment):
    with pytest.raises(sf.SlugError) as exc:
        sf.validate_slug(slug)
    assert fragment in str(exc.value)


def test_existing_slug_is_rejected():
    with pytest.raises(sf.SlugError) as exc:
        sf.validate_slug("intensity", existing=["intensity", "z"])
    assert "already has a field" in str(exc.value)


def test_reserved_slug_is_rejected():
    with pytest.raises(sf.SlugError) as exc:
        sf.validate_slug("is_miss", reserved=["is_miss"])
    assert "reserved" in str(exc.value)


def test_canonical_alias_is_rejected():
    """A field named `time` would be re-resolved to `timestamp` on re-import."""
    with pytest.raises(sf.SlugError) as exc:
        sf.validate_slug("time", aliases=["time", "elevation"])
    assert "collide on export" in str(exc.value)


# ── describe() ──────────────────────────────────────────────────────────────

def test_describe_matches_numpy():
    rng = np.random.default_rng(0)
    v = rng.normal(10.0, 2.0, 50_000)
    d = sf.describe(v)
    assert d["mean"] == pytest.approx(float(np.mean(v)))
    assert d["std"] == pytest.approx(float(np.std(v)))
    assert d["median"] == pytest.approx(float(np.median(v)))
    assert d["min"] == pytest.approx(float(np.min(v)))
    assert d["max"] == pytest.approx(float(np.max(v)))
    assert d["p25"] == pytest.approx(float(np.percentile(v, 25)))
    assert d["p95"] == pytest.approx(float(np.percentile(v, 95)))


def test_describe_excludes_non_finite_from_statistics():
    v = np.array([1.0, 2.0, np.nan, np.inf, -np.inf, 3.0])
    d = sf.describe(v)
    assert d["count"] == 6
    assert d["finite_count"] == 3
    assert d["nan_count"] == 1
    assert d["inf_count"] == 2
    assert d["mean"] == pytest.approx(2.0)      # NOT nan


def test_histogram_bins_over_percentiles_not_extrema():
    """One spike must not put every real value in bin 0.

    Same reasoning as `_robust_attribute_ranges` in main.py: a domain set by its
    most extreme value washes out the structure the user is trying to read.
    """
    rng = np.random.default_rng(1)
    v = np.concatenate([rng.normal(10.0, 2.0, 10_000), [1e6]])
    d = sf.describe(v)
    edges = d["histogram"]["bin_edges"]
    assert edges[-1] < 100, "histogram span was dragged out by the outlier"
    assert d["histogram"]["above_count"] >= 1, "the outlier must still be counted"
    assert d["max"] == pytest.approx(1e6), "raw max is still reported"


def test_histogram_counts_sum_to_the_inside_population():
    rng = np.random.default_rng(2)
    v = rng.normal(0.0, 1.0, 20_000)
    h = sf.describe(v)["histogram"]
    total = sum(h["counts"]) + h["below_count"] + h["above_count"]
    assert total == v.size


def test_histogram_bin_count_is_bounded():
    rng = np.random.default_rng(3)
    for n in (50, 5_000, 500_000):
        h = sf.describe(rng.normal(0, 1, n))["histogram"]
        assert sf.MIN_BINS <= len(h["counts"]) <= sf.MAX_BINS


def test_zero_iqr_falls_back_to_sturges():
    """A mostly-constant column has a zero IQR, which divides by zero in FD."""
    v = np.concatenate([np.zeros(9_000), np.linspace(0.0, 1.0, 1_000)])
    h = sf.describe(v)["histogram"]
    assert sf.MIN_BINS <= len(h["counts"]) <= sf.MAX_BINS


def test_constant_column_is_degenerate_not_a_crash():
    d = sf.describe(np.full(1_000, 7.0))
    assert d["min"] == d["max"] == 7.0
    assert d["std"] == 0.0
    assert d["histogram"]["degenerate"] is True


def test_empty_and_all_nan_columns():
    assert sf.describe(np.array([])) == {}
    d = sf.describe(np.full(10, np.nan))
    assert d["finite_count"] == 0
    assert "mean" not in d          # no NaN statistics leak to the UI


def test_explicit_bin_count_is_honoured_within_bounds():
    rng = np.random.default_rng(4)
    h = sf.describe(rng.normal(0, 1, 10_000), bins=32)["histogram"]
    assert len(h["counts"]) == 32
