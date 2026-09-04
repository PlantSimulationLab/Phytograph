"""The native (non-container) RIEGL runtime.

macOS reads .rxp inside a Linux container because RiVLib has no Darwin build.
Windows has a native one, so the container would mean installing Docker Desktop
to run an x86 Linux VM to call a library that is already native — the reader is
instead spawned as an ordinary child process.

These tests pin the parts that differ, all of which are silent when wrong:
which library file counts as "a RiVLib", how container paths become host paths,
what the child's environment must carry, and the fact that a missing C++
toolchain costs the sky shell rather than the whole import.

Everything is monkeypatched, so the suite runs identically on any host.
"""

import os
import sys
from pathlib import Path

import pytest

import main


def _win(monkeypatch):
    """Pretend to be Windows. Mirrors _mac() in test_riegl_status.py."""
    import platform as _platform

    monkeypatch.setattr(_platform, "system", lambda: "Windows")


def _mac(monkeypatch):
    import platform as _platform

    monkeypatch.setattr(_platform, "system", lambda: "Darwin")


def _linux(monkeypatch):
    import platform as _platform

    monkeypatch.setattr(_platform, "system", lambda: "Linux")


def _rivlib(tmp_path, name):
    """A RiVLib download carrying `name` as its scanifc library."""
    root = tmp_path / "rivlib"
    (root / "lib").mkdir(parents=True, exist_ok=True)
    (root / "lib" / name).write_bytes(b"")
    return root


# ---------------------------------------------------------------------------
# Which runtime a host gets
# ---------------------------------------------------------------------------

def test_runtime_is_docker_on_macos_and_native_on_windows(monkeypatch):
    _mac(monkeypatch)
    assert main._riegl_runtime() == "docker"
    _win(monkeypatch)
    assert main._riegl_runtime() == "native"


def test_linux_has_no_runtime_yet(monkeypatch):
    """RiVLib ships a Linux build, but it is not wired up or verified.

    Reported as no runtime at all rather than as a broken one, so the status
    takes the platform veto and never shells out to docker.
    """
    _linux(monkeypatch)
    assert main._riegl_runtime() is None


# ---------------------------------------------------------------------------
# What counts as a RiVLib download
# ---------------------------------------------------------------------------

def test_windows_accepts_the_static_crt_dll(monkeypatch, tmp_path):
    _win(monkeypatch)
    root = _rivlib(tmp_path, "scanifc-mt-s.dll")
    assert main._riegl_rivlib_valid(str(root)) is True
    assert main._riegl_scanifc_path(str(root)).name == "scanifc-mt-s.dll"


def test_windows_falls_back_to_the_dynamic_crt_dll(monkeypatch, tmp_path):
    """Older or repackaged downloads may carry only scanifc-mt.dll."""
    _win(monkeypatch)
    root = _rivlib(tmp_path, "scanifc-mt.dll")
    assert main._riegl_rivlib_valid(str(root)) is True
    assert main._riegl_scanifc_path(str(root)).name == "scanifc-mt.dll"


def test_windows_prefers_the_static_crt_build_when_both_exist(monkeypatch, tmp_path):
    """scanifc-mt-s.dll imports only WS2_32 and KERNEL32.

    The plain build additionally needs MSVCP140/VCRUNTIME140 from the Visual C++
    redistributable, and a machine without it fails at load with a WinError 126
    that names our DLL rather than the missing dependency. Preferring the static
    build means a user who has merely extracted the SDK can read scans.
    """
    _win(monkeypatch)
    root = _rivlib(tmp_path, "scanifc-mt-s.dll")
    (root / "lib" / "scanifc-mt.dll").write_bytes(b"")
    assert main._riegl_scanifc_path(str(root)).name == "scanifc-mt-s.dll"


def test_a_linux_rivlib_is_not_a_windows_one(monkeypatch, tmp_path):
    """The .so is what the container needs and is useless natively."""
    _win(monkeypatch)
    root = _rivlib(tmp_path, "libscanifc.so")
    assert main._riegl_rivlib_valid(str(root)) is False


def test_a_windows_rivlib_is_not_a_container_one(monkeypatch, tmp_path):
    _mac(monkeypatch)
    root = _rivlib(tmp_path, "scanifc-mt-s.dll")
    assert main._riegl_rivlib_valid(str(root)) is False


