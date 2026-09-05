"""Tests for /api/riegl/status — the RIEGL .rxp capability report.

Reading RIEGL raw scanner data needs RIEGL's closed-source RiVLib, which has no
macOS build, so Phytograph runs it inside a linux/amd64 container. The feature
is therefore available only when three things hold at once: Docker is reachable,
the user has supplied their own RiVLib copy, and the image has been built from
it. RiVLib's licence forbids redistribution, so it can never be bundled — hence
a runtime probe rather than a build flag.

Every probe here is monkeypatched. These tests must not depend on whether the
machine running them happens to have Docker up or a RiVLib download present.
"""

import json
import math
import os
from pathlib import Path

import pytest
from fastapi import HTTPException

import main


def test_status_shape_and_invariants(client):
    res = client.get("/api/riegl/status")
    assert res.status_code == 200
    b = res.json()
    # Superset, so adding fields later doesn't break this test.
    assert set(b) >= {
        "available", "platform_supported", "docker_present", "image_built",
        "rivlib_path", "rivlib_valid", "image", "reason",
    }
    assert isinstance(b["available"], bool)
    assert isinstance(b["docker_present"], bool)
    assert isinstance(b["image_built"], bool)
    assert b["reason"]  # always explains the verdict
    # The one-way invariant: "available" is only ever reported when every
    # prerequisite actually holds. WHICH prerequisites depends on the runtime --
    # a native host reads RiVLib directly and has no Docker or image to require,
    # so asserting docker_present there would be asserting the old design
    # rather than the current one.
    if b["available"]:
        assert b["platform_supported"] is True
        assert b["rivlib_valid"] is True
        assert b["runtime"] in ("docker", "native")
        if b["runtime"] == "docker":
            assert b["docker_present"] is True
            assert b["image_built"] is True
            assert b["image_stale"] is False
        else:
            # Nothing to build and nothing to start: the reader ships inside the
            # backend bundle, so RiVLib alone decides.
            assert b["docker_present"] is False


def _elf(machine: int = 0x3E) -> bytes:
    """The smallest byte string that reads as a 64-bit ELF shared object.

    The status now checks that the library could plausibly LOAD, not merely
    that the filename is right — so an empty placeholder correctly reads as a
    download that did not finish. Fixtures that mean "a working RiVLib" have to
    look like one. 0x3E is EM_X86_64, which is what the linux/amd64 container
    needs whatever the host is.
    """
    buf = bytearray(20)
    buf[0:4] = b"ELF"
    buf[4] = 2  # 64-bit
    buf[5] = 1  # little-endian
    buf[16:18] = (3).to_bytes(2, "little")  # ET_DYN
    buf[18:20] = machine.to_bytes(2, "little")
    return bytes(buf)


def _mac(monkeypatch):
    import platform as _platform
    monkeypatch.setattr(_platform, "system", lambda: "Darwin")


def test_available_when_everything_is_present(client, monkeypatch, tmp_path):
    _mac(monkeypatch)
    monkeypatch.setattr(main, "_docker_present", lambda: True)
    monkeypatch.setattr(main, "_riegl_image_built", lambda: True)
    rivlib = tmp_path / "rivlib"
    (rivlib / "lib").mkdir(parents=True)
    (rivlib / "lib" / "libscanifc.so").write_bytes(_elf())

    b = client.get(
        "/api/riegl/status", params={"rivlib_path": str(rivlib)}
    ).json()
    assert b["available"] is True
    assert b["rivlib_valid"] is True
    assert "ready" in b["reason"].lower()


def test_unavailable_and_docker_not_probed_off_macos(client, monkeypatch):
    """Windows/Linux are out of scope in v1, and must not shell out to docker.

    The platform veto comes first so a machine without Docker doesn't pay a
    subprocess timeout just to be told the feature isn't offered.
    """
    import platform as _platform
    monkeypatch.setattr(_platform, "system", lambda: "Linux")

    called = []
    monkeypatch.setattr(
        main, "_docker_present", lambda: called.append(True) or True
    )

    b = client.get("/api/riegl/status").json()
    assert b["available"] is False
    assert b["platform_supported"] is False
    assert called == [], "docker must not be probed on an unsupported platform"
    assert "riscan" in b["reason"].lower() or "riprocess" in b["reason"].lower()


def test_unavailable_when_docker_is_down(client, monkeypatch, tmp_path):
    _mac(monkeypatch)
    monkeypatch.setattr(main, "_docker_present", lambda: False)
    rivlib = tmp_path / "rivlib"
    (rivlib / "lib").mkdir(parents=True)
    (rivlib / "lib" / "libscanifc.so").write_bytes(_elf())

    b = client.get(
        "/api/riegl/status", params={"rivlib_path": str(rivlib)}
    ).json()
    assert b["available"] is False
    assert b["docker_present"] is False
    # The image can't be inspected without a daemon, so it must not be claimed.
    assert b["image_built"] is False
    assert "docker" in b["reason"].lower()


def test_unavailable_when_rivlib_unconfigured(client, monkeypatch):
    _mac(monkeypatch)
    monkeypatch.setattr(main, "_docker_present", lambda: True)
    monkeypatch.setattr(main, "_riegl_image_built", lambda: True)
    monkeypatch.delenv("PHYTOGRAPH_RIVLIB_PATH", raising=False)

    b = client.get("/api/riegl/status").json()
    assert b["available"] is False
    assert b["rivlib_path"] is None
    assert "rivlib" in b["reason"].lower()


def test_unavailable_when_rivlib_path_lacks_the_library(
    client, monkeypatch, tmp_path
):
    """A directory that exists but isn't a RiVLib root is the likely mis-pick:
    the user selects lib/ itself, or an unextracted download."""
    _mac(monkeypatch)
    monkeypatch.setattr(main, "_docker_present", lambda: True)
    monkeypatch.setattr(main, "_riegl_image_built", lambda: True)
    empty = tmp_path / "not-rivlib"
    empty.mkdir()

    b = client.get(
        "/api/riegl/status", params={"rivlib_path": str(empty)}
    ).json()
    assert b["available"] is False
    assert b["rivlib_valid"] is False
    assert "libscanifc.so" in b["reason"]


def test_unavailable_when_image_not_built(client, monkeypatch, tmp_path):
    _mac(monkeypatch)
    monkeypatch.setattr(main, "_docker_present", lambda: True)
    monkeypatch.setattr(main, "_riegl_image_built", lambda: False)
    rivlib = tmp_path / "rivlib"
    (rivlib / "lib").mkdir(parents=True)
    (rivlib / "lib" / "libscanifc.so").write_bytes(_elf())

    b = client.get(
        "/api/riegl/status", params={"rivlib_path": str(rivlib)}
    ).json()
    assert b["available"] is False
    assert b["image_built"] is False
    assert "image" in b["reason"].lower()


def test_probe_failure_degrades_to_unavailable(client, monkeypatch):
    """A probe that raises must report "not available", never a 500."""
    _mac(monkeypatch)

    def boom():
        raise OSError("docker exploded")

    monkeypatch.setattr(main, "_docker_present", boom)
    res = client.get("/api/riegl/status")
    assert res.status_code == 200, "a failing probe is a normal state, not a 500"
    b = res.json()
    assert b["available"] is False
    assert b["docker_present"] is False
    assert b["reason"]


def test_resolve_runtime_raises_503_with_remediation(monkeypatch):
    """503 is the established status for an uninstalled optional capability,
    and the detail must carry the same actionable reason the status reports."""
    import fastapi
    _mac(monkeypatch)
    monkeypatch.setattr(main, "_docker_present", lambda: False)

    try:
        main._resolve_riegl_runtime()
    except fastapi.HTTPException as exc:
        assert exc.status_code == 503
        assert "docker" in str(exc.detail).lower()
    else:
        raise AssertionError("expected HTTPException")


