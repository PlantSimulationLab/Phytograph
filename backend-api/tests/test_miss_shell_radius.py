"""The miss shell's radius: one scalar, and what it is allowed to allocate.

`_gather_miss_positions` places the sky/miss halo at 1.4x the farthest HIT
distance from the scanner. Finding that distance used to be

    np.max(np.linalg.norm(positions[hits] - origin, axis=1))

which materialises the whole hit selection and then three more arrays the same
size — the broadcast subtraction, norm's internal square, and the reduced
column. On the reference VZ-1000 position's 18.6 M hits that is 1,636 MB of
transient to produce ONE NUMBER, on top of a session already holding ~1.4 GB of
the same cloud. `_farthest_from_origin` walks it in blocks instead: 142 MB, and
marginally quicker besides.

The result must not move, so most of this file is equivalence. Two traps are
pinned specifically because both are invisible in ordinary use:

  * `np.einsum("ij,ij->i", d, d)` looks like the natural way to write a squared
    length and is NOT interchangeable here — it takes a different summation
    path and disagreed with `np.linalg.norm` in 42 of 400 random trials.
    `(d*d).sum(axis=1)` is the arithmetic norm itself does, and matched in
    400 of 400.
  * Comparing squares and taking the root once is only safe because sqrt is
    monotonic. A block boundary falling mid-cloud must not change the answer.
"""

import sys
from pathlib import Path

import numpy as np
import pytest

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

import main  # noqa: E402
from main import _farthest_from_origin  # noqa: E402


def _reference(positions, mask, origin):
    """The expression this replaced, verbatim."""
    selected = np.ascontiguousarray(positions[mask], dtype=np.float64)
    return float(np.max(np.linalg.norm(selected - origin, axis=1)))


def _cloud(rng, n, *, hit_fraction=0.8, scale=12.0):
    positions = rng.normal(size=(n, 3)) * scale
    mask = rng.random(n) < hit_fraction
    if not mask.any():
        mask[0] = True
    return positions, mask


def test_matches_the_expression_it_replaced():
    rng = np.random.default_rng(2024)
    for _ in range(120):
        n = int(rng.integers(1, 120_000))
        positions, mask = _cloud(rng, n, hit_fraction=float(rng.uniform(0.02, 1.0)),
                                 scale=float(rng.uniform(1e-6, 1e6)))
        origin = rng.normal(size=3) * float(rng.uniform(0.0, 1e5))
        assert _farthest_from_origin(positions, mask, origin) == _reference(
            positions, mask, origin
        )


@pytest.mark.parametrize("block", [1, 2, 3, 7, 999, 10_000, 10**9])
def test_the_block_size_never_changes_the_answer(monkeypatch, block):
    """Including blocks of one row, and one block larger than the cloud."""
    rng = np.random.default_rng(11)
    positions, mask = _cloud(rng, 5_000)
    origin = np.array([1.5, -2.0, 0.25])
    monkeypatch.setattr(main, "_FAR_SCAN_BLOCK", block)
    assert _farthest_from_origin(positions, mask, origin) == _reference(
        positions, mask, origin
    )


def test_a_block_containing_no_hits_is_skipped_not_counted(monkeypatch):
    """A miss-only block must contribute nothing — not a zero that wins, and
    not an empty-array reduction that raises."""
    positions = np.array(
        [[100.0, 0.0, 0.0], [0.0, 0.0, 0.0], [0.0, 0.0, 0.0], [3.0, 4.0, 0.0]]
    )
    mask = np.array([True, False, False, True])
    monkeypatch.setattr(main, "_FAR_SCAN_BLOCK", 2)
    assert _farthest_from_origin(positions, mask, np.zeros(3)) == 100.0


def test_a_single_hit_far_out_still_sets_the_radius(monkeypatch):
    """The shell has to enclose the cloud, so the farthest return decides it —
    this is a max, deliberately, not a percentile like the robust extent."""
    rng = np.random.default_rng(3)
    positions, mask = _cloud(rng, 50_000, scale=5.0)
    positions[40_000] = [0.0, 0.0, 900.0]
    mask[40_000] = True
    monkeypatch.setattr(main, "_FAR_SCAN_BLOCK", 4_096)
    assert _farthest_from_origin(positions, mask, np.zeros(3)) == pytest.approx(900.0)


def test_the_origin_is_subtracted_not_assumed_to_be_zero():
    positions = np.array([[10.0, 0.0, 0.0], [-10.0, 0.0, 0.0]])
    mask = np.array([True, True])
    assert _farthest_from_origin(positions, mask, np.array([9.0, 0.0, 0.0])) == 19.0


def test_einsum_is_not_a_valid_substitute():
    """Pins the reason `(d*d).sum(axis=1)` is spelled out rather than written the
    tidy way. If numpy ever makes these agree, this test fails and the comment
    in `_farthest_from_origin` can be relaxed — which is the outcome worth being
    told about."""
    rng = np.random.default_rng(5)
    disagreements = 0
    for _ in range(200):
        n = int(rng.integers(2, 50_000))
        d = rng.normal(size=(n, 3)) * float(rng.uniform(1e-6, 1e6))
        by_norm = float(np.max(np.linalg.norm(d, axis=1)))
        by_einsum = float(np.sqrt(np.einsum("ij,ij->i", d, d).max()))
        by_mul = float(np.sqrt((d * d).sum(axis=1).max()))
        assert by_mul == by_norm
        disagreements += by_einsum != by_norm
    assert disagreements > 0, "einsum now agrees — see _farthest_from_origin"


def test_it_never_materialises_the_whole_selection(monkeypatch):
    """The point of the change. Measured as peak allocation, because that is the
    property — the old form's cost was memory, not time."""
    import tracemalloc

    rng = np.random.default_rng(7)
    n = 2_000_000
    positions, mask = _cloud(rng, n, hit_fraction=1.0)
    origin = np.zeros(3)
    monkeypatch.setattr(main, "_FAR_SCAN_BLOCK", 100_000)

    tracemalloc.start()
    _farthest_from_origin(positions, mask, origin)
    blocked_peak = tracemalloc.get_traced_memory()[1]
    tracemalloc.stop()

    tracemalloc.start()
    _reference(positions, mask, origin)
    reference_peak = tracemalloc.get_traced_memory()[1]
    tracemalloc.stop()

    selection_bytes = n * 3 * 8
    assert blocked_peak < selection_bytes / 4, (
        f"peaked at {blocked_peak / 1e6:.0f} MB for a "
        f"{selection_bytes / 1e6:.0f} MB selection"
    )
    assert reference_peak > blocked_peak * 4, (
        "the reference no longer costs what this optimisation was for"
    )


def test_the_session_lock_is_taken_per_block_not_across_the_scan():
    """Holding a global registry lock for the whole scan would stall every
    concurrent session request for ~0.9 s. The lock must be acquired inside the
    loop — the pattern `_session_to_las(block_lock=...)` already establishes."""
    import ast
    import inspect
    import textwrap

    fn = ast.parse(textwrap.dedent(inspect.getsource(main._farthest_from_origin)))
    loops = [n for n in ast.walk(fn) if isinstance(n, (ast.For, ast.While))]
    assert loops, "no loop — the scan is no longer blockwise"
    withs_in_loops = [
        w for loop in loops for w in ast.walk(loop) if isinstance(w, ast.With)
    ]
    assert withs_in_loops, "the session lock is not acquired inside the loop"
    # ...and not also wrapped around the whole thing.
    for node in fn.body[0].body:
        assert not isinstance(node, ast.With), (
            "the lock is held across the whole scan"
        )