def test_a_forced_native_runtime_on_linux_still_wants_the_so(monkeypatch, tmp_path):
    """The combination CI runs on, and the reason the artifact follows the HOST.

    PHYTOGRAPH_RIEGL_RUNTIME=native lets the Linux pytest job exercise the
    native runner against the fake RiVLib — the path is otherwise reachable
    only on Windows, which would leave it with no every-push coverage. Keying
    the scanifc filename on the runtime instead of the host would send that job
    looking for a .dll on Linux and skip silently.
    """
    _linux(monkeypatch)
    monkeypatch.setenv("PHYTOGRAPH_RIEGL_RUNTIME", "native")
    assert main._riegl_runtime() == "native"
    assert main._riegl_scanifc_names() == ("libscanifc.so",)

    root = _rivlib(tmp_path, "libscanifc.so")
    assert main._riegl_rivlib_valid(str(root)) is True


def test_macos_keeps_wanting_the_linux_so(monkeypatch, tmp_path):
    """The docker runtime bind-mounts RiVLib INTO a Linux container.

    So a Mac needs the Linux .so, not a Darwin build — there isn't one — which
    is the other half of why the artifact name follows the host rather than the
    runtime.
    """
    _mac(monkeypatch)
    assert main._riegl_scanifc_names() == ("libscanifc.so",)


def test_an_unknown_forced_runtime_is_ignored(monkeypatch):
    """A typo must not silently disable the feature.

    Falling through to the host's own answer means a bad value costs nothing;
    honouring it would strand the user on a runtime that does not exist.
    """
    _win(monkeypatch)
    monkeypatch.setenv("PHYTOGRAPH_RIEGL_RUNTIME", "wasm")
    assert main._riegl_runtime() == "native"


# ---------------------------------------------------------------------------
# The documented default location
# ---------------------------------------------------------------------------

def test_default_location_is_used_when_the_setting_is_unset(monkeypatch, tmp_path):
    """Following the docs should mean never opening the folder picker."""
    _win(monkeypatch)
    monkeypatch.delenv("PHYTOGRAPH_RIVLIB_PATH", raising=False)
    monkeypatch.setenv("LOCALAPPDATA", str(tmp_path))
    root = tmp_path / "Phytograph" / "rivlib"
    (root / "lib").mkdir(parents=True)
    (root / "lib" / "scanifc-mt-s.dll").write_bytes(b"")

    assert main._riegl_rivlib_path() == str(root)


def test_default_location_is_ignored_when_it_holds_no_rivlib(monkeypatch, tmp_path):
    """An unset setting must report "not set", not "your folder is broken".

    Returning the default path unconditionally would make the status blame the
    contents of a directory the user never chose and may not have created.
    """
    _win(monkeypatch)
    monkeypatch.delenv("PHYTOGRAPH_RIVLIB_PATH", raising=False)
    monkeypatch.setenv("LOCALAPPDATA", str(tmp_path))
    assert main._riegl_rivlib_path() is None


def test_an_explicit_choice_beats_the_default(monkeypatch, tmp_path):
    _win(monkeypatch)
    monkeypatch.setenv("LOCALAPPDATA", str(tmp_path))
    root = tmp_path / "Phytograph" / "rivlib"
    (root / "lib").mkdir(parents=True)
    (root / "lib" / "scanifc-mt-s.dll").write_bytes(b"")

    assert main._riegl_rivlib_path(r"D:\elsewhere") == r"D:\elsewhere"


def test_macos_has_no_default_location(monkeypatch, tmp_path):
    """There has never been a documented place to guess at on macOS."""
    _mac(monkeypatch)
    monkeypatch.setenv("LOCALAPPDATA", str(tmp_path))
    assert main._riegl_default_rivlib_root() is None


# ---------------------------------------------------------------------------
# Building the reader invocation
# ---------------------------------------------------------------------------

def test_native_rewrites_container_paths_to_host_paths(monkeypatch, tmp_path):
    """There is no mount namespace, so /project has to become a real path."""
    _win(monkeypatch)
    monkeypatch.setattr(main, "_rxp_reader_command", lambda: ["PY", "reader.py"])
    root = _rivlib(tmp_path, "scanifc-mt-s.dll")
    mounts = [
        (str(root), "/rivlib", "ro"),
        (r"D:\scans\a.riproject", "/project", "ro"),
        (r"D:\tmp\out", "/out", "rw"),
    ]
    args = ["stream", "/project", "--out", "/out", "--frame", "local"]

    cmd, env, container = main._riegl_reader_invocation(args, mounts)

    assert cmd == [
        "PY", "reader.py", "stream", r"D:\scans\a.riproject",
        "--out", r"D:\tmp\out", "--frame", "local",
    ]
    assert container is None
    assert "docker" not in cmd