def test_failure_states_stay_individually_distinguishable(
    client, monkeypatch, tmp_path
):
    """The UI must be able to tell WHICH prerequisite failed.

    `available` is one bit, so a wrong RiVLib folder and an unbuilt image would
    otherwise look identical to a user (both just "unavailable"). The three
    booleans are what the Settings checklist renders, so each must move
    independently of the others.
    """
    _mac(monkeypatch)
    good = _valid_rivlib(tmp_path)
    bad = tmp_path / "not-rivlib"
    bad.mkdir()

    def probe(docker, image, path):
        monkeypatch.setattr(main, "_docker_present", lambda: docker)
        monkeypatch.setattr(main, "_riegl_image_built", lambda: image)
        return client.get(
            "/api/riegl/status", params={"rivlib_path": str(path)}
        ).json()

    # Bad RiVLib, image present: rivlib is the ONLY failing flag.
    s = probe(True, True, bad)
    assert s["docker_present"] is True
    assert s["rivlib_valid"] is False
    assert s["image_built"] is True

    # Good RiVLib, image missing: image is the ONLY failing flag.
    s = probe(True, False, good)
    assert s["docker_present"] is True
    assert s["rivlib_valid"] is True
    assert s["image_built"] is False

    # Docker down: docker is the failing flag, and image can't be claimed.
    s = probe(False, True, good)
    assert s["docker_present"] is False
    assert s["image_built"] is False
    assert s["rivlib_valid"] is True

    # Each state must also carry a DIFFERENT reason, so the tooltip and the
    # checklist hint never say the same thing for different problems.
    reasons = {
        probe(True, True, bad)["reason"],
        probe(True, False, good)["reason"],
        probe(False, True, good)["reason"],
    }
    assert len(reasons) == 3, "each failure needs its own explanation"


def _valid_rivlib(tmp_path):
    rivlib = tmp_path / "rivlib"
    (rivlib / "lib").mkdir(parents=True)
    (rivlib / "lib" / "libscanifc.so").write_bytes(_elf())
    return rivlib


def test_build_refuses_without_a_usable_rivlib(client, monkeypatch):
    """Building without RiVLib would 'succeed' and still leave the feature
    unavailable, which reads as a broken build. Refuse with the reason."""
    _mac(monkeypatch)
    monkeypatch.setattr(main, "_docker_present", lambda: True)
    monkeypatch.setattr(main, "_riegl_image_built", lambda: False)
    monkeypatch.delenv("PHYTOGRAPH_RIVLIB_PATH", raising=False)

    called = []
    monkeypatch.setattr(
        main, "_run_docker_build",
        lambda *a, **k: called.append(True),
    )

    res = client.post("/api/riegl/image/build", json={})
    assert res.status_code == 503
    assert "rivlib" in res.json()["detail"].lower()
    assert called == [], "must not shell out to docker build"


def test_build_refuses_when_docker_is_down(client, monkeypatch, tmp_path):
    _mac(monkeypatch)
    monkeypatch.setattr(main, "_docker_present", lambda: False)
    called = []
    monkeypatch.setattr(
        main, "_run_docker_build", lambda *a, **k: called.append(True)
    )

    res = client.post(
        "/api/riegl/image/build",
        json={"rivlib_path": str(_valid_rivlib(tmp_path))},
    )
    assert res.status_code == 503
    assert "docker" in res.json()["detail"].lower()
    assert called == []


def test_build_invokes_docker_build_when_ready(client, monkeypatch, tmp_path):
    _mac(monkeypatch)
    monkeypatch.setattr(main, "_docker_present", lambda: True)
    monkeypatch.setattr(main, "_riegl_image_built", lambda: False)

    called = []
    monkeypatch.setattr(
        main, "_run_docker_build",
        lambda context, **kwargs: called.append(context),
    )

    res = client.post(
        "/api/riegl/image/build",
        json={"rivlib_path": str(_valid_rivlib(tmp_path))},
    )
    assert res.status_code == 200
    assert len(called) == 1
    # The build context must be the directory holding the Dockerfile.
    assert (called[0] / "Dockerfile").is_file()
    # The response streams PHP1 markers then a JSON tail.
    assert b'"ok"' in res.content


def test_docker_context_contains_the_reader(client):
    """The image is built from files that ship with the app, so both must be
    present — a missing rxp_reader.py would build an image that cannot read."""
    context = main._riegl_docker_context()
    assert (context / "Dockerfile").is_file()
    assert (context / "rxp_reader.py").is_file()


def test_extract_root_lives_outside_the_octree_cache(monkeypatch, tmp_path):
    """The extract root must not sit in — or beside — the octree cache.

    Regression test for real data loss: it was first placed as a sibling of the
    octree cache, which several independent agents sweep (backend eviction,
    launchApp teardown, resetToFreshScene), and a 759 MB extract vanished ~40 s
    after being written. The import no longer writes point files at all, but the
    root is still resolved (and pruned) so the isolation rule must hold.
    """
    monkeypatch.delenv("PHYTOGRAPH_RIEGL_EXTRACT_ROOT", raising=False)
    monkeypatch.setenv(
        "PHYTOGRAPH_OCTREE_CACHE_ROOT", str(tmp_path / "cache" / "octrees")
    )

    extracts = main._riegl_extract_dir().resolve()
    cache_root = main._octree_cache_root().resolve()

    assert cache_root not in extracts.parents, "extracts must not live inside the cache"
    assert extracts.parent != cache_root.parent, (
        "extracts must not be a SIBLING of the octree cache either — the cache "
        "directory is swept wholesale, taking siblings with it"
    )


def test_extract_prune_reclaims_old_runs(monkeypatch, tmp_path):
    """Directories left by older versions (which did write LAS) are reclaimed."""
    import time as _time

    monkeypatch.setenv("PHYTOGRAPH_RIEGL_EXTRACT_ROOT", str(tmp_path / "extracts"))
    root = main._riegl_extract_dir()

    fresh = root / "current_run"
    fresh.mkdir()
    stale = root / "old_run"
    stale.mkdir()
    old = _time.time() - (main._RIEGL_EXTRACT_MAX_AGE_S + 3600)
    os.utime(stale, (old, old))

    main._prune_riegl_extracts(keep=fresh)

    assert fresh.is_dir(), "an explicitly kept directory must survive"
    assert not stale.exists(), "a finished day-old extract should be reclaimed"


def test_inspect_rejects_a_file_masquerading_as_a_project(
    client, monkeypatch, tmp_path
):
    """A .riproject is a DIRECTORY of ScanPos* folders. The likely mis-pick is
    one of the .rxp files inside it, which must fail with that explanation
    rather than a container error."""
    _mac(monkeypatch)
    monkeypatch.setattr(main, "_docker_present", lambda: True)
    monkeypatch.setattr(main, "_riegl_image_built", lambda: True)
    a_file = tmp_path / "scan.rxp"
    a_file.write_bytes(b"")

    called = []
    monkeypatch.setattr(
        main, "_run_riegl_container", lambda *a, **k: called.append(True)
    )

    res = client.post(
        "/api/riegl/project/inspect",
        json={
            "project_path": str(a_file),
            "rivlib_path": str(_valid_rivlib(tmp_path)),
        },
    )
    assert res.status_code == 400
    assert "not a directory" in res.json()["detail"]
    assert called == [], "must not reach the container"


def test_inspect_503s_when_capability_unavailable(client, monkeypatch, tmp_path):
    """The extraction endpoints must gate on the same probe the badge reads, so
    the UI never shows 'ready' while an import 500s (or vice versa)."""
    _mac(monkeypatch)
    monkeypatch.setattr(main, "_docker_present", lambda: False)
    project = tmp_path / "p.riproject"
    project.mkdir()

    res = client.post(
        "/api/riegl/project/inspect", json={"project_path": str(project)}
    )
    assert res.status_code == 503
    assert "docker" in res.json()["detail"].lower()


def _plenty_of_disk(monkeypatch):
    """Neutralise the pre-flight free-space check.

    These tests are about mounts and session building, not capacity — without
    this they fail with 507 on any machine whose disk happens to be full, which
    is exactly the state that motivated the check.
    """
    import shutil as _shutil
    real = _shutil.disk_usage

    def fake(path):
        u = real("/")
        return type(u)(u.total, 0, 10 * 1024**3)

    monkeypatch.setattr(main.shutil, "disk_usage", fake)


