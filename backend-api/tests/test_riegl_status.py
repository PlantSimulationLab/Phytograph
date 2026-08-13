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
import os

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
    # prerequisite actually holds.
    if b["available"]:
        assert b["platform_supported"] is True
        assert b["docker_present"] is True
        assert b["image_built"] is True
        assert b["rivlib_valid"] is True


def _mac(monkeypatch):
    import platform as _platform
    monkeypatch.setattr(_platform, "system", lambda: "Darwin")


def test_available_when_everything_is_present(client, monkeypatch, tmp_path):
    _mac(monkeypatch)
    monkeypatch.setattr(main, "_docker_present", lambda: True)
    monkeypatch.setattr(main, "_riegl_image_built", lambda: True)
    rivlib = tmp_path / "rivlib"
    (rivlib / "lib").mkdir(parents=True)
    (rivlib / "lib" / "libscanifc.so").write_bytes(b"")

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
    (rivlib / "lib" / "libscanifc.so").write_bytes(b"")

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
    (rivlib / "lib" / "libscanifc.so").write_bytes(b"")

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
    (rivlib / "lib" / "libscanifc.so").write_bytes(b"")
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

    n = 5
    arrays = {
        "positions": np.arange(n * 3, dtype=np.float64).reshape(n, 3),
        "reflectance": np.full(n, -10.0, dtype=np.float32),
        "amplitude": np.full(n, 20.0, dtype=np.float32),
        "deviation": np.zeros(n, dtype=np.float32),
        "target_index": np.ones(n, dtype=np.float32),
        "target_count": np.ones(n, dtype=np.float32),
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
        for col in (
            "reflectance", "amplitude", "deviation",
            "target_index", "target_count",
        ):
            np.zeros(n, dtype="<f4").tofile(scan_dir / f"{col}.f32")
        (scan_dir / "done.json").write_text(json.dumps({"point_count": n}))
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
    }
    res = main._riegl_arrays_to_las_result(arrays)

    assert res.positions.shape == (n, 3)
    assert set(res.extras) == {
        "is_miss", "reflectance", "amplitude", "deviation",
        "target_index", "target_count",
    }
    # .rxp carries only returns, so nothing is a miss (see Phase 7).
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
    (rivlib / "lib" / "libscanifc.so").write_bytes(b"")

    b = client.get(
        "/api/riegl/status", params={"rivlib_path": str(rivlib)}
    ).json()
    assert b["rivlib_path"] == str(rivlib)
    assert b["available"] is True
