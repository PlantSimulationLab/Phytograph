"""What a .riproject import is allowed to DECODE, and what it must not write.

The cost of every housekeeping read in this module is the demultiplexer, not
the points: `HK_SELECTOR_ALL` emits ~44 bytes of ASCII per echo, so the price
of reaching `hk_gps_hr` and `scanner_pose_hr` scales linearly with the prefix
decoded and with nothing else. Measured on the 19-position Vacaville
.riproject, that is the difference between a 0.59 s project preview and a 9.9 s
one, and between an 11.1 s scan decode and a 28.6 s one.

Two regressions are pinned here because both are INVISIBLE in output — the
arrays, the GNSS fix and the pose are byte-identical whether or not the work
happens, so nothing but a clock or a disk-usage graph would ever notice:

  * `stream_scan` attaching a demultiplexer. It is the only full-length decode
    in the module, and it had one, writing 747 MB of ASCII per VZ-1000 position
    to record what `cmd_stream`'s pass 1 had already harvested from a bounded
    probe and which nothing read back. 61% of the decode, for a file that was
    then abandoned in %TEMP% — one five-position import left 3.8 GB there.

  * `read_scan` overshooting `max_points`. RiVLib returns a whole batch or
    nothing, so a buffer sized at the full `_READ_CHUNK` silently rounded the
    bound UP to the next multiple of it: a 250k probe decoded 400k points, and
    the ladder's 5k first rung would have decoded 200k — i.e. the ladder would
    have LOOKED right and bought nothing.

These are pure-function tests against a stub. The real ctypes binding, read
loop and pulse grouping are exercised end to end by test_riegl_fake_rivlib.py.
"""

import ast
import inspect
import sys
import textwrap
from pathlib import Path

import pytest

READER_DIR = Path(__file__).resolve().parents[2] / "docker" / "riegl"
if str(READER_DIR) not in sys.path:
    sys.path.insert(0, str(READER_DIR))

import rxp_reader as R  # noqa: E402


# Verbatim from a VZ-1000 capture (Vacaville ScanPos001, first 5,000 points),
# because the field ORDER is what parse_hk_gps and parse_scanner_pose_hr key
# off: a hand-written row with the right shape and the wrong offsets would pass
# while proving nothing. parse_hk_gps reads longitude/latitude/height from
# fields 5/6/7 of hk_gps_hr; parse_scanner_pose_hr wants twelve finite ones.
_GPS = (
    "hk_gps_hr (10020.0), 500685000, -2634459410, -4233758350, 3963578520, "
    "2570, -121891971100, 38667504900, 22422, 50199, 1581, 2026, 3, 221, 0, "
    "15, 41379014, 131, 10, 189, 94, 133, 95, 164, 0, 0, 0, 686408, 41379014, "
    "43, 41567491, 4034822143\n"
)
_POSE_OK = (
    "scanner_pose_hr (72.0), 3.8667501832006906e+01, -1.2189197118335748e+02, "
    "2.1880380630493164e+01, 4.9657379150390625e+01, -1.6212306022644043e+00, "
    "2.4072171747684479e-01, -7.9339141845703125e+01, 1.6019999980926514e+00, "
    "2.0369999408721924e+00, 1.0e-01, 1.0e-01, 5.0e+00\n"
)
# The hazard parse_scanner_pose_hr exists to survive, also verbatim: on this
# instrument the FIRST pose row is routinely all-NaN, written before the fix
# resolves. A position that emits ONLY these has no fused pose at any prefix
# length, so the probe must keep climbing.
_POSE_NAN = "scanner_pose_hr (72.0)" + ", nan" * 12 + "\n"