def test_extract_mounts_only_the_transport_dir_writable(
    client, monkeypatch, tmp_path
):
    """Only the transport directory may be writable.

    The container writes raw arrays to a bind mount (~880 MB/s, against
    ~32 MB/s through a stdout pipe), so it needs one writable path — but the
    PROJECT must stay read-only. Irreplaceable field data must not be reachable
    for writing by a bug in the reader.
    """
    _mac(monkeypatch)
    monkeypatch.setattr(main, "_docker_present", lambda: True)
    monkeypatch.setattr(main, "_riegl_image_built", lambda: True)
    project = tmp_path / "p.riproject"
    project.mkdir()
    monkeypatch.setenv("PHYTOGRAPH_RIEGL_EXTRACT_ROOT", str(tmp_path / "extracts"))
    _plenty_of_disk(monkeypatch)

    seen = {}

    def fake_stream(args, mounts, out_dir, **kwargs):
        seen["args"] = args
        seen["mounts"] = mounts
        return ({"scans": [], "scan_count": 0}, [], [])

    monkeypatch.setattr(main, "_stream_riegl_container", fake_stream)

    res = client.post(
        "/api/riegl/project/extract",
        json={
            "project_path": str(project),
            "rivlib_path": str(_valid_rivlib(tmp_path)),
            "scans": ["ScanPos001", "ScanPos003"],
        },
    )
    assert res.status_code == 200

    modes = {container: mode for _host, container, mode in seen["mounts"]}
    assert modes["/project"] == "ro", "field data must never be writable"
    assert modes["/rivlib"] == "ro"
    assert modes["/out"] == "rw", "the transport dir is the one writable mount"
    assert [m for m in modes.values() if m != "ro"] == ["rw"], (
        "exactly one writable mount — the transport dir — and no more"
    )
    # The selection must reach the reader verbatim.
    assert seen["args"][:2] == ["stream", "/project"]
    assert "ScanPos001" in seen["args"] and "ScanPos003" in seen["args"]


def test_extract_builds_sessions_without_writing_any_file(
    client, monkeypatch, tmp_path
):
    """The import must write NO intermediate point file.

    Regression test for a round trip that cost ~10 s and ~1.6 GB per position:
    arrays were streamed into RAM, written to a LAS, then read straight back so
    the ordinary import path could consume them. CloudSession's source of truth
    IS arrays, so the file was pure overhead. The only file this import may
    write is PotreeConverter's octree input, inside a temp dir it deletes.
    """
    import numpy as np

    _mac(monkeypatch)
    monkeypatch.setattr(main, "_docker_present", lambda: True)
    monkeypatch.setattr(main, "_riegl_image_built", lambda: True)
    project = tmp_path / "p.riproject"
    project.mkdir()
    extracts = tmp_path / "extracts"
    monkeypatch.setenv("PHYTOGRAPH_RIEGL_EXTRACT_ROOT", str(extracts))
    _plenty_of_disk(monkeypatch)

    n = 5
    arrays = {
        "positions": np.arange(n * 3, dtype=np.float64).reshape(n, 3),
        "reflectance": np.full(n, -10.0, dtype=np.float32),
        "amplitude": np.full(n, 20.0, dtype=np.float32),
        "deviation": np.zeros(n, dtype=np.float32),
        "target_index": np.ones(n, dtype=np.float32),
        "target_count": np.ones(n, dtype=np.float32),
        "is_miss": np.zeros(n, dtype=np.float32),
    }

    # Drive the real callback path: the runner hands each scan to `on_scan` as
    # it arrives, which is what builds the session.
    def fake_stream(args, mounts, out_dir, *, on_scan=None, **kwargs):
        # Create real transport files, as the container would, so the cleanup
        # assertion below actually exercises the deletion path. Without this the
        # test passes even when cleanup is removed entirely.
        scan_dir = out_dir / "ScanPos001"
        scan_dir.mkdir(parents=True, exist_ok=True)
        # Sizes must match `point_count` or the truncation guard rejects them.
        np.zeros((n, 3), dtype="<f8").tofile(scan_dir / "positions.f64")
        cols = [
            "reflectance", "amplitude", "deviation",
            "target_index", "target_count", "is_miss",
        ]
        for col in cols:
            np.zeros(n, dtype="<f4").tofile(scan_dir / f"{col}.f32")
        np.zeros(n, dtype="<f8").tofile(scan_dir / "timestamp.f64")
        # The manifest names the columns actually written — the set varies by
        # scanner, so the host reads this rather than assuming a fixed list.
        (scan_dir / "done.json").write_text(json.dumps({
            "point_count": n,
            "columns": ["positions.f64"] + [f"{c}.f32" for c in cols]
                       + ["timestamp.f64"],
        }))
        header = {"scans": [{"name": "ScanPos001"}]}
        if on_scan is not None:
            # The real runner loads (and deletes) the directory before handing
            # arrays over; mirror that so the per-scan reclaim is covered too.
            main._load_riegl_scan_arrays(scan_dir)
            on_scan(0, header["scans"][0], arrays)
        return (header, [], [{"name": "ScanPos001", "point_count": n}])

    monkeypatch.setattr(main, "_stream_riegl_container", fake_stream)
    monkeypatch.setattr(
        main, "_do_create_cloud_session",
        lambda req, path, **kw: {"session_id": "abc123", "point_count": n},
    )

    res = client.post(
        "/api/riegl/project/extract",
        json={
            "project_path": str(project),
            "rivlib_path": str(_valid_rivlib(tmp_path)),
        },
    )
    assert res.status_code == 200
    tail = res.content[res.content.rfind(b'{"scans'):]
    payload = json.loads(tail)
    scan = payload["scans"][0]

    # A session, not a file path.
    assert scan["session"]["session_id"] == "abc123"
    assert "las_path" not in scan
    # And the trailer's point count was folded in.
    assert scan["point_count"] == n

    # The transport directory is reclaimed: its files are deleted as each
    # position loads, and the run's own directory goes at the end. At ~576 MB
    # per position, leaving them would put gigabytes on disk for data already
    # in RAM.
    written = list(extracts.rglob("*")) if extracts.exists() else []
    assert not [p for p in written if p.is_file()], (
        f"transport files were not reclaimed: {written}"
    )


def test_streamed_arrays_map_onto_session_inputs(monkeypatch):
    """The arrays adapter must preserve every attribute and the intensity map.

    Reflectance is dB relative to a white diffuse target and NEGATIVE for most
    natural surfaces, so `intensity` (the uint16 display channel) is rescaled
    over PDAL's -25..+5 dB window rather than cast — a cast collapses a real
    scan to all-black.
    """
    import numpy as np

    n = 4
    arrays = {
        "positions": np.zeros((n, 3), dtype=np.float64),
        "reflectance": np.array([-25.0, -10.0, 5.0, 50.0], dtype=np.float32),
        "amplitude": np.full(n, 20.0, dtype=np.float32),
        "deviation": np.zeros(n, dtype=np.float32),
        "target_index": np.array([1, 1, 2, 1], dtype=np.float32),
        "target_count": np.array([1, 2, 2, 1], dtype=np.float32),
        "is_miss": np.zeros(n, dtype=np.float32),
    }
    res = main._riegl_arrays_to_las_result(arrays)

    assert res.positions.shape == (n, 3)
    assert set(res.extras) == {
        "is_miss", "reflectance", "amplitude", "deviation",
        "target_index", "target_count",
    }
    # `is_miss` is carried through from the reader, not synthesised here — this
    # fixture happens to supply all-hits.
    assert float(res.extras["is_miss"].sum()) == 0.0
    # Multi-return columns survive verbatim — LAD reads these.
    assert res.extras["target_count"].tolist() == [1.0, 2.0, 2.0, 1.0]
    # Window endpoints map to the full uint16 range; above it clamps.
    assert res.intensity[0] == 0
    assert res.intensity[2] == 65535
    assert res.intensity[3] == 65535
    assert 0 < res.intensity[1] < 65535


