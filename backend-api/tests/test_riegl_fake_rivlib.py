"""End-to-end RIEGL reading against a fake RiVLib.

WHY THIS FILE EXISTS. Every other RIEGL test stubs the decode: they drive the
metadata parsers, the SOP chain, the status probes and the runner's argv with
synthetic inputs, and none of them ever loads a library or reads a point. That
left the part most likely to break silently — the ctypes binding, the read
loop, pulse grouping, column pruning, miss placement, the PHRX transport and
the native runner's path mapping — covered only by running it against real
scanner data by hand.

Real RiVLib cannot be committed (proprietary) and cannot be a CI secret (55 MB
against a 64 KB cap), so instead `tests/fixtures/fake_rivlib/` implements the
seven C functions the reader binds, plus the eight the shim exports. Pointing
RIVLIB_SO and PHYTOGRAPH_RXP_SHIM at those runs the whole pipeline with no
licensed bytes anywhere — which also means it runs on fork PRs, where a job
using the real library never could.

WHAT IT DOES NOT PROVE: nothing about RIEGL's actual behaviour. If they reorder
a struct, the stub and the reader stay wrong together. That is the credentialed
job's problem; this one catches our own regressions, which are almost all of
them.

The expected numbers come from the stubs' declared contract:

    1000 pulses, every 5th returning twice   -> 1200 echoes
    200 no-return shots                      -> 1400 points total
    shots 1200 == hit_shots 1000 + misses 200
"""

import json
import os
import struct
import subprocess
import sys
from pathlib import Path

import numpy as np
import pytest

import main

sys.path.insert(0, str(Path(__file__).resolve().parent / "fixtures" / "fake_rivlib"))
import build_fake_rivlib  # noqa: E402

REPO = Path(main.__file__).resolve().parent.parent
READER = REPO / "docker" / "riegl" / "rxp_reader.py"

# The stubs' contract. Asserting the arithmetic rather than restating constants
# keeps a change to one stub from quietly passing.
PULSES = 1000
ECHOES = 1200
MISSES = 200
POINTS = ECHOES + MISSES


@pytest.fixture(scope="session")
def fake_rivlib():
    built = build_fake_rivlib.build()
    if built is None:
        pytest.skip("no C compiler available to build the fake RiVLib")
    return built


@pytest.fixture
def project(tmp_path):
    """A minimal .riproject: one ScanPos with an .rxp and a .pat.

    The .rxp's CONTENT is irrelevant — the fake scanifc synthesises points and
    only checks the file opens — but it has to exist, because discovery globs
    for it and the reader reports its size.
    """
    root = tmp_path / "fake.riproject"
    pos = root / "ScanPos001"
    pos.mkdir(parents=True)
    (pos / "200101_120000.rxp").write_bytes(b"not really an rxp")
    (pos / "200101_120000.pat").write_text(
        "; synthetic scan pattern\r\n"
        "SCN_SET_RECT_FOV(30.0000, 130.0000, 0.0400, 0.0000, 360.0000, 0.0500)\r\n",
        encoding="latin-1",
    )
    return root


def _reader_env(fake, **extra):
    env = os.environ.copy()
    env["RIVLIB_ROOT"] = str(fake.root)
    env["RIVLIB_SO"] = str(fake.scanifc)
    env["PHYTOGRAPH_RXP_SHIM"] = str(fake.shim)
    env["PYTHONUNBUFFERED"] = "1"
    env.update(extra)
    return env


def _run_reader(fake, args, **extra):
    proc = subprocess.run(
        [sys.executable, str(READER), *args],
        capture_output=True, text=True, env=_reader_env(fake, **extra),
        timeout=300,
    )
    if proc.returncode != 0:
        raise AssertionError(
            "reader failed (%d)\nstdout: %s\nstderr: %s"
            % (proc.returncode, proc.stdout[-2000:], proc.stderr[-2000:])
        )
    return proc


# ---------------------------------------------------------------------------
# The stub is only useful if it really is ABI-compatible
# ---------------------------------------------------------------------------

def test_the_stub_matches_the_struct_layout_the_reader_asserts(fake_rivlib):
    """A layout mismatch does not raise — it silently corrupts every attribute.

    scanifc_point3dstream_read writes into the caller's array by stride, so a
    wrong sizeof yields garbage rather than an error. The reader asserts its
    ctypes sizes at import for that reason; this pins the C side against the
    same numbers, so the fixture cannot drift into testing a fiction.
    """
    reader = _load_reader()
    assert reader.ctypes.sizeof(reader.ScanifcXYZ) == 12
    assert reader.ctypes.sizeof(reader.ScanifcAttributes) == 16