def test_native_rewrite_is_by_whole_argument_not_substring(monkeypatch, tmp_path):
    """A scan name containing a reader path must survive untouched.

    Substring replacement would corrupt any option value that happened to
    contain "/project" or "/out" — and the damage would be a wrong path deep in
    an argument list, not an error.
    """
    _win(monkeypatch)
    monkeypatch.setattr(main, "_rxp_reader_command", lambda: ["PY"])
    mounts = [(r"D:\p", "/project", "ro")]
    args = ["stream", "/project", "--scans", "/project-backup", "out/project"]

    cmd, _env, _c = main._riegl_reader_invocation(args, mounts)

    assert cmd == ["PY", "stream", r"D:\p", "--scans", "/project-backup", "out/project"]


def test_native_env_points_the_reader_at_rivlib(monkeypatch, tmp_path):
    """The reader defaults to the container's /rivlib and must be told better.

    RIVLIB_ROOT as well as RIVLIB_SO: the root is what the miss-recovery shim
    build needs for its include/ and lib/ paths, and the library file alone
    cannot supply it.
    """
    _win(monkeypatch)
    monkeypatch.setattr(main, "_rxp_reader_command", lambda: ["PY"])
    root = _rivlib(tmp_path, "scanifc-mt-s.dll")
    mounts = [(str(root), "/rivlib", "ro")]

    _cmd, env, _c = main._riegl_reader_invocation(["inspect"], mounts)

    assert env["RIVLIB_ROOT"] == str(root)
    assert env["RIVLIB_SO"] == str(root / "lib" / "scanifc-mt-s.dll")
    # Without this the child would start uvicorn instead of the reader.
    assert env["PHYTOGRAPH_RXP_READER"] == "1"
    # Progress must arrive as it happens, not in a lump at exit.
    assert env["PYTHONUNBUFFERED"] == "1"


def test_loader_paths_are_scrubbed_on_both_runtimes(monkeypatch, tmp_path):
    """A PyInstaller-bundled Python injects these and they break any child."""
    monkeypatch.setattr(main, "_rxp_reader_command", lambda: ["PY"])
    monkeypatch.setenv("LD_LIBRARY_PATH", "/injected")
    monkeypatch.setenv("DYLD_LIBRARY_PATH", "/injected")
    for fake in (_win, _mac):
        fake(monkeypatch)
        _cmd, env, _c = main._riegl_reader_invocation(["inspect"], [])
        assert "LD_LIBRARY_PATH" not in env
        assert "DYLD_LIBRARY_PATH" not in env


def test_docker_invocation_is_unchanged(monkeypatch, tmp_path):
    _mac(monkeypatch)
    mounts = [("/host/rivlib", "/rivlib", "ro"), ("/host/proj", "/project", "ro")]
    cmd, env, container = main._riegl_reader_invocation(["inspect", "/project"], mounts)

    assert cmd[:5] == ["docker", "run", "--rm", "--name", container]
    assert "--platform" in cmd and "linux/amd64" in cmd
    assert "-v" in cmd
    assert "/host/rivlib:/rivlib:ro" in cmd
    assert "/host/proj:/project:ro" in cmd
    # The image name, then the reader's own arguments, unrewritten: inside the
    # container /project genuinely exists.
    assert cmd[-3:] == [main.RIEGL_IMAGE, "inspect", "/project"]
    assert container and container.startswith("phytograph-riegl-")
    # The container reads RiVLib from its bind mount, so these would be wrong.
    assert "RIVLIB_SO" not in env


def test_docker_container_names_are_unique(monkeypatch):
    """Cancellation targets a container by name, and imports run concurrently."""
    _mac(monkeypatch)
    names = {
        main._riegl_reader_invocation(["inspect"], [])[2] for _ in range(5)
    }
    assert len(names) == 5


# ---------------------------------------------------------------------------
# Locating the reader itself
# ---------------------------------------------------------------------------

def test_frozen_backend_re_enters_itself(monkeypatch):
    """A packaged binary has no script argument to hand a child interpreter."""
    monkeypatch.setattr(sys, "frozen", True, raising=False)
    monkeypatch.setattr(sys, "executable", "/Apps/phytograph_backend")
    assert main._rxp_reader_command() == ["/Apps/phytograph_backend"]


def test_dev_runs_the_reader_script_directly(monkeypatch):
    monkeypatch.setattr(sys, "frozen", False, raising=False)
    monkeypatch.setattr(sys, "executable", "/venv/bin/python")
    cmd = main._rxp_reader_command()
    assert cmd[0] == "/venv/bin/python"
    assert cmd[1].endswith(os.path.join("docker", "riegl", "rxp_reader.py"))
    assert Path(cmd[1]).is_file()