def test_points_are_translated_into_the_project_frame():
    """Each position's POINTS must move to its GNSS origin, not just its marker.

    Regression test for a bug where scanner meshes were placed correctly at
    their GNSS-derived offsets while every cloud sat at 0,0,0 — points and
    marker disagreeing by the whole survey layout. RiVLib returns each position
    in its own scanner-local frame, and neither of the session's existing knobs
    can fix that: `origin` only projects sky/miss points onto the display shell,
    and `world_shift` is SUBTRACTED. The arrays are the only place to shift.
    """
    import numpy as np

    n = 100
    base = np.arange(n * 3, dtype=np.float64).reshape(n, 3)
    arrays = {
        "positions": base,
        "reflectance": np.zeros(n, dtype=np.float32),
        "amplitude": np.zeros(n, dtype=np.float32),
        "deviation": np.zeros(n, dtype=np.float32),
        "target_index": np.ones(n, dtype=np.float32),
        "target_count": np.ones(n, dtype=np.float32),
        "is_miss": np.zeros(n, dtype=np.float32),
    }
    o1 = [6.70, 0.76, -0.57]
    o2 = [-6.43, 0.26, -4.00]

    a = main._riegl_arrays_to_las_result(arrays, origin=o1).positions
    b = main._riegl_arrays_to_las_result(arrays, origin=o2).positions

    # Each cloud lands exactly at its own origin...
    assert np.allclose(a - base, o1)
    assert np.allclose(b - base, o2)
    # ...so two positions are separated by the distance between their scanners,
    # which is what makes the GNSS layout (and the ICP prior) meaningful.
    assert np.allclose(a - b, np.array(o1) - np.array(o2))

    # No origin (no GNSS fix) leaves the cloud in its scanner frame.
    assert np.array_equal(
        main._riegl_arrays_to_las_result(arrays).positions, base
    )
    # The caller's buffer is not mutated — the stream decoder still holds it.
    assert np.array_equal(arrays["positions"], base)


def test_misses_survive_the_origin_translation():
    """A recovered miss must stay on its own scanner's ray.

    Misses are placed at origin + unit_dir * 20000 m in the SCANNER frame, then
    the whole cloud is translated into the project frame by the GNSS offset.
    Both hits and misses ride in one array precisely so that translation cannot
    separate them — if a miss ever moved independently, its ray would no longer
    point back at the instrument and LAD's transmission term would be wrong.
    """
    import numpy as np

    n_hit, n_miss = 4, 3
    dirs = np.array([[0.0, 0.0, 1.0], [1.0, 0.0, 0.0], [0.0, 1.0, 0.0]])
    arrays = {
        "positions": np.vstack([np.zeros((n_hit, 3)), dirs * 20000.0]),
        "reflectance": np.zeros(n_hit + n_miss, dtype=np.float32),
        "amplitude": np.zeros(n_hit + n_miss, dtype=np.float32),
        "deviation": np.zeros(n_hit + n_miss, dtype=np.float32),
        "target_index": np.zeros(n_hit + n_miss, dtype=np.float32),
        "target_count": np.zeros(n_hit + n_miss, dtype=np.float32),
        "is_miss": np.concatenate([
            np.zeros(n_hit, dtype=np.float32),
            np.ones(n_miss, dtype=np.float32),
        ]),
    }
    origin = [10.0, 20.0, 30.0]
    res = main._riegl_arrays_to_las_result(arrays, origin=origin)

    m = res.extras["is_miss"] == 1
    assert int(m.sum()) == n_miss, "the miss flag must survive the adapter"
    # Hits land at the scanner; misses stay exactly 20 km along their ray.
    assert np.allclose(res.positions[~m], origin)
    assert np.allclose(
        np.linalg.norm(res.positions[m] - np.array(origin), axis=1), 20000.0
    )


def test_miss_flag_is_carried_not_synthesised():
    """`is_miss` must come from the reader, not be zeroed here.

    It used to be hardcoded to all-zeros because .rxp appeared to have no
    no-return shots. They are in fact recoverable through the C++ shim (~46% of
    shots on real data), so silently zeroing the column would throw away the
    entire transmission term LAD depends on.
    """
    import numpy as np

    n = 6
    flags = np.array([0, 0, 1, 0, 1, 1], dtype=np.float32)
    arrays = {
        "positions": np.zeros((n, 3)),
        "reflectance": np.zeros(n, dtype=np.float32),
        "amplitude": np.zeros(n, dtype=np.float32),
        "deviation": np.zeros(n, dtype=np.float32),
        "target_index": np.zeros(n, dtype=np.float32),
        "target_count": np.zeros(n, dtype=np.float32),
        "is_miss": flags,
    }
    res = main._riegl_arrays_to_las_result(arrays)
    assert np.array_equal(res.extras["is_miss"], flags)
    assert [d["slug"] for d in res.extra_dims_meta].count("is_miss") == 1


def test_wizard_selection_drops_unwanted_scalars():
    """The import wizard's column choice must actually filter the import.

    RIEGL bypassed the wizard entirely at first, so the scalar set was whatever
    the reader happened to forward — the user had no say, and several columns
    were silently dropped. Now the wizard lists them and this is what enforces
    the answer.
    """
    import numpy as np

    n = 4
    arrays = {
        "positions": np.zeros((n, 3)),
        "reflectance": np.ones(n, dtype=np.float32),
        "amplitude": np.ones(n, dtype=np.float32),
        "deviation": np.ones(n, dtype=np.float32),
        "target_index": np.ones(n, dtype=np.float32),
        "target_count": np.ones(n, dtype=np.float32),
        "is_miss": np.zeros(n, dtype=np.float32),
        "echo_type": np.ones(n, dtype=np.float32),
        "timestamp": np.arange(n, dtype=np.float64),
    }

    # Keep only reflectance; is_miss must survive regardless.
    res = main._riegl_arrays_to_las_result(arrays, keep_columns=["reflectance"])
    assert set(res.extras) == {"reflectance", "is_miss"}, (
        "is_miss is a system flag (Hit/Miss scheme, hits-only octree) and must "
        "never be dropped by a user selection"
    )
    # A column the user didn't keep must not appear in the octree sidecar either.
    assert [d["slug"] for d in res.extra_dims_meta] == ["reflectance", "is_miss"]
    # Timestamp lives outside `extras`, so it is filtered separately.
    assert res.timestamps is None

    # Keeping it explicitly brings it back.
    res2 = main._riegl_arrays_to_las_result(
        arrays, keep_columns=["reflectance", "timestamp"]
    )
    assert res2.timestamps is not None

    # No selection at all keeps everything the scanner recorded.
    res3 = main._riegl_arrays_to_las_result(arrays)
    assert "echo_type" in res3.extras
    assert res3.timestamps is not None


def test_extract_refuses_up_front_when_the_disk_is_full(
    client, monkeypatch, tmp_path
):
    """A full disk must fail BEFORE decoding, with an actionable message.

    Regression test for a real failure: the import ran for minutes, decoded four
    of six positions, then died mid-write with a numpy OSError buried in the
    reader's traceback ("Not enough free space to write 168330104 bytes").

    The transport needs ~1.6 GB per position. The container now blocks until the
    host has loaded and deleted each position before writing the next, so that
    is the peak (measured: 1.28 GB across a three-position import, against
    ~2.6 GB when the two were allowed to overlap on disk).
    """
    _mac(monkeypatch)
    monkeypatch.setattr(main, "_docker_present", lambda: True)
    monkeypatch.setattr(main, "_riegl_image_built", lambda: True)
    project = tmp_path / "p.riproject"
    project.mkdir()
    monkeypatch.setenv("PHYTOGRAPH_RIEGL_EXTRACT_ROOT", str(tmp_path / "extracts"))

    import shutil as _shutil
    real = _shutil.disk_usage
    monkeypatch.setattr(
        main.shutil, "disk_usage",
        lambda p: type(real("/"))(real("/").total, 0, 100 * 1024**2),  # 100 MB
    )
    reached = []
    monkeypatch.setattr(
        main, "_stream_riegl_container",
        lambda *a, **k: reached.append(True) or ({}, [], []),
    )

    res = client.post(
        "/api/riegl/project/extract",
        json={
            "project_path": str(project),
            "rivlib_path": str(_valid_rivlib(tmp_path)),
        },
    )
    assert res.status_code == 507
    detail = res.json()["detail"]
    assert "disk space" in detail.lower()
    # Both numbers, so the user can see how far short they are.
    assert "GB is needed" in detail and "GB is free" in detail
    assert reached == [], "must refuse before decoding anything"