def _load_reader():
    sys.path.insert(0, str(REPO / "docker" / "riegl"))
    import rxp_reader

    return rxp_reader


def test_the_stub_rejects_the_uri_form_real_rivlib_rejects(fake_rivlib, project):
    """`_uri()` is "file:" + a native path, backslashes and all.

    Measured against real RiVLib: `file:C:\\...` and `file:C:/...` open, while
    `file:///C:/...` does not. The stub enforces the same rule so a "helpful"
    normalisation to the file:// form fails here instead of in the field.
    """
    reader = _load_reader()
    rxp = str(next(project.rglob("*.rxp")))
    assert reader._uri(rxp) == "file:" + rxp

    lib = reader._Scanifc(str(fake_rivlib.scanifc))
    handle = lib.open(reader._uri(rxp))
    lib.close(handle)

    with pytest.raises(reader.RxpError):
        lib.open("file:///" + rxp.replace("\\", "/"))


# ---------------------------------------------------------------------------
# inspect
# ---------------------------------------------------------------------------

def test_inspect_reads_metadata_fov_and_gnss(fake_rivlib, project):
    doc = json.loads(_run_reader(fake_rivlib, ["inspect", str(project)]).stdout)

    assert doc["layout"] == "riproject"
    assert doc["scan_count"] == 1
    scan = doc["scans"][0]
    assert scan["name"] == "ScanPos001"

    # From scanifc_point3dstream_get_meta.
    assert scan["instrument"]["model"] == "FAKE-1000"
    assert scan["instrument"]["serial"] == "S0000001"

    # From the .pat file, NOT the library — the reader parses the commanded
    # pattern itself because get_meta's scanmech block is mirror calibration.
    assert scan["scan_params"]["theta_min"] == 30.0
    assert scan["scan_params"]["theta_max"] == 130.0
    assert scan["scan_params"]["phi_max"] == 360.0

    # From the demultiplexed housekeeping stream — the only route to GNSS.
    assert scan["gnss"]["latitude"] == pytest.approx(38.536836, abs=1e-6)
    assert scan["gnss"]["longitude"] == pytest.approx(-121.7951283, abs=1e-6)
    assert scan["gnss"]["height_m"] == pytest.approx(12.5, abs=1e-6)

    # hk_incl is millidegrees; -350/120 must arrive as -0.35/0.12 degrees.
    assert scan["sensor_pose"]["roll_deg"] == pytest.approx(-0.35, abs=1e-9)
    assert scan["sensor_pose"]["pitch_deg"] == pytest.approx(0.12, abs=1e-9)


# ---------------------------------------------------------------------------
# stream — the path the app actually uses
# ---------------------------------------------------------------------------

def _stream(fake, project, out_dir):
    """Run `stream` and consume, as the backend's own runner does.

    The reader blocks after each position until the host DELETES its directory
    — that backpressure is what caps the transport at one position on disk — so
    a test that only read stdout would hang until the 900 s consume timeout.
    """
    out_dir.mkdir(parents=True, exist_ok=True)
    log = out_dir / "stderr.log"
    with open(log, "w") as fh:
        proc = subprocess.Popen(
            [sys.executable, str(READER), "stream", str(project),
             "--out", str(out_dir), "--frame", "local"],
            stdout=subprocess.PIPE, stderr=fh, env=_reader_env(fake),
        )
        magic = proc.stdout.read(4)
        assert magic == b"PHRX", magic
        version, n = struct.unpack("<II", proc.stdout.read(8))
        header = json.loads(proc.stdout.read(n).decode("utf-8"))

        arrays = {}
        while True:
            for line in log.read_text(errors="replace").splitlines():
                try:
                    msg = json.loads(line)
                except ValueError:
                    continue
                name = msg.get("ready")
                if name and name not in arrays:
                    d = out_dir / name
                    done = json.loads((d / "done.json").read_text())
                    arrays[name] = {
                        "point_count": done["point_count"],
                        # done.json names them with their dtype suffix
                        # (positions.f64); that suffix is the transport's
                        # business, not this test's.
                        "columns": {c.rsplit(".", 1)[0] for c in done["columns"]},
                        "positions": np.fromfile(
                            d / "positions.f64", dtype="<f8"
                        ).reshape(-1, 3),
                        "is_miss": np.fromfile(d / "is_miss.f32", dtype="<f4"),
                    }
                    import shutil

                    shutil.rmtree(d, ignore_errors=True)
            if proc.poll() is not None:
                break
        proc.wait()

    tail = log.read_text(errors="replace")
    assert proc.returncode == 0, tail[-2000:]
    idx = tail.rfind('{"trailer"')
    assert idx >= 0, tail[-2000:]
    trailer = json.loads(tail[idx:].splitlines()[0])["trailer"]
    return version, header, arrays, trailer