# ---------------------------------------------------------------------------
# Cancellation
# ---------------------------------------------------------------------------

def test_native_cancel_kills_the_child_without_calling_docker(monkeypatch):
    """The reader is our own child here; there is no container to kill.

    Shelling out to `docker kill` on a machine that has no Docker would burn a
    subprocess timeout on every cancel, in the one path that is supposed to be
    immediate.
    """
    called = []
    monkeypatch.setattr(main, "_spawn_run", lambda *a, **k: called.append(a))

    class _Proc:
        def __init__(self):
            self.killed = False

        def kill(self):
            self.killed = True

    proc = _Proc()
    main._kill_riegl_container(None, proc)

    assert proc.killed is True
    assert called == []


# ---------------------------------------------------------------------------
# Status
# ---------------------------------------------------------------------------

def test_native_is_available_without_docker(client, monkeypatch, tmp_path):
    _win(monkeypatch)
    monkeypatch.setattr(main, "_riegl_toolchain_present", lambda: True)
    root = _rivlib(tmp_path, "scanifc-mt-s.dll")

    b = client.get("/api/riegl/status", params={"rivlib_path": str(root)}).json()

    assert b["available"] is True
    assert b["runtime"] == "native"
    assert b["docker_present"] is False
    assert b["misses_available"] is True
    assert b["image_stale"] is False
    assert "ready" in b["reason"].lower()


def test_native_status_never_probes_docker(client, monkeypatch, tmp_path):
    """Docker is irrelevant here, and probing it costs a subprocess timeout."""
    _win(monkeypatch)
    monkeypatch.setattr(main, "_riegl_toolchain_present", lambda: True)
    probed = []
    monkeypatch.setattr(
        main, "_docker_present", lambda: probed.append(True) or True
    )
    root = _rivlib(tmp_path, "scanifc-mt-s.dll")

    client.get("/api/riegl/status", params={"rivlib_path": str(root)})

    assert probed == []


def test_missing_toolchain_costs_the_sky_shell_not_the_import(
    client, monkeypatch, tmp_path
):
    """The two-tier contract, and the reason it is two tiers.

    Points, attributes, GNSS and registration need no compiler. Only no-return
    shots do, because on Windows that part of RiVLib is a static archive we are
    not licensed to ship pre-linked. Refusing the whole import over it would
    withhold a scan the user can read perfectly well — so `available` stays
    true and `misses_available` carries the bad news.
    """
    _win(monkeypatch)
    monkeypatch.setattr(main, "_riegl_toolchain_present", lambda: False)
    root = _rivlib(tmp_path, "scanifc-mt-s.dll")

    b = client.get("/api/riegl/status", params={"rivlib_path": str(root)}).json()

    assert b["available"] is True
    assert b["misses_available"] is False
    assert b["toolchain_present"] is False
    # The reason has to name what is lost, or a user reads "ready" and later
    # finds Leaf Area Density failing for no visible cause.
    assert "sky" in b["reason"].lower()
    assert "build tools" in b["reason"].lower()


def test_native_without_rivlib_is_unavailable(client, monkeypatch, tmp_path):
    _win(monkeypatch)
    monkeypatch.delenv("PHYTOGRAPH_RIVLIB_PATH", raising=False)
    monkeypatch.setenv("LOCALAPPDATA", str(tmp_path))

    b = client.get("/api/riegl/status").json()

    assert b["available"] is False
    assert b["runtime"] == "native"
    assert b["misses_available"] is False
    assert "not been configured" in b["reason"]


def test_native_names_the_dll_it_looked_for(client, monkeypatch, tmp_path):
    """Telling a Windows user about libscanifc.so sends them hunting for a file
    their download does not contain."""
    _win(monkeypatch)
    empty = tmp_path / "not-rivlib"
    empty.mkdir()

    b = client.get("/api/riegl/status", params={"rivlib_path": str(empty)}).json()

    assert b["available"] is False
    assert "scanifc-mt-s.dll" in b["reason"]
    assert "libscanifc.so" not in b["reason"]


def test_toolchain_is_not_probed_without_a_valid_rivlib(monkeypatch, tmp_path):
    """No point asking about a compiler for a build that cannot run anyway."""
    _win(monkeypatch)
    probed = []
    monkeypatch.setattr(
        main, "_riegl_toolchain_present", lambda: probed.append(True) or True
    )
    st = main._riegl_status_native(None, False)
    assert probed == []
    assert st["toolchain_present"] is False