def test_per_request_path_overrides_environment(client, monkeypatch, tmp_path):
    """The renderer owns this setting, so the request wins over the env var.

    The backend sidecar is spawned once at launch; if the env var won, changing
    the folder in Settings would need an app restart to take effect.
    """
    _mac(monkeypatch)
    monkeypatch.setattr(main, "_docker_present", lambda: True)
    monkeypatch.setattr(main, "_riegl_image_built", lambda: True)
    monkeypatch.setenv("PHYTOGRAPH_RIVLIB_PATH", "/stale/from/launch")
    rivlib = tmp_path / "rivlib"
    (rivlib / "lib").mkdir(parents=True)
    (rivlib / "lib" / "libscanifc.so").write_bytes(_elf())

    b = client.get(
        "/api/riegl/status", params={"rivlib_path": str(rivlib)}
    ).json()
    assert b["rivlib_path"] == str(rivlib)
    assert b["available"] is True


# ---------------------------------------------------------------------------
# The probes must never fork() — see _spawn_run in main.py
# ---------------------------------------------------------------------------
#
# The backend has libhelios (GLFW), open3d and PROJ/libsqlite3 loaded, and
# fork()+exec() crashes the child in the post-fork/pre-exec window while the
# registered pthread_atfork handlers run (PROJ tears down its SQLite handle
# cache and segfaults). The damage was silent: the probe's `except Exception`
# turned the dead child into "Docker is not running" on a machine where Docker
# was healthy, and macOS raised a "Python quit unexpectedly" dialog per probe.
#
# Asserting on the *symptom* (no crash dialog) is not testable in-process, so
# these lock the mechanism that causes it: the fork-based subprocess entry
# points are never reached.


def _forbid_fork(monkeypatch):
    """Fail loudly if a probe launches a subprocess outside `_spawn_run`.

    The rule being enforced is "every probe goes through _spawn_run", and the
    reason is the fork() hazard documented on that function: forking a process
    holding libhelios, open3d and PROJ crashes in the post-fork window.

    `_spawn_run` itself is therefore EXEMPT, and has to be -- on Windows it is
    implemented with subprocess, because that platform has no fork() for the
    hazard to exist in. Exempting it by tracking re-entry (rather than by not
    patching subprocess at all) keeps this test meaningful on Windows: a new
    probe that calls subprocess directly still trips, which is the whole point.
    """
    import subprocess as _sp

    # BaseException, not AssertionError: every probe wraps its call in a bare
    # `except Exception`, which would swallow the failure and let the test pass
    # against the very code it is meant to catch.
    class _Forked(BaseException):
        pass

    real_run, real_popen = _sp.run, _sp.Popen
    real_spawn_run = main._spawn_run
    depth = {"n": 0}

    def _spawn_run_spy(*a, **k):
        depth["n"] += 1
        try:
            return real_spawn_run(*a, **k)
        finally:
            depth["n"] -= 1

    def _guard(real):
        def _inner(*a, **k):
            if depth["n"]:
                return real(*a, **k)
            raise _Forked(
                "probe launched a subprocess directly; must use _spawn_run"
            )
        return _inner

    monkeypatch.setattr(main, "_ForkGuard", _Forked, raising=False)
    monkeypatch.setattr(main, "_spawn_run", _spawn_run_spy)

    monkeypatch.setattr(_sp, "run", _guard(real_run))
    monkeypatch.setattr(_sp, "Popen", _guard(real_popen))
    # os.fork must never be reached, from anywhere, including _spawn_run.
    monkeypatch.setattr(
        os, "fork",
        lambda *a, **k: (_ for _ in ()).throw(
            _Forked("probe used os.fork(); must use _spawn_run")
        ),
        raising=False,
    )


def test_docker_probe_does_not_fork(monkeypatch):
    _forbid_fork(monkeypatch)
    # Real call, real docker binary lookup: asserts only that it answers
    # without forking, not what the answer is (CI may or may not have Docker).
    try:
        assert isinstance(main._docker_present(), bool)
    except main._ForkGuard as e:
        raise AssertionError(str(e)) from None


def test_image_probe_does_not_fork(monkeypatch):
    _forbid_fork(monkeypatch)
    try:
        assert isinstance(main._riegl_image_built(), bool)
    except main._ForkGuard as e:
        raise AssertionError(str(e)) from None


def test_status_endpoint_does_not_fork(monkeypatch, client):
    _forbid_fork(monkeypatch)
    try:
        res = client.get("/api/riegl/status")
    except main._ForkGuard as e:
        raise AssertionError(str(e)) from None
    assert res.status_code == 200
    assert res.json()["reason"]


def test_spawn_run_reports_exit_code_and_output():
    """_spawn_run must be a faithful stand-in for subprocess.run's fields."""
    ok = main._spawn_run(["echo", "phytograph"], timeout=10)
    assert ok.returncode == 0
    assert "phytograph" in ok.stdout

    bad = main._spawn_run(["sh", "-c", "exit 3"], timeout=10)
    assert bad.returncode == 3


def test_spawn_run_missing_executable_raises():
    import pytest
    with pytest.raises(FileNotFoundError):
        main._spawn_run(["phytograph-no-such-binary-xyz"], timeout=5)


def test_spawn_run_times_out():
    import pytest
    import subprocess as _sp
    with pytest.raises(_sp.TimeoutExpired):
        main._spawn_run(["sleep", "5"], timeout=0.3)


def test_image_probe_survives_containerd_inspect_miss(monkeypatch):
    """`docker image inspect name:tag` lies under the containerd image store.

    With Docker Desktop's containerd image store enabled, a locally-built image
    resolves by ID and is listed by `docker images`, yet `image inspect` on its
    name:tag answers "No such image". Trusting inspect alone reported a present
    image as missing and told the user to rebuild what they already had.
    """
    calls = []

    def fake_spawn(argv, timeout=10.0, text=True):
        calls.append(argv)
        if argv[1] == "images":            # `docker images -q <ref>` resolves it
            return main._SpawnResult(0, "974cc428e166\n", "")
        return main._SpawnResult(1, "", "No such image")  # inspect misses

    monkeypatch.setattr(main, "_spawn_run", fake_spawn)
    assert main._riegl_image_built() is True
    assert any(a[1] == "images" for a in calls)


def test_image_probe_false_when_truly_absent(monkeypatch):
    """Both probes missing still means absent — the fallback must not rubber-stamp."""
    def fake_spawn(argv, timeout=10.0, text=True):
        return main._SpawnResult(1, "", "No such image")

    monkeypatch.setattr(main, "_spawn_run", fake_spawn)
    assert main._riegl_image_built() is False


# ---------------------------------------------------------------------------
# .PROJ: the registered frame
# ---------------------------------------------------------------------------


def _riegl_arrays(n_hit=4, dirs=None):
    """Hits at the scanner plus misses out on the far-field shell."""
    import numpy as np

    dirs = np.zeros((0, 3)) if dirs is None else np.asarray(dirs, dtype=np.float64)
    n_miss = dirs.shape[0]
    n = n_hit + n_miss
    return {
        "positions": np.vstack([np.zeros((n_hit, 3)), dirs * 20000.0]),
        "reflectance": np.zeros(n, dtype=np.float32),
        "amplitude": np.zeros(n, dtype=np.float32),
        "deviation": np.zeros(n, dtype=np.float32),
        "target_index": np.zeros(n, dtype=np.float32),
        "target_count": np.zeros(n, dtype=np.float32),
        "is_miss": np.concatenate([
            np.zeros(n_hit, dtype=np.float32),
            np.ones(n_miss, dtype=np.float32),
        ]),
    }