class _StubIfc:
    """Enough of _Scanifc for read_scan, recording what it was asked to decode.

    `rungs` is the points decoded per open, so a test can assert on the exact
    number of points rather than on elapsed time — which is only a proxy for
    it, and the thing CI cannot measure.
    """

    def __init__(self, hk_lines: str, echoes: int = 10_000_000):
        self.hk_lines = hk_lines
        self.echoes = echoes
        self.opens: list = []
        self.rungs: list = []
        self.wants: list = []
        self.lib = self
        self._left = 0

    def open(self, uri, hk_path=None, selector=None):
        self.opens.append((hk_path, selector))
        self.rungs.append(0)
        self._left = self.echoes
        if hk_path is not None:
            # Stand in for the demultiplexer: the records are there from the
            # first read, which is what the real one does on measured data.
            Path(hk_path).write_text(self.hk_lines, encoding="latin-1")
        return object()

    def meta(self, handle):
        return {}

    def close(self, handle):
        pass

    def scanifc_point3dstream_read(self, handle, want, xyz, attr, times, got, eof):
        self.wants.append(want)
        n = min(want, self._left)
        self._left -= n
        self.rungs[-1] += n
        got._obj.value = n
        eof._obj.value = 0
        return 0


# ---------------------------------------------------------------------------
# read_scan honours its bound exactly
# ---------------------------------------------------------------------------


@pytest.mark.parametrize("bound", [1, 5_000, 250_000, 200_001])
def test_read_scan_decodes_exactly_its_bound(tmp_path, bound):
    ifc = _StubIfc(_GPS + _POSE_OK)
    R.read_scan(
        ifc, "s.rxp", str(tmp_path / "hk.txt"),
        count_points=False, max_points=bound,
    )
    assert ifc.rungs == [bound]
    assert max(ifc.wants) <= R._READ_CHUNK


def test_an_unbounded_read_still_uses_the_full_chunk(tmp_path):
    """The bound is what shrinks the buffer; a full decode must not be slowed."""
    ifc = _StubIfc(_GPS + _POSE_OK, echoes=R._READ_CHUNK * 3)
    R.read_scan(ifc, "s.rxp", str(tmp_path / "hk.txt"), count_points=False)
    assert ifc.wants[0] == R._READ_CHUNK


# ---------------------------------------------------------------------------
# probe_scan climbs only as far as it has to
# ---------------------------------------------------------------------------


def test_probe_stops_at_the_first_rung_that_yields_both_records(tmp_path):
    ifc = _StubIfc(_GPS + _POSE_OK)
    R.probe_scan(
        ifc, "s.rxp", str(tmp_path / "hk.txt"), ceiling=R._ANCHOR_PROBE_POINTS
    )
    assert ifc.rungs == [R._PROBE_LADDER[0]]


def test_probe_climbs_to_the_ceiling_when_no_fused_pose_ever_resolves(tmp_path):
    """The margin the flat read bought is still there for the case that needs it.

    A position emitting only NaN pose rows (4 of 8 in one real project) must end
    up having decoded exactly what it decoded before the ladder existed — that
    is what keeps the hk_incl fallback's averaging window unchanged.
    """
    ifc = _StubIfc(_GPS + _POSE_NAN)
    R.probe_scan(
        ifc, "s.rxp", str(tmp_path / "hk.txt"), ceiling=R._ANCHOR_PROBE_POINTS
    )
    # Rungs do not compose — each re-opens and decodes from the start — so the
    # deepest single prefix is the ceiling, and nothing read past it.
    assert ifc.rungs == list(R._PROBE_LADDER) + [R._ANCHOR_PROBE_POINTS]


def test_probe_climbs_when_the_receiver_never_locked(tmp_path):
    """No fix is not a reason to stop early either — it is a reason to try more."""
    ifc = _StubIfc(_POSE_OK)
    R.probe_scan(ifc, "s.rxp", str(tmp_path / "hk.txt"), ceiling=50_000)
    assert ifc.rungs[-1] == 50_000


def test_an_inclinometer_fallback_does_not_end_the_climb(tmp_path):
    """hk_incl is an AVERAGE over the records in the file, so accepting it early
    would shrink its window — the one way a shorter probe could change an answer
    rather than just reach it sooner."""
    ifc = _StubIfc(_GPS + "hk_incl (10006.0), -1617, 254, 504, 505\n")
    R.probe_scan(
        ifc, "s.rxp", str(tmp_path / "hk.txt"), ceiling=R._ANCHOR_PROBE_POINTS
    )
    assert ifc.rungs == list(R._PROBE_LADDER) + [R._ANCHOR_PROBE_POINTS]