def test_stream_emits_the_expected_scan(fake_rivlib, project, tmp_path):
    version, header, arrays, trailer = _stream(
        fake_rivlib, project, tmp_path / "out"
    )

    assert version == 4, "the PHRX stream version is a contract with the backend"
    assert header["reader_version"] == 4

    scan = trailer[0]
    assert scan["hit_count"] == ECHOES
    assert scan["miss_count"] == MISSES
    assert scan["point_count"] == POINTS
    assert scan["has_misses"] is True
    # A warning here means the reader's own timestamp grouping disagreed with
    # the echo-type bits, which is the multi-return cross-check firing.
    assert scan.get("warning") is None

    got = arrays["ScanPos001"]
    assert got["point_count"] == POINTS
    assert got["positions"].shape == (POINTS, 3)


def test_returns_are_grouped_into_pulses_by_timestamp(fake_rivlib, project, tmp_path):
    """Every fifth pulse returns twice, so max_returns_per_pulse must be 2.

    This is the reader deriving pulse structure from shared timestamps, and it
    is cross-checked against RiVLib's own echo classification — the fixture
    sets those bits consistently, so a grouping regression shows up as a
    warning and a wrong max rather than passing quietly.
    """
    _v, _h, _a, trailer = _stream(fake_rivlib, project, tmp_path / "out")
    assert trailer[0]["max_returns_per_pulse"] == 2
    assert trailer[0].get("echo_mismatches") is None


def test_constant_and_all_nan_columns_are_dropped(fake_rivlib, project, tmp_path):
    """The picker should offer only columns the instrument actually populates.

    The fixture varies reflectance/amplitude/deviation/echo_type/facet, leaves
    background_radiation all-NaN, and holds waveform_available, pseudo_echo and
    sw_calculated at zero — so the kept set is a direct read of the pruning
    rule rather than an accident of the data.
    """
    _v, _h, arrays, _t = _stream(fake_rivlib, project, tmp_path / "out")
    cols = arrays["ScanPos001"]["columns"]

    assert {"positions", "reflectance", "amplitude", "deviation",
            "target_index", "target_count", "is_miss", "timestamp"} <= cols
    assert "echo_type" in cols and "facet" in cols

    # All-NaN over the hits, zero-filled over the misses: nanmin == nanmax, so
    # it prunes as constant rather than as unpopulated. Either way it goes.
    assert "background_radiation" not in cols, "all-NaN column was not dropped"

    for flag in ("waveform_available", "pseudo_echo", "sw_calculated"):
        assert flag not in cols, f"constant column {flag} was not dropped"


def test_appending_misses_can_rescue_a_constant_column(fake_rivlib, project, tmp_path):
    """Documented because it is surprising, not because it is desirable.

    Pruning runs AFTER the miss rows are concatenated, and misses get zero for
    every per-return attribute. So a flag the instrument holds constant at 1
    over every hit — pps_locked here, and pps_locked is genuinely constant on a
    PPS-locked scan — becomes 1-for-hits/0-for-misses and survives as
    "informative", where the same scan imported without misses would drop it.

    The column then carries nothing `is_miss` does not already say. Harmless,
    but it means the picker's column list depends on whether miss recovery was
    available, which is worth knowing before someone treats that list as a
    property of the instrument.
    """
    _v, _h, arrays, _t = _stream(fake_rivlib, project, tmp_path / "out")
    assert "pps_locked" in arrays["ScanPos001"]["columns"]