def test_a_sop_rotates_as_well_as_translates():
    """A .PROJ's placement is a full rigid transform, not a shift.

    The GNSS-prior path only ever translated, because a .riproject has no
    rotation to apply. A registered position does: the reference project's
    positions differ from each other by 23-31 degrees of heading, so applying
    the translation alone would leave every cloud correctly located and
    completely mis-oriented — which looks plausible in a thumbnail and is
    obviously wrong the moment two scans overlap.
    """
    import numpy as np

    arrays = _riegl_arrays(n_hit=2)
    arrays["positions"] = np.array([[1.0, 0.0, 0.0], [0.0, 2.0, 0.0]])
    # 90 degrees about +Z, then a translation.
    sop = [[0.0, -1.0, 0.0, 5.0],
           [1.0, 0.0, 0.0, -2.0],
           [0.0, 0.0, 1.0, 0.5],
           [0.0, 0.0, 0.0, 1.0]]
    res = main._riegl_arrays_to_las_result(arrays, sop=sop)
    assert res.positions[0] == pytest.approx([5.0, -1.0, 0.5])
    assert res.positions[1] == pytest.approx([3.0, -2.0, 0.5])


def test_the_sop_supersedes_the_gnss_prior():
    """Passing both would place the cloud twice.

    `origin` is the metres-level GNSS seed and the SOP is the surveyed pose;
    applying them together would offset every registered cloud by the prior on
    top of its real position.
    """
    import numpy as np

    arrays = _riegl_arrays(n_hit=1)
    arrays["positions"] = np.zeros((1, 3))
    sop = [[1.0, 0.0, 0.0, 5.0],
           [0.0, 1.0, 0.0, -2.0],
           [0.0, 0.0, 1.0, 0.5],
           [0.0, 0.0, 0.0, 1.0]]
    res = main._riegl_arrays_to_las_result(
        arrays, origin=[100.0, 100.0, 100.0], sop=sop
    )
    assert res.positions[0] == pytest.approx([5.0, -2.0, 0.5])


def test_misses_are_rotated_with_their_hits():
    """A miss is a real ray direction, so it must turn with the scanner.

    Rotating hits but not misses would fan the sky points away from the beams
    that cast them, and LAD's transmission term reads exactly that pairing.
    """
    import numpy as np

    dirs = np.array([[0.0, 0.0, 1.0], [1.0, 0.0, 0.0], [0.0, 1.0, 0.0]])
    arrays = _riegl_arrays(n_hit=2, dirs=dirs)
    sop = [[0.0, -1.0, 0.0, 5.0],
           [1.0, 0.0, 0.0, -2.0],
           [0.0, 0.0, 1.0, 0.5],
           [0.0, 0.0, 0.0, 1.0]]
    res = main._riegl_arrays_to_las_result(arrays, sop=sop)

    m = res.extras["is_miss"] == 1
    assert int(m.sum()) == 3
    scanner = np.array([5.0, -2.0, 0.5])
    # Still exactly 20 km from the instrument...
    assert np.linalg.norm(res.positions[m] - scanner, axis=1) == pytest.approx(
        20000.0, rel=1e-9
    )
    # ...and along the ROTATED directions: +X maps to +Y under a 90 deg yaw.
    rotated = (np.asarray(sop)[:3, :3] @ dirs.T).T
    assert res.positions[m] - scanner == pytest.approx(rotated * 20000.0, rel=1e-9)


def test_a_malformed_pose_is_refused_rather_than_broadcast():
    """A 3x3 would broadcast silently and place the cloud somewhere arbitrary."""
    arrays = _riegl_arrays(n_hit=1)
    with pytest.raises(HTTPException) as exc:
        main._riegl_arrays_to_las_result(
            arrays, sop=[[1.0, 0.0, 0.0], [0.0, 1.0, 0.0], [0.0, 0.0, 1.0]]
        )
    assert exc.value.status_code == 500
    assert "4x4" in str(exc.value.detail)


def test_frame_validation_rejects_an_unknown_frame():
    assert main._validate_riegl_frame(None) == main.RIEGL_FRAME_LOCAL
    assert main._validate_riegl_frame("registered") == main.RIEGL_FRAME_REGISTERED
    assert main._validate_riegl_frame("sensor") == main.RIEGL_FRAME_SENSOR
    with pytest.raises(HTTPException) as exc:
        main._validate_riegl_frame("prcs")
    assert exc.value.status_code == 400


def test_a_levelling_matrix_takes_the_same_path_as_a_sop():
    """The sensor frame reuses the SOP transform wholesale.

    A levelling matrix is an ordinary 4x4, so hits and miss directions must
    turn together exactly as they do under a registration SOP — the frame only
    changes where the matrix came from, never how it is applied.
    """
    import numpy as np

    dirs = np.array([[0.0, 0.0, 1.0], [1.0, 0.0, 0.0]])
    arrays = _riegl_arrays(n_hit=2, dirs=dirs)
    # A 2 deg roll about +X, inverted, with the scanner at the origin prior.
    roll = math.radians(2.0)
    att = np.array([[1.0, 0.0, 0.0],
                    [0.0, math.cos(roll), -math.sin(roll)],
                    [0.0, math.sin(roll), math.cos(roll)]])
    level = np.eye(4)
    level[:3, :3] = att.T
    level[:3, 3] = [1.0, 2.0, 3.0]

    res = main._riegl_arrays_to_las_result(arrays, sop=level.tolist())

    m = res.extras["is_miss"] == 1
    scanner = np.array([1.0, 2.0, 3.0])
    assert np.linalg.norm(res.positions[m] - scanner, axis=1) == pytest.approx(
        20000.0, rel=1e-9
    )
    rotated = (att.T @ dirs.T).T
    assert res.positions[m] - scanner == pytest.approx(rotated * 20000.0, rel=1e-9)


def test_a_stale_reader_image_is_named_as_the_problem():
    """An old image reports a .PROJ as empty, which reads as broken data.

    The reader is baked into a container the user builds by hand and nothing
    rebuilds automatically, so this is the likely first experience of the
    feature. The version check is what turns "no scan positions found" into a
    message with a fix in it.
    """
    main._require_reader_version({"reader_version": main._RIEGL_MIN_READER_VERSION})
    for doc in ({}, {"reader_version": 2}, {"reader_version": None}):
        with pytest.raises(HTTPException) as exc:
            main._require_reader_version(doc)
        assert exc.value.status_code == 500
        assert "Build reader image" in str(exc.value.detail)


def test_both_project_suffixes_are_previewable(tmp_path):
    """The wizard preview must accept a .PROJ directory, not 404 on it.

    Every other previewable format is a FILE, so the dispatcher's is_file()
    guard rejects a project directory unless the suffix is special-cased.
    """
    for name, scanpos in (
        ("old.riproject", "ScanPos001"),
        ("new.PROJ", "ScanPos001.SCNPOS"),
    ):
        proj = tmp_path / name
        (proj / scanpos).mkdir(parents=True)
        resp = main._preview_riproject(str(proj))
        assert resp.kind == "riproject"
        assert "1 scan position(s)" in resp.warning
        slugs = [c.suggested_slug for c in resp.columns]
        assert "reflectance" in slugs and "timestamp" in slugs
        # is_miss is a system flag, not a user column.
        assert "is_miss" not in slugs

    # And the .PROJ wording names the layout the user actually picked.
    assert ".PROJ" in main._preview_riproject(str(tmp_path / "new.PROJ")).warning


def test_a_proj_directory_is_not_rejected_as_a_missing_file(client, tmp_path):
    proj = tmp_path / "2024-07-18.PROJ"
    (proj / "ScanPos001.SCNPOS" / "scans").mkdir(parents=True)
    (proj / "project.json").write_text("{}")
    res = client.post("/api/pointcloud/preview", json={"file_path": str(proj)})
    assert res.status_code == 200, res.text
    assert res.json()["kind"] == "riproject"