def test_a_ceiling_below_the_ladder_is_honoured(tmp_path):
    """--probe-points must be able to ask for LESS than the first rung."""
    ifc = _StubIfc(_POSE_NAN)
    R.probe_scan(ifc, "s.rxp", str(tmp_path / "hk.txt"), ceiling=1_000)
    assert ifc.rungs == [1_000]


def test_the_worst_case_climb_still_decodes_less_than_the_flat_read_did(tmp_path):
    """No position gets slower. The flat 250k bound overshot to 400k because of
    the chunk rounding above; the whole ladder is 305k."""
    ifc = _StubIfc(_GPS + _POSE_NAN)
    R.probe_scan(
        ifc, "s.rxp", str(tmp_path / "hk.txt"), ceiling=R._ANCHOR_PROBE_POINTS
    )
    overshot = -(-R._ANCHOR_PROBE_POINTS // R._READ_CHUNK) * R._READ_CHUNK
    assert sum(ifc.rungs) < overshot


# ---------------------------------------------------------------------------
# The full-length decode writes no sidecar, and probes clean up after themselves
# ---------------------------------------------------------------------------


def test_stream_scan_takes_no_hk_path_and_attaches_no_demultiplexer():
    """Byte-identical output, 2.6x the wall time. The only way to notice this
    regressing is to look for it, so look for it."""
    assert "hk_path" not in inspect.signature(R.stream_scan).parameters

    source = textwrap.dedent(inspect.getsource(R.stream_scan))
    opens = [
        node
        for node in ast.walk(ast.parse(source))
        if isinstance(node, ast.Call)
        and isinstance(node.func, ast.Attribute)
        and node.func.attr == "open"
    ]
    assert opens, "stream_scan no longer opens a point stream — update this test"
    for call in opens:
        kwargs = {kw.arg: kw.value for kw in call.keywords}
        assert "selector" not in kwargs
        assert isinstance(kwargs.get("hk_path"), ast.Constant)
        assert kwargs["hk_path"].value is None


def test_every_site_that_names_an_hk_file_also_discards_it():
    """The names are fixed per position in the system temp directory, so a site
    that forgets leaves its file there for good — silently, and at up to 747 MB
    a position."""
    tree = ast.parse(Path(R.__file__).read_text(encoding="utf-8"))
    offenders = []
    for fn in ast.walk(tree):
        if not isinstance(fn, (ast.FunctionDef, ast.AsyncFunctionDef)):
            continue
        # An f-string opening with "hk_" is how every one of these paths is
        # built. Matching the bare literal instead would also catch the record
        # PARSERS, which name records like "hk_gps_hr" and own no file.
        if not any(
            isinstance(node, ast.JoinedStr)
            and node.values
            and isinstance(node.values[0], ast.Constant)
            and str(node.values[0].value).startswith("hk_")
            for node in ast.walk(fn)
        ):
            continue
        if "discard_hk" not in ast.dump(fn):
            offenders.append(fn.name)
    assert offenders == [], (
        f"{offenders} build an hk file path but never call discard_hk()"
    )


def test_discard_keeps_the_file_when_a_directory_was_named(tmp_path):
    """--hk-dir exists so a human can go and read the records afterwards."""
    kept = tmp_path / "kept.txt"
    kept.write_text("x")
    R.discard_hk(str(kept), keep=True)
    assert kept.is_file()

    gone = tmp_path / "gone.txt"
    gone.write_text("x")
    R.discard_hk(str(gone), keep=False)
    assert not gone.exists()

    # A probe that failed before the demultiplexer wrote anything leaves no
    # file, which is not a problem worth reporting.
    R.discard_hk(str(tmp_path / "never-existed.txt"), keep=False)