def test_toolchain_probe_degrades_rather_than_raising(monkeypatch):
    """A broken probe reports "no toolchain", never a 500.

    This is an optional capability; a failure to answer must not take down the
    status endpoint the badge polls.
    """
    _win(monkeypatch)

    def _boom():
        raise RuntimeError("vswhere exploded")

    monkeypatch.setattr(main, "_rxp_reader_module", _boom)
    assert main._riegl_toolchain_present() is False


# ---------------------------------------------------------------------------
# The build endpoint
# ---------------------------------------------------------------------------

def test_build_endpoint_refuses_plainly_on_native(client, monkeypatch, tmp_path):
    """There is no image to build; the reader ships inside the backend bundle.

    Answering with the docker probe's message would send the user to install a
    daemon this platform never needed.
    """
    _win(monkeypatch)
    monkeypatch.setattr(main, "_riegl_toolchain_present", lambda: True)
    root = _rivlib(tmp_path, "scanifc-mt-s.dll")

    res = client.post("/api/riegl/image/build", json={"rivlib_path": str(root)})

    assert res.status_code == 503
    detail = res.json()["detail"].lower()
    assert "no reader image to build" in detail
    assert "docker" not in detail


# ---------------------------------------------------------------------------
# The reader module's own platform behaviour
# ---------------------------------------------------------------------------

def _reader():
    return main._rxp_reader_module()


def test_reader_shim_cache_key_follows_the_rivlib_root(monkeypatch, tmp_path):
    """A different SDK must produce a different DLL, not reuse the old one.

    On Windows the shim statically links RIEGL's scanlib, so the binary is
    specific to the SDK it was built from. The stamp is in the FILENAME, so a
    change simply misses the cache instead of needing a staleness check.
    """
    reader = _reader()
    src_dir = reader._shim_source_dir()
    monkeypatch.setattr(reader, "_RIVLIB_ROOT", r"C:\a")
    a = reader._shim_stamp(src_dir)
    monkeypatch.setattr(reader, "_RIVLIB_ROOT", r"C:\b")
    b = reader._shim_stamp(src_dir)
    assert a != b


def test_reader_shim_cache_key_follows_the_shim_sources(monkeypatch, tmp_path):
    reader = _reader()
    src = tmp_path / "shimsrc"
    src.mkdir()
    (src / "rxp_shim.cpp").write_text("// v1")
    (src / "rxpshim.def").write_text("EXPORTS\\nrxpshim_free\\n")
    first = reader._shim_stamp(str(src))
    (src / "rxp_shim.cpp").write_text("// v2")
    assert reader._shim_stamp(str(src)) != first


def test_reader_export_list_matches_the_shim_source():
    """The .def is a contract with rxp_shim.cpp, and Windows enforces nothing.

    `extern "C"` alone does not export from a DLL. If the two drift, the build
    still succeeds and produces a DLL missing a symbol, and the failure surfaces
    much later as ctypes' "function not found" — so compare them here.
    """
    riegl = Path(main.__file__).resolve().parent.parent / "docker" / "riegl"
    cpp = (riegl / "rxp_shim.cpp").read_text(encoding="utf-8")
    exported = {
        line.strip()
        for line in (riegl / "rxpshim.def").read_text(encoding="utf-8").splitlines()
        if line.strip().startswith("rxpshim_")
    }
    defined = {
        tok.split("(")[0].strip()
        for tok in cpp.split()
        if tok.startswith("rxpshim_") and "(" in tok
    }
    assert exported, "the .def declares no exports"
    assert exported == defined, (
        "rxpshim.def and rxp_shim.cpp disagree: "
        f"only in .def={sorted(exported - defined)}, "
        f"only in .cpp={sorted(defined - exported)}"
    )


def test_reader_uri_keeps_windows_paths_intact():
    """RiVLib takes URIs, and `file:` + a native C:\\ path is what it accepts.

    Verified against a real .rxp: both `file:C:\\...` and `file:C:/...` open,
    while `file:///C:/...` does not. Pinned because a "helpful" normalisation to
    the file:// form would break every Windows import.
    """
    reader = _reader()
    assert reader._uri(r"C:\scans\a.rxp") == r"file:C:\scans\a.rxp"


@pytest.mark.parametrize("platform_name", ["Windows", "Darwin"])
def test_reader_reports_a_missing_toolchain_as_its_own_kind_of_error(platform_name):
    """ShimUnavailable is what lets an import continue without the sky shell.

    A plain RxpError would fail the whole import; anything broader would also
    swallow a shim that exists but genuinely failed, which IS a fault.
    """
    reader = _reader()
    assert issubclass(reader.ShimUnavailable, reader.RxpError)