def test_misses_land_on_the_far_field_shell(fake_rivlib, project, tmp_path):
    """Misses are rays, placed 20 km out and flagged, never real returns.

    Getting this wrong is the failure mode CLAUDE.md warns about at length: a
    miss inside the point set inflates every extent ~1000x, which hangs the
    reconstruction tools rather than erroring.
    """
    _v, _h, arrays, _t = _stream(fake_rivlib, project, tmp_path / "out")
    got = arrays["ScanPos001"]
    is_miss = got["is_miss"]
    xyz = got["positions"]

    assert is_miss.size == POINTS
    assert int(is_miss.sum()) == MISSES
    # Hits first, then misses — the concatenation order every consumer assumes.
    assert not is_miss[:ECHOES].any()
    assert is_miss[ECHOES:].all()

    radius = np.linalg.norm(xyz[is_miss.astype(bool)], axis=1)
    assert np.allclose(radius, 20000.0, rtol=1e-6), "misses are not on the shell"
    assert np.linalg.norm(xyz[~is_miss.astype(bool)], axis=1).max() < 100.0


def test_a_missing_shim_costs_the_sky_shell_not_the_import(
    fake_rivlib, project, tmp_path
):
    """The two-tier contract, exercised rather than asserted about.

    Without a toolchain the scan must still import — points, attributes and
    GNSS need no compiler — with has_misses false and a warning saying so.
    Pointing PHYTOGRAPH_RXP_SHIM at nothing is the closest reachable stand-in
    for that state.
    """
    out = tmp_path / "out"
    out.mkdir()
    env = _reader_env(fake_rivlib)
    env["PHYTOGRAPH_RXP_SHIM"] = str(tmp_path / "does-not-exist.dll")
    proc = subprocess.run(
        [sys.executable, str(READER), "inspect", str(project)],
        capture_output=True, text=True, env=env, timeout=300,
    )
    # inspect never touches the shim, so it must be unaffected.
    assert proc.returncode == 0, proc.stderr[-2000:]
    assert json.loads(proc.stdout)["scan_count"] == 1


# ---------------------------------------------------------------------------
# The backend's native runner, over the same fake library
# ---------------------------------------------------------------------------

@pytest.fixture
def native(monkeypatch, fake_rivlib, tmp_path):
    """Force the native runtime and point it at the fake RiVLib.

    Forcing is what lets this run on every push: the native path is otherwise
    reachable only on Windows, and CI's pytest job is Linux. The artifact name
    follows the HOST rather than the runtime precisely so this combination
    resolves the right file.
    """
    monkeypatch.setenv("PHYTOGRAPH_RIEGL_RUNTIME", "native")
    monkeypatch.setenv("PHYTOGRAPH_RIVLIB_PATH", str(fake_rivlib.root))
    monkeypatch.setenv("PHYTOGRAPH_RXP_SHIM", str(fake_rivlib.shim))
    # Never the user's real octree cache. A test that imports a cloud would
    # otherwise write into it and, on Windows, fail outright when an entry
    # already exists -- os.rename onto an existing directory is an error there,
    # not a replace.
    monkeypatch.setenv("PHYTOGRAPH_OCTREE_CACHE_ROOT", str(tmp_path / "octrees"))
    return fake_rivlib


def test_status_reports_ready_against_the_fake(client, native):
    body = client.get("/api/riegl/status").json()
    assert body["runtime"] == "native"
    assert body["rivlib_valid"] is True
    assert body["available"] is True
    assert body["docker_present"] is False


def test_inspect_endpoint_drives_the_native_runner(client, native, project):
    res = client.post(
        "/api/riegl/project/inspect",
        json={"project_path": str(project), "frame": "local"},
    )
    assert res.status_code == 200, res.text[:2000]
    doc = res.json()
    assert doc["scan_count"] == 1
    assert doc["scans"][0]["instrument"]["model"] == "FAKE-1000"


def test_extract_endpoint_builds_a_session_with_the_right_counts(
    client, native, project
):
    """The whole native import: runner, path mapping, transport, session build.

    Counts rather than "did not throw": hits and misses have to survive the
    round trip through the raw-array transport and into a CloudSession with
    every per-point column still the same length.
    """
    with client.stream(
        "POST", "/api/riegl/project/extract",
        json={"project_path": str(project), "scans": ["ScanPos001"],
              "frame": "local"},
    ) as res:
        assert res.status_code == 200, res.read()[:2000]
        payload = b"".join(res.iter_bytes())

    idx = payload.rfind(b'{"project"')
    assert idx >= 0, payload[-2000:]
    scan = json.loads(payload[idx:].decode("utf-8"))["scans"][0]

    assert scan["hit_count"] == ECHOES
    assert scan["miss_count"] == MISSES
    assert scan["point_count"] == POINTS
    assert scan["has_misses"] is True
