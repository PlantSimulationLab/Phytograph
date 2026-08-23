"""The three latent miss-exclusion paths: spacing check, Helios ASCII/inline
triangulation input, and (renderer-side, pinned separately) parameter seeding.

Each was reachable but not currently firing, protected only by a coincidence of
the present UI. That is not a guarantee -- these endpoints take requests from any
client, and a refactor could remove the coincidence without touching this code.
"""
import os
import tempfile

import numpy as np
import pytest

import main


# ── /api/triangulate/check-spacing ─────────────────────────────────────────
#
# A miss is a ray that hit nothing, ~1 km out, so its nearest neighbour is
# another distant miss: misses do not merely widen the spacing distribution,
# they DEFINE it. Measured on a real vineyard scan the pooled median
# nearest-neighbour distance was 35.65 m with misses vs 0.0143 m without --
# a ~2,500x error, which inverts the bridging verdict this feeds.
#
# The caller crops to the grid first (`_points_inside_grid`), which removes
# misses incidentally, and today's renderer always sends a grid. But the
# endpoint's no-grid branch measures the WHOLE cloud with no protection at all.

class _Entry:
    """Minimal stand-in for a scan entry (only the fields the resolver reads)."""
    def __init__(self, **kw):
        self.session_id = None
        self.points = None
        self.file_path = None
        self.ascii_format = None
        self.origin = None
        for k, v in kw.items():
            setattr(self, k, v)


def _hits_and_shell(n_hits=400, n_miss=600, seed=0):
    rng = np.random.default_rng(seed)
    hits = rng.uniform(-5.0, 5.0, (n_hits, 3))
    dirs = rng.normal(size=(n_miss, 3))
    dirs /= np.linalg.norm(dirs, axis=1, keepdims=True)
    return hits, dirs * rng.uniform(900.0, 1100.0, (n_miss, 1))


def test_spacing_resolver_drops_the_shell_on_the_inline_branch():
    hits, misses = _hits_and_shell()
    out = main._resolve_scan_positions(
        _Entry(points=np.vstack([hits, misses]).tolist()))

    assert len(out) == len(hits)
    assert np.abs(out).max() < 50.0


def test_the_shell_would_have_inflated_the_measured_spacing():
    """Guard the premise: if misses were harmless the fix would be pointless."""
    from scipy.spatial import cKDTree

    hits, misses = _hits_and_shell()
    def median_nn(a):
        d, _ = cKDTree(a).query(a, k=2, workers=-1)
        nn = d[:, 1]
        return float(np.median(nn[np.isfinite(nn) & (nn > 0)]))

    assert median_nn(np.vstack([hits, misses])) > 20.0 * median_nn(hits)


def test_spacing_resolver_uses_the_files_own_miss_column():
    """The file-path branch already surfaces miss flags for LAD's sake; the
    spacing check wants the opposite half of them."""
    src = open(main.__file__, encoding="utf-8").read()
    start = src.index("def _resolve_scan_positions")
    block = src[start:start + 3000]
    # All three branches guarded: session extras, inline geometric, file flags.
    assert "_MISS_SLUG" in block
    assert "_drop_far_outliers(" in block
    assert "flags" in block and "_file_to_lad_arrays" in block


# ── Helios triangulation: the ASCII file-path twin ─────────────────────────
#
# The BINARY sub-branch decodes via `_read_points_from_source` and drops misses
# with an explanatory comment. The ASCII `else` beside it did neither: it fed
# `_file_xyz_bounds` (which streams every row) and handed the raw file to
# Helios. This app exports `is_miss` as a first-class ASCII column, so an
# exported-then-reimported scan carries the shell in plain text.

def _ascii_scan(tmpdir, fmt, n=100):
    """A scan file with alternating hit/miss rows and multi-return columns."""
    path = os.path.join(tmpdir, "scan.xyz")
    with open(path, "w") as f:
        f.write("# exported by Phytograph\n")
        for i in range(n):
            miss = 1 if i % 2 else 0
            v = 1000.0 if miss else i * 0.01
            f.write(f"{v} {v} {v} 0 1 {i * 0.001} {miss}\n")
    return path


def test_ascii_hits_only_copy_drops_misses_and_shrinks_the_bbox():
    fmt = "x y z target_index target_count timestamp is_miss"
    with tempfile.TemporaryDirectory() as d:
        path = _ascii_scan(d, fmt)
        out, out_fmt, n, lo, hi = main._ascii_hits_only_copy(path, fmt, d, 0)

        assert n == 50                       # half the rows were misses
        assert max(hi) < 10.0                # not the 1000 m shell
        assert out != path                   # a filtered copy, not the original
        assert out_fmt == fmt                # format string preserved verbatim


def test_ascii_hits_only_copy_preserves_every_column():
    """Decoding to bare x/y/z would silently drop the multi-return columns the
    reconstruction consumes -- so the filter must be row-wise, not a re-encode."""
    fmt = "x y z target_index target_count timestamp is_miss"
    with tempfile.TemporaryDirectory() as d:
        path = _ascii_scan(d, fmt)
        out, _, _, _, _ = main._ascii_hits_only_copy(path, fmt, d, 0)
        first = open(out).readline().split()
        assert len(first) == 7, f"columns lost: {first}"
        assert first[-1] == "0"              # and every surviving row is a hit


def test_ascii_file_without_a_miss_column_is_passed_through_untouched():
    """No is_miss declared means nothing to filter; don't pay a rewrite for it."""
    with tempfile.TemporaryDirectory() as d:
        path = _ascii_scan(d, "x y z target_index target_count timestamp is_miss")
        out, _, n, _, _ = main._ascii_hits_only_copy(path, "x y z", d, 1)
        assert out == path
        assert n == 100


def test_ascii_file_of_only_misses_errors_legibly():
    with tempfile.TemporaryDirectory() as d:
        path = os.path.join(d, "allmiss.xyz")
        with open(path, "w") as f:
            for i in range(20):
                f.write(f"1000 1000 1000 0 1 {i * 0.001} 1\n")
        with pytest.raises(ValueError, match="no hit points"):
            main._ascii_hits_only_copy(
                path, "x y z target_index target_count timestamp is_miss", d, 0)


def test_helios_ascii_and_inline_branches_are_guarded():
    """Pin both call sites inside the triangulation input assembly."""
    src = open(main.__file__, encoding="utf-8").read()
    start = src.index("Points mode (fallback): write inline points to a temp file")
    inline_block = src[start:start + 1200]
    assert "_drop_far_outliers(" in inline_block, "inline points mode lost its guard"

    # The ASCII sibling of the binary branch must route through the filter.
    assert "_ascii_hits_only_copy(fp, fmt, tmpdir, idx)" in src
