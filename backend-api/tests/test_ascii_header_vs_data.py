"""Tests for telling an ASCII header row apart from a row of DATA.

Four helpers ask this same question — `_detect_ascii_delimiter`,
`_ascii_skiprows`, `_first_data_row_has_letters`, `_read_ascii_header_names`,
plus the sampling loop in `_autodetect_xyz_columns`. Each used to ask it as
"does the row contain a letter", which is wrong in a way that costs both
correctness and a minute of wall clock:

  - `1.234e+05`, `nan`, `inf` are letter-bearing VALUES that `float()` accepts.
    Classified as a header, the first real point is fed to pandas `skiprows` and
    silently disappears — no error, just one fewer point.
  - Worse, two of those loops applied the skip to EVERY row, not just the first,
    so a file whose data rows all contain letters was walked end to end and then
    answered wrong: `_detect_ascii_delimiter` returned None (falling back to
    whitespace, silently wrong for a comma file) and `_autodetect_xyz_columns`
    returned a bare x/y/z that discards the file's real colour/intensity
    columns. On a 223 MB `%e` file that scan cost 18.4 s versus 0.05 s for the
    same data written as plain decimals, and it runs twice per preview, on a
    request the wizard fires in parallel for every file in an import batch.

The test bar is behavioural: the delimiter, the skiprows count, the recovered
header names and the detected roles, over the delimiter/header shapes the
importer actually meets — plus an explicit bound on how much of a large file the
sniff is allowed to touch.
"""

from pathlib import Path

import pytest

import main


# (filename, contents, expected delimiter, expected skiprows, expected header names)
#
# The `sci`/`nan`/`inf` rows are the regression cases: letter-bearing data with
# NO header, which must report skiprows=0 and header=None so the first point
# survives. Everything else pins the pre-existing behaviour that must not move.
CASES = [
    ("ws_header.xyz", "x y z\n1.0 2.0 3.0\n4.0 5.0 6.0\n",
     "whitespace", 1, ["x", "y", "z"]),
    ("ws_plain.xyz", "1.0 2.0 3.0\n4.0 5.0 6.0\n",
     "whitespace", 0, None),
    ("ws_sci.xyz", "1.234e+05 2.5e+06 12.5\n1.235e+05 2.5e+06 12.6\n",
     "whitespace", 0, None),
    ("ws_nan.xyz", "1.0 2.0 nan\n3.0 4.0 5.0\n",
     "whitespace", 0, None),
    ("ws_inf.xyz", "1.0 2.0 -inf\n3.0 4.0 5.0\n",
     "whitespace", 0, None),
    ("comma_header.csv", "x,y,z\n1.0,2.0,3.0\n",
     "comma", 1, ["x", "y", "z"]),
    ("comma_plain.csv", "1.0,2.0,3.0\n4.0,5.0,6.0\n",
     "comma", 0, None),
    ("comma_sci.csv", "1.234e+05,2.5e+06,12.5\n1.235e+05,2.5e+06,12.6\n",
     "comma", 0, None),
    # CloudCompare's '//'-commented legend: pandas keeps the line, so it needs an
    # explicit skiprows of 1.
    ("cc_header.csv", "//X,Y,Z\n1.0,2.0,3.0\n",
     "comma", 1, ["X", "Y", "Z"]),
    # A '#'-commented legend is dropped by pandas's comment='#', so skiprows
    # stays 0 while the names are still recovered for display.
    ("hash_header.xyz", "# x y z\n1.0 2.0 3.0\n",
     "whitespace", 0, ["x", "y", "z"]),
    ("tab_header.tsv", "x\ty\tz\n1.0\t2.0\t3.0\n",
     "tab", 1, ["x", "y", "z"]),
    ("semi.csv", "1.0;2.0;3.0\n4.0;5.0;6.0\n",
     "semicolon", 0, None),
]


@pytest.fixture
def write(tmp_path):
    def _write(name: str, text: str) -> str:
        p = tmp_path / name
        p.write_text(text)
        return str(p)
    return _write