def test_a_riegl_project_file_is_rejected_with_a_useful_message(client, tmp_path):
    """Picking a file INSIDE the project is the likely mistake, in both layouts."""
    stray = tmp_path / "240718_102357.rxp"
    stray.write_bytes(b"\0")
    with pytest.raises(HTTPException) as exc:
        main._validate_riegl_project(str(stray))
    assert exc.value.status_code == 400
    assert ".PROJ" in str(exc.value.detail)


# ---------------------------------------------------------------------------
# Image staleness: existence is not identity
# ---------------------------------------------------------------------------
#
# The reader lives inside a container image the user builds, and its output
# contract has already moved twice (2 -> 3 -> 4). Nothing rebuilds that image on
# its own — not the installer, not electron-updater. Before these tests, a probe
# that only asked "does an image exist?" reported an image built by any past
# version as ready, and the mismatch surfaced as a failure partway through an
# import, pointing at a Settings button that was hidden precisely BECAUSE the
# image existed. So identity is a hash of the build context, stamped into the
# image at build time and compared on every probe.


def _built_with(monkeypatch, tmp_path, stamp):
    """Fake a macOS machine with Docker up, RiVLib present, image built.

    `stamp` is what the built image reports as its identity — None models every
    image built before stamping existed.
    """
    _mac(monkeypatch)
    monkeypatch.setattr(main, "_docker_present", lambda: True)
    monkeypatch.setattr(main, "_riegl_image_built", lambda: True)
    monkeypatch.setattr(main, "_riegl_image_stamp", lambda: stamp)
    rivlib = tmp_path / "rivlib"
    (rivlib / "lib").mkdir(parents=True)
    (rivlib / "lib" / "libscanifc.so").write_bytes(_elf())
    return str(rivlib)


def test_image_built_from_older_sources_reads_as_stale(client, monkeypatch, tmp_path):
    rivlib = _built_with(monkeypatch, tmp_path, "0" * 64)

    b = client.get("/api/riegl/status", params={"rivlib_path": rivlib}).json()

    assert b["image_built"] is True, "the image does exist"
    assert b["image_stale"] is True, "but it is not the one these sources build"
    assert b["available"] is False
    # The wording has to carry the fix, and the fix here is "nothing, it heals".
    assert "out of date" in b["reason"].lower()
    assert "automatic" in b["reason"].lower()


def test_unstamped_image_reads_as_stale(client, monkeypatch, tmp_path):
    """Every image built before stamping existed carries no label at all.

    That is the population this feature ships into, so it must be the caught
    case rather than the missed one.
    """
    rivlib = _built_with(monkeypatch, tmp_path, None)

    b = client.get("/api/riegl/status", params={"rivlib_path": rivlib}).json()
    assert b["image_stale"] is True
    assert b["available"] is False


def test_matching_stamp_is_available(client, monkeypatch, tmp_path):
    rivlib = _built_with(monkeypatch, tmp_path, main._riegl_expected_stamp())

    b = client.get("/api/riegl/status", params={"rivlib_path": rivlib}).json()
    assert b["image_stale"] is False
    assert b["available"] is True
    assert b["image_stamp"] == b["expected_stamp"]


def test_unhashable_context_never_claims_stale(client, monkeypatch, tmp_path):
    """No context to hash means no verdict — not a rebuild prompt.

    A build that shipped without docker/riegl cannot be compared against
    anything, and nagging the user to rebuild against nothing would be a dead
    end. "Cannot judge" degrades to "fine", the same way every other probe here
    degrades to a usable state rather than an error.
    """
    rivlib = _built_with(monkeypatch, tmp_path, None)
    monkeypatch.setattr(main, "_riegl_expected_stamp", lambda *a, **k: None)

    b = client.get("/api/riegl/status", params={"rivlib_path": rivlib}).json()
    assert b["image_stale"] is False
    assert b["available"] is True


def test_stamp_covers_bytes_paths_and_ignores_pycache(tmp_path):
    ctx = tmp_path / "ctx"
    ctx.mkdir()
    (ctx / "Dockerfile").write_text("FROM scratch\n")
    (ctx / "rxp_reader.py").write_text("_STREAM_VERSION = 4\n")
    base = main._riegl_expected_stamp(ctx)
    assert base and len(base) == 64

    # Stable across calls — a hash that moved on its own would rebuild forever.
    assert main._riegl_expected_stamp(ctx) == base

    # Bytes: the common case, an edit that bumps no version at all.
    (ctx / "rxp_reader.py").write_text("_STREAM_VERSION = 5\n")
    bumped = main._riegl_expected_stamp(ctx)
    assert bumped != base

    # Paths: a renamed module changes what the image contains even when the
    # bytes in the context are collectively identical.
    (ctx / "rxp_reader.py").rename(ctx / "reader.py")
    assert main._riegl_expected_stamp(ctx) != bumped

    # __pycache__ is a side effect of running the reader locally, not an input.
    cache = ctx / "__pycache__"
    cache.mkdir()
    (cache / "reader.cpython-311.pyc").write_bytes(b"\x00\x01")
    assert main._riegl_expected_stamp(ctx) == main._riegl_expected_stamp(ctx)
    (ctx / "reader.py").rename(ctx / "rxp_reader.py")
    (ctx / "rxp_reader.py").write_text("_STREAM_VERSION = 4\n")
    assert main._riegl_expected_stamp(ctx) == base, "pycache must not stamp"


def test_build_passes_the_stamp_as_a_build_arg(monkeypatch, tmp_path):
    """The stamp only works if the build actually writes it."""
    import subprocess

    ctx = tmp_path / "ctx"
    ctx.mkdir()
    (ctx / "Dockerfile").write_text("FROM scratch\n")
    seen = {}

    class _FakeProc:
        returncode = 0

        def poll(self):
            return 0

        def wait(self):
            return 0

        def kill(self):
            pass

    def _fake_popen(cmd, **kwargs):
        seen["cmd"] = cmd
        return _FakeProc()

    monkeypatch.setattr(subprocess, "Popen", _fake_popen)
    main._run_docker_build(ctx)

    cmd = seen["cmd"]
    expected = main._riegl_expected_stamp(ctx)
    assert "--build-arg" in cmd
    assert f"PHYTOGRAPH_READER_STAMP={expected}" in cmd
    # And the image still gets its tag, or nothing would find it afterwards.
    assert main.RIEGL_IMAGE in cmd


def test_dockerfile_declares_the_stamp_below_every_run(tmp_path):
    """Pin the two properties the stamp depends on, in the file itself.

    The label key is a contract between the Dockerfile and _riegl_image_stamp:
    change one spelling and every image reads as unstamped, i.e. permanently
    stale, i.e. a rebuild before every single import.

    The ORDERING matters just as much and is far easier to break by accident: an
    ARG invalidates the build cache from its own line down, so an ARG placed
    above the pip/apt layers turns every reader edit into a full cold rebuild
    (minutes) instead of one COPY (~2 s) — which would quietly destroy the
    entire reason the self-heal is safe to run unattended.
    """
    dockerfile = (
        Path(main.__file__).resolve().parent.parent
        / "docker" / "riegl" / "Dockerfile"
    )
    lines = dockerfile.read_text(encoding="utf-8").splitlines()

    arg_idx = [
        i for i, ln in enumerate(lines)
        if ln.strip().startswith("ARG PHYTOGRAPH_READER_STAMP")
    ]
    label_idx = [
        i for i, ln in enumerate(lines)
        if ln.strip().startswith("LABEL org.phytograph.reader-stamp")
    ]
    assert len(arg_idx) == 1, "exactly one stamp ARG"
    assert len(label_idx) == 1, "exactly one stamp LABEL"
    assert lines[label_idx[0]].strip().endswith("$PHYTOGRAPH_READER_STAMP")

    last_run = max(
        (i for i, ln in enumerate(lines) if ln.strip().startswith("RUN ")),
        default=-1,
    )
    assert last_run >= 0, "the Dockerfile should still have RUN layers to protect"
    assert arg_idx[0] > last_run, (
        "ARG PHYTOGRAPH_READER_STAMP must sit below every RUN, or passing it "
        "busts the pip/apt cache and a reader edit costs minutes, not seconds"
    )


# ---------------------------------------------------------------------------
# Self-heal: a stale image updates itself on the next import
# ---------------------------------------------------------------------------


def _healable(monkeypatch, tmp_path):
    """A stale image, plus a fake build that makes the stamp match."""
    reported = {"stamp": "0" * 64}
    builds = []

    _mac(monkeypatch)
    monkeypatch.setattr(main, "_docker_present", lambda: True)
    monkeypatch.setattr(main, "_riegl_image_built", lambda: True)
    monkeypatch.setattr(main, "_riegl_image_stamp", lambda: reported["stamp"])

    def _fake_build(context, **kwargs):
        builds.append(context)
        reported["stamp"] = main._riegl_expected_stamp()

    monkeypatch.setattr(main, "_run_docker_build", _fake_build)

    rivlib = tmp_path / "rivlib"
    (rivlib / "lib").mkdir(parents=True)
    (rivlib / "lib" / "libscanifc.so").write_bytes(_elf())
    return str(rivlib), builds


def test_resolve_rebuilds_a_stale_image_and_proceeds(monkeypatch, tmp_path):
    """The whole point: the import does not fail, it waits ~2 s and continues."""
    rivlib, builds = _healable(monkeypatch, tmp_path)

    status = main._resolve_riegl_runtime(rivlib)

    assert len(builds) == 1, "rebuilt exactly once"
    assert status["available"] is True
    assert status["image_stale"] is False


def test_resolve_does_not_rebuild_a_missing_image(monkeypatch, tmp_path):
    """A MISSING image is first-run setup on a cold cache — minutes, not seconds.

    Healing that unattended would hang an import behind a ~150 MB base-image
    pull and an apt/pip install with no explanation, so it stays an explicit
    button in Settings. Only the warm case (an image exists, therefore its
    layers are cached) heals itself.
    """
    rivlib, builds = _healable(monkeypatch, tmp_path)
    monkeypatch.setattr(main, "_riegl_image_built", lambda: False)

    with pytest.raises(HTTPException) as exc:
        main._resolve_riegl_runtime(rivlib)

    assert exc.value.status_code == 503
    assert builds == [], "must not build a missing image behind the user's back"
    assert "not been built" in exc.value.detail


def test_resolve_does_not_rebuild_when_docker_is_down(monkeypatch, tmp_path):
    rivlib, builds = _healable(monkeypatch, tmp_path)
    monkeypatch.setattr(main, "_docker_present", lambda: False)

    with pytest.raises(HTTPException):
        main._resolve_riegl_runtime(rivlib)
    assert builds == []


def test_concurrent_imports_rebuild_the_image_once(monkeypatch, tmp_path):
    """Two imports can genuinely be in flight — every endpoint is a threadpool
    `def` — and they share one image tag. Without the lock plus the re-probe
    inside it, both would start their own `docker build`."""
    import threading

    rivlib, builds = _healable(monkeypatch, tmp_path)

    # Hold the first builder inside the build so the second is guaranteed to
    # arrive while it is still running, rather than relying on timing.
    inside = threading.Event()
    release = threading.Event()
    real_stamp = main._riegl_expected_stamp()
    reported = {}

    def _slow_build(context, **kwargs):
        builds.append(context)
        inside.set()
        release.wait(timeout=5)
        reported["done"] = True
        return None

    monkeypatch.setattr(main, "_run_docker_build", _slow_build)
    monkeypatch.setattr(
        main, "_riegl_image_stamp",
        lambda: real_stamp if reported.get("done") else "0" * 64,
    )

    results = []
    t1 = threading.Thread(
        target=lambda: results.append(main._resolve_riegl_runtime(rivlib))
    )
    t1.start()
    assert inside.wait(timeout=5), "first thread should reach the build"

    t2 = threading.Thread(
        target=lambda: results.append(main._resolve_riegl_runtime(rivlib))
    )
    t2.start()
    release.set()
    t1.join(timeout=10)
    t2.join(timeout=10)

    assert len(builds) == 1, "the second import must reuse the first's rebuild"
    assert len(results) == 2
    assert all(r["available"] for r in results)


def test_failed_rebuild_reports_the_manual_path(monkeypatch, tmp_path):
    """When the automatic update fails the user needs somewhere to go."""
    rivlib, _ = _healable(monkeypatch, tmp_path)

    def _boom(context, **kwargs):
        raise RuntimeError("daemon went away")

    monkeypatch.setattr(main, "_run_docker_build", _boom)

    with pytest.raises(HTTPException) as exc:
        main._resolve_riegl_runtime(rivlib)

    assert exc.value.status_code == 503
    assert "daemon went away" in exc.value.detail
    assert "Settings" in exc.value.detail


def test_heal_uses_a_tighter_timeout_than_the_manual_build(monkeypatch, tmp_path):
    """A warm rebuild is seconds; the 30-minute cold-cache ceiling would leave
    an import looking hung with no explanation."""
    rivlib, _ = _healable(monkeypatch, tmp_path)
    seen = {}

    def _capture(context, **kwargs):
        seen.update(kwargs)
        raise RuntimeError("stop here")

    monkeypatch.setattr(main, "_run_docker_build", _capture)
    with pytest.raises(HTTPException):
        main._resolve_riegl_runtime(rivlib)

    assert seen["timeout_s"] <= 600.0


# ---------------------------------------------------------------------------
# Where the build context lives in a PACKAGED app
# ---------------------------------------------------------------------------
#
# The same shape as the octree cache root: a path computed on BOTH sides of a
# process boundary, and validated only on the side where they happen to agree.
# electron-builder places extraResources relative to <app>/Contents/Resources,
# while the env var the main process exports (resourcesRoot()) points one level
# INSIDE that at .../Resources/resources. So {from: "docker", to: "docker"}
# ships the context at .../Resources/docker/riegl while the backend looked for
# .../Resources/resources/docker/riegl — it agreed in dev (repo root) and only
# in dev, which is exactly where every test ran.


def _extraresources_docker_dest():
    """Where electron-builder actually puts docker/riegl, per package.json."""
    repo_root = Path(main.__file__).resolve().parent.parent
    pkg = json.loads((repo_root / "package.json").read_text(encoding="utf-8"))
    for entry in pkg["build"]["extraResources"]:
        if entry.get("from") == "docker":
            return entry.get("to", "docker")
    raise AssertionError(
        "package.json no longer ships docker/ as extraResources — the RIEGL "
        "reader cannot be built in a packaged app without it"
    )


def test_packaged_layout_matches_package_json_extraresources(monkeypatch, tmp_path):
    """Build the real packaged tree and prove the resolver finds the context.

    Reconstructed from package.json rather than hardcoded, so changing where the
    context ships fails HERE instead of shipping an app whose only symptom is a
    503 the moment a user clicks Build reader image.
    """
    dest = _extraresources_docker_dest()

    # <app>/Contents/Resources — what an extraResources `to:` is relative to.
    contents_resources = tmp_path / "Contents" / "Resources"
    context = contents_resources / dest / "riegl"
    context.mkdir(parents=True)
    (context / "Dockerfile").write_text("FROM scratch\n")

    # What src/main/backend.ts exports: resourcesRoot() = <...>/Resources/resources
    monkeypatch.setenv(
        "PHYTOGRAPH_RESOURCES", str(contents_resources / "resources")
    )
    monkeypatch.delenv("PHYTOGRAPH_RIEGL_DOCKER_CONTEXT", raising=False)

    assert main._riegl_docker_context() == context

    # And the consequence that made this worth pinning: with no context there is
    # nothing to hash, so a packaged app could never tell a stale reader image
    # from a current one.
    assert main._riegl_expected_stamp() is not None


def test_context_still_resolves_from_the_repo_checkout(monkeypatch):
    """Dev has no PHYTOGRAPH_RESOURCES at all and must still find docker/riegl."""
    monkeypatch.delenv("PHYTOGRAPH_RESOURCES", raising=False)
    monkeypatch.delenv("PHYTOGRAPH_RIEGL_DOCKER_CONTEXT", raising=False)

    ctx = main._riegl_docker_context()
    assert (ctx / "Dockerfile").is_file()
    assert (ctx / "rxp_reader.py").is_file()