@pytest.mark.parametrize("name,text,delim,skip,header", CASES,
                         ids=[c[0] for c in CASES])
def test_header_vs_data_classification(write, name, text, delim, skip, header):
    p = write(name, text)
    assert main._detect_ascii_delimiter(p) == delim
    assert main._ascii_skiprows(p) == skip
    assert main._read_ascii_header_names(p) == header


def test_pts_count_line_still_skipped(write):
    """A bare integer count line is data-shaped but must still be skipped.

    It parses as a number, so the numeric test alone would keep it; `.pts`
    detection is what catches it. Pinned here because the header rewrite is
    exactly the kind of change that could drop it.
    """
    p = write("count.pts", "3\n1.0 2.0 3.0\n4.0 5.0 6.0\n7.0 8.0 9.0\n")
    assert main._ascii_skiprows(p) == 1


def test_scientific_notation_keeps_every_point(write):
    """The first `%e` data row must survive import, not be eaten as a header."""
    p = write("sci.xyz", "1.0e+00 2.0e+00 3.0e+00\n"
                         "4.0e+00 5.0e+00 6.0e+00\n"
                         "7.0e+00 8.0e+00 9.0e+00\n")
    positions, _, _ = main._load_xyz_arrays(p, None)
    assert len(positions) == 3, "first scientific-notation row was dropped"
    assert positions[0].tolist() == [1.0, 2.0, 3.0]


def test_letter_bearing_data_does_not_defeat_column_autodetect(write):
    """Colour/intensity columns must survive a `%e` first row.

    `_autodetect_xyz_columns` skipped every letter-bearing row, so its sample
    came back empty and it fell through to a bare x/y/z — silently discarding
    the r/g/b and intensity columns the file actually carries.
    """
    # Column 0 carries decimals, so the leading-integer-index heuristic (which
    # steps past a `row col` prefix) correctly leaves xyz at position 0.
    p = write("sci_rgb.xyz",
              "1.5e+00 2.5e+00 3.5e+00 10 20 30 0.5\n"
              "4.5e+00 5.5e+00 6.5e+00 40 50 60 0.6\n")
    roles = main._autodetect_xyz_columns(p)
    assert roles[:3] == ["x", "y", "z"]
    assert "r255" in roles and "intensity" in roles, roles


def test_sniff_reads_a_bounded_prefix_of_a_large_file(write, tmp_path):
    """The sniff must not scale with file size.

    This is the wall-clock half of the bug: an unbounded scan over a file whose
    rows all contain letters. Asserting on BYTES READ rather than elapsed time
    keeps the test deterministic on a loaded machine.
    """
    p = tmp_path / "big_sci.xyz"
    with open(p, "w") as f:
        for i in range(400_000):
            f.write(f"{i:.6e} {i:.6e} {i:.6e}\n")
    size = p.stat().st_size
    assert size > 10_000_000, "fixture too small to be meaningful"

    import builtins
    total = {"n": 0}
    real_open = builtins.open

    class Counting:
        def __init__(self, f):
            self.f = f

        def __iter__(self):
            for line in self.f:
                total["n"] += len(line)
                yield line

        def read(self, *a):
            d = self.f.read(*a)
            total["n"] += len(d)
            return d

        def __getattr__(self, n):
            return getattr(self.f, n)

        def __enter__(self):
            self.f.__enter__()
            return self

        def __exit__(self, *a):
            return self.f.__exit__(*a)

    builtins.open = lambda *a, **k: Counting(real_open(*a, **k))
    try:
        assert main._detect_ascii_delimiter(str(p)) == "whitespace"
        assert main._autodetect_xyz_columns(str(p))[:3] == ["x", "y", "z"]
    finally:
        builtins.open = real_open

    # Generous bound: the helpers need a few hundred lines at most. The bug read
    # all ~24 MB, so anything near the file size fails loudly.
    assert total["n"] < size / 100, (
        f"sniff read {total['n']} bytes of a {size}-byte file — "
        "it is scanning far more than a prefix"
    )
