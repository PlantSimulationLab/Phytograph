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
    monkeypatch.setattr(_platform, "machine", lambda: "AMD64")


def _mac(monkeypatch):
    import platform as _platform

    monkeypatch.setattr(_platform, "system", lambda: "Darwin")


def _linux(monkeypatch, machine: str = "x86_64"):
    """Pretend to be Linux, on a stated architecture.

    The arch is faked too, and is not optional decoration: _riegl_runtime gates
    Linux on it (RIEGL publishes no arm64 build), so a test that left it to the
    real host would answer differently on an arm64 runner than on an x86_64 one.
    """
    import platform as _platform

    monkeypatch.setattr(_platform, "system", lambda: "Linux")
    monkeypatch.setattr(_platform, "machine", lambda: machine)


PE_AMD64 = 0x8664
PE_I386 = 0x014C


def _pe(machine: int = PE_AMD64) -> bytes:
    """The smallest byte string that reads as a PE binary of `machine`."""
    header_at = 0x80
    buf = bytearray(header_at + 8)
    buf[0:2] = b"MZ"
    buf[0x3C:0x40] = header_at.to_bytes(4, "little")
    buf[header_at:header_at + 4] = b"PE\0\0"
    buf[header_at + 4:header_at + 6] = machine.to_bytes(2, "little")
    return bytes(buf)


ELF_X86_64 = 0x3E
ELF_AARCH64 = 0xB7


def _elf(machine: int = ELF_X86_64) -> bytes:
    """The smallest byte string that reads as a 64-bit ELF shared object."""
    buf = bytearray(20)
    buf[0:4] = b"\x7fELF"
    buf[4] = 2  # 64-bit
    buf[5] = 1  # little-endian
    buf[16:18] = (3).to_bytes(2, "little")  # ET_DYN
    buf[18:20] = machine.to_bytes(2, "little")
    return bytes(buf)


def _rivlib(tmp_path, name, *, machine=None, archive=True):
    """A RiVLib download carrying `name` as its scanifc library.

    Real headers for both artifact kinds, because the status no longer trusts
    the filename — an empty placeholder would now (correctly) read as a
    download that did not complete. `archive` controls whether the static
    library the miss-recovery shim links is present, which is what separates a
    complete Windows download from a runtime-only one; it has no meaning on the
    container path, where the shim links libscanifc.so itself.
    """
    root = tmp_path / "rivlib"
    (root / "lib").mkdir(parents=True, exist_ok=True)
    if name.endswith(".dll"):
        body = _pe(PE_AMD64 if machine is None else machine)
    else:
        body = _elf(ELF_X86_64 if machine is None else machine)
    (root / "lib" / name).write_bytes(body)
    if archive:
        (root / "lib" / "scanlib-mt-s.lib").write_bytes(b"")
    return root


# ---------------------------------------------------------------------------
# Which runtime a host gets
# ---------------------------------------------------------------------------

def test_runtime_is_docker_on_macos_and_native_on_windows(monkeypatch):
    _mac(monkeypatch)
    assert main._riegl_runtime() == "docker"
    _win(monkeypatch)
    assert main._riegl_runtime() == "native"


def test_x86_64_linux_reads_rxp_natively(monkeypatch):
    """Linux runs RiVLib directly, like Windows and unlike macOS.

    Verified against real scanner data before being switched on: RiVLib 2.15.5
    x86_64-linux-gcc9.5.0 decoding a VZ-1000 .riproject, with the C++ shim
    reconciling exactly (shots == hit shots + misses).
    """
    _linux(monkeypatch)
    assert main._riegl_runtime() == "native"
    # The artifact follows the HOST, so a Linux native host wants the .so.
    assert main._riegl_scanifc_names() == ("libscanifc.so",)


@pytest.mark.parametrize("machine", ["aarch64", "arm64", "armv7l"])
def test_arm_linux_has_no_runtime(monkeypatch, machine):
    """RIEGL publishes no arm64 Linux RiVLib, so there is nothing to run.

    Vetoed at the GATE rather than left to the library check downstream, and
    that placement is the whole point. _riegl_rivlib_unloadable compares against
    a hardcoded ELF x86_64, so on an arm64 host a perfectly CORRECT x86_64
    download passes the header check -- the badge would go green and the import
    would die at dlopen, which is the "present but unusable" state that check
    exists to prevent.
    """
    _linux(monkeypatch, machine)
    assert main._riegl_runtime() is None


def test_the_arch_veto_does_not_block_a_forced_runtime(monkeypatch):
    """The arch check sits AFTER the env override, deliberately.

    PHYTOGRAPH_RIEGL_RUNTIME=native is how the fake-RiVLib suite drives the
    native path, including on Apple silicon, where the stand-in library is
    built for the host rather than for x86_64.
    """
    _linux(monkeypatch, "aarch64")
    monkeypatch.setenv("PHYTOGRAPH_RIEGL_RUNTIME", "native")
    assert main._riegl_runtime() == "native"


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


def test_a_forced_native_runtime_on_macos_still_wants_the_so(monkeypatch, tmp_path):
    """The override's remaining job, and the reason the artifact follows the HOST.

    Linux now takes the native path unforced, so PHYTOGRAPH_RIEGL_RUNTIME is no
    longer what gives that path coverage. What it still does is force NATIVE on
    macOS, which is how the fake-RiVLib suite exercises the runner on a
    developer's Mac. Keying the scanifc filename on the runtime rather than the
    host would send that run looking for a .dll and skip silently.
    """
    _mac(monkeypatch)
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
# A RiVLib that is present but wrong
# ---------------------------------------------------------------------------
#
# RIEGL ship several builds per release — per OS, per compiler ABI, per
# architecture, and split across packages. Picking the wrong one is the most
# likely setup mistake there is, and the states below were all silently
# "ready" until they were tried against a real project.


def test_a_32_bit_rivlib_is_refused_with_the_reason(client, monkeypatch, tmp_path):
    """The worst state this setup could reach, before it was caught.

    A 32-bit download passes every filename check, so the badge went green and
    the picker opened — and the import then died on a bare
    `OSError: [WinError 193] %1 is not a valid Win32 application`, which names
    neither RiVLib nor the fix.
    """
    _win(monkeypatch)
    root = _rivlib(tmp_path, "scanifc-mt-s.dll", machine=PE_I386)

    b = client.get("/api/riegl/status", params={"rivlib_path": str(root)}).json()

    assert b["available"] is False
    assert b["misses_available"] is False
    # The file IS there — the folder is a RiVLib, it is just the wrong one.
    assert b["rivlib_valid"] is True
    assert "32-bit" in b["reason"]
    assert "x86_64" in b["reason"]


def test_a_truncated_download_is_refused_with_the_reason(
    client, monkeypatch, tmp_path
):
    _win(monkeypatch)
    root = _rivlib(tmp_path, "scanifc-mt-s.dll")
    # An MZ stub with no PE header: what a half-finished download looks like.
    (root / "lib" / "scanifc-mt-s.dll").write_bytes(b"MZ" + bytes(200))

    b = client.get("/api/riegl/status", params={"rivlib_path": str(root)}).json()

    assert b["available"] is False
    assert "not a valid Windows library" in b["reason"]
    assert "not have completed" in b["reason"]


def test_a_64_bit_rivlib_passes_the_header_check(monkeypatch, tmp_path):
    _win(monkeypatch)
    root = _rivlib(tmp_path, "scanifc-mt-s.dll")
    assert main._riegl_rivlib_unloadable(str(root)) is None


def test_the_check_covers_the_container_library_too(monkeypatch, tmp_path):
    """A .so gets an ELF check, not a PE one — the two runtimes are symmetric.

    macOS had the same green-badge gap: any file named libscanifc.so passed,
    and a wrong or truncated one failed only when the container tried to load
    it, well after the user had built an image from it.
    """
    _mac(monkeypatch)
    root = _rivlib(tmp_path, "libscanifc.so")
    assert main._riegl_rivlib_unloadable(str(root)) is None


def test_an_arm_linux_rivlib_is_refused_on_a_mac(client, monkeypatch, tmp_path):
    """Apple silicon does not mean an ARM RiVLib.

    The container is linux/amd64 whatever the Mac is, so the x86_64 Linux build
    is the right one — and reaching for an ARM build is the obvious mistake to
    make on an M-series machine.
    """
    _mac(monkeypatch)
    monkeypatch.setattr(main, "_docker_present", lambda: True)
    monkeypatch.setattr(main, "_riegl_image_built", lambda: True)
    root = _rivlib(tmp_path, "libscanifc.so", machine=ELF_AARCH64)

    b = client.get("/api/riegl/status", params={"rivlib_path": str(root)}).json()

    assert b["available"] is False
    assert b["misses_available"] is False
    assert "ARM64" in b["reason"]
    assert "linux/amd64" in b["reason"]
    # Says the quiet part out loud, because the instinct is to blame the Mac.
    assert "Apple silicon" in b["reason"]


def test_a_truncated_so_is_refused_on_a_mac(client, monkeypatch, tmp_path):
    _mac(monkeypatch)
    monkeypatch.setattr(main, "_docker_present", lambda: True)
    monkeypatch.setattr(main, "_riegl_image_built", lambda: True)
    root = _rivlib(tmp_path, "libscanifc.so")
    (root / "lib" / "libscanifc.so").write_bytes(b"")

    b = client.get("/api/riegl/status", params={"rivlib_path": str(root)}).json()

    assert b["available"] is False
    assert "not a valid Linux shared library" in b["reason"]


def test_the_wrong_gcc_abi_is_NOT_claimed_to_be_caught(monkeypatch, tmp_path):
    """The limit of a header check, pinned so nobody assumes otherwise.

    A gcc 11 or 13 build of RiVLib is a perfectly valid x86_64 ELF; what makes
    it unusable is symbol versioning the loader resolves at run time. Claiming
    to catch it here would be worse than not catching it, because the badge
    would go green on a folder we had "checked".
    """
    _mac(monkeypatch)
    root = _rivlib(tmp_path, "libscanifc.so")
    assert main._riegl_rivlib_unloadable(str(root)) is None


def test_a_partial_download_costs_only_the_sky_shots(client, monkeypatch, tmp_path):
    """DLLs but no static archive: points import, misses cannot.

    The shim links scanlib-mt-s.lib, so no compiler on earth produces miss
    recovery from this folder. Left unreported it surfaced as a linker error
    partway through an import the user had already committed to.
    """
    _win(monkeypatch)
    monkeypatch.setattr(main, "_riegl_toolchain_present", lambda: True)
    root = _rivlib(tmp_path, "scanifc-mt-s.dll", archive=False)

    b = client.get("/api/riegl/status", params={"rivlib_path": str(root)}).json()

    # Readable — this is not a broken setup, just an incomplete one.
    assert b["available"] is True
    assert b["misses_available"] is False
    assert b["toolchain_present"] is True
    assert main._RIEGL_SCANLIB_ARCHIVE in b["reason"]


def test_a_complete_sdk_reports_sky_shots_available(client, monkeypatch, tmp_path):
    _win(monkeypatch)
    monkeypatch.setattr(main, "_riegl_toolchain_present", lambda: True)
    root = _rivlib(tmp_path, "scanifc-mt-s.dll")

    b = client.get("/api/riegl/status", params={"rivlib_path": str(root)}).json()

    assert b["available"] is True
    assert b["misses_available"] is True
    assert b["reason"] == "RIEGL .rxp import is ready."


def test_a_failed_shim_build_degrades_rather_than_failing_the_import():
    """The distinction that decides whether a scan is thrown away.

    A shim that cannot be BUILT means this RiVLib cannot supply miss
    recovery — the same thing to the user as having no compiler, and the
    import continues without a sky shell. A shim that builds and then FAILS at
    run time is a real fault and still raises RxpError.
    """
    reader = main._rxp_reader_module()
    assert issubclass(reader.ShimUnavailable, reader.RxpError)
    with pytest.raises(reader.ShimUnavailable):
        reader._build_shim.__wrapped__ if False else None
        import os as _os

        old = _os.environ.get("PHYTOGRAPH_RXP_SHIM")
        _os.environ["PHYTOGRAPH_RXP_SHIM"] = r"C:\nope\missing-shim.dll"
        try:
            reader._build_shim()
        finally:
            if old is None:
                _os.environ.pop("PHYTOGRAPH_RXP_SHIM", None)
            else:
                _os.environ["PHYTOGRAPH_RXP_SHIM"] = old


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


def test_linux_default_location_follows_xdg(monkeypatch, tmp_path):
    """The Linux twin of the Windows convention, and it must match the docs.

    Mirrors _riegl_extract_dir()'s base so there is ONE idea of "Phytograph's
    per-user data directory on Linux" rather than two that can drift.
    """
    _linux(monkeypatch)
    monkeypatch.delenv("PHYTOGRAPH_RIVLIB_PATH", raising=False)
    monkeypatch.setenv("XDG_DATA_HOME", str(tmp_path))
    root = tmp_path / "Phytograph" / "rivlib"
    (root / "lib").mkdir(parents=True)
    (root / "lib" / "libscanifc.so").write_bytes(_elf())

    assert main._riegl_default_rivlib_root() == str(root)
    assert main._riegl_rivlib_path() == str(root)


def test_linux_default_location_falls_back_to_dot_local(monkeypatch, tmp_path):
    """XDG_DATA_HOME is frequently unset; ~/.local/share is its defined default.

    Without the fallback the convention would only work for users whose desktop
    environment happens to export the variable, which is precisely the set of
    users least likely to notice it had not.
    """
    _linux(monkeypatch)
    monkeypatch.delenv("XDG_DATA_HOME", raising=False)
    monkeypatch.setattr(main.Path, "home", classmethod(lambda cls: tmp_path))

    assert main._riegl_default_rivlib_root() == str(
        tmp_path / ".local" / "share" / "Phytograph" / "rivlib"
    )


def test_linux_default_location_is_ignored_when_it_holds_no_rivlib(
    monkeypatch, tmp_path
):
    """Same rule as Windows: "not set" must not be reported as "folder broken"."""
    _linux(monkeypatch)
    monkeypatch.delenv("PHYTOGRAPH_RIVLIB_PATH", raising=False)
    monkeypatch.setenv("XDG_DATA_HOME", str(tmp_path))
    assert main._riegl_rivlib_path() is None


# ---------------------------------------------------------------------------
# What a Linux native host needs, and what it does NOT
# ---------------------------------------------------------------------------

def test_linux_needs_no_static_archive(monkeypatch, tmp_path):
    """The false negative that would have killed LAD on Linux.

    Windows keeps scanlib::pointcloud in scanlib-mt-s.lib, so a runtime-only
    download imports points but cannot recover the sky shell. Linux exports the
    class from libscanifc.so itself, so there is no second file to be missing --
    and testing for one anyway reports a COMPLETE download as defective, pins
    misses_available false forever, and blames the user's RiVLib copy for it.
    """
    _linux(monkeypatch)
    root = _rivlib(tmp_path, "libscanifc.so")  # no scanlib-mt-s.lib
    monkeypatch.setattr(main, "_riegl_toolchain_present", lambda: True)

    body = main._riegl_status(str(root))
    assert body["runtime"] == "native"
    assert body["available"] is True
    assert body["misses_available"] is True
    assert main._RIEGL_SCANLIB_ARCHIVE not in body["reason"]
    assert main._riegl_scanlib_archive() is None


def test_linux_reasons_name_linux_things(monkeypatch, tmp_path):
    """Remediation must name files and products that exist on this platform.

    A Linux user told to find lib\\scanifc-mt-s.dll, or to install Visual Studio
    Build Tools, is being sent after things their system does not have -- worse
    than no hint, because it reads as authoritative.
    """
    _linux(monkeypatch)
    empty = tmp_path / "not-rivlib"
    (empty / "lib").mkdir(parents=True)
    reason = main._riegl_status(str(empty))["reason"]
    assert "libscanifc.so" in reason
    assert "\\" not in reason
    assert "scanifc-mt-s.dll" not in reason

    root = _rivlib(tmp_path, "libscanifc.so")
    monkeypatch.setattr(main, "_riegl_toolchain_present", lambda: False)
    body = main._riegl_status(str(root))
    # Still imports: only the sky shell is lost.
    assert body["available"] is True
    assert body["misses_available"] is False
    assert "g++" in body["reason"]
    assert "Visual Studio" not in body["reason"]
    # And it must not repeat the Windows CAUSE, which is false here: on Linux
    # the class is in the .so, not in a static library.
    assert "static library" not in body["reason"]


def test_linux_unloadable_remedy_mentions_no_container_and_no_mac(
    monkeypatch, tmp_path
):
    """A native host has no container to explain and no Mac to reassure."""
    _linux(monkeypatch)
    root = _rivlib(tmp_path, "libscanifc.so", machine=ELF_AARCH64)
    why = main._riegl_rivlib_unloadable(str(root))
    assert why is not None
    assert "container" not in why.lower()
    # "your Mac" / "Apple silicon", not the "machine" in "this machine".
    assert "your mac" not in why.lower()
    assert "apple" not in why.lower()
    assert "x86_64" in why


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


# ---------------------------------------------------------------------------
# Building the shim on a real host
#
# _compile_shim_gcc had NO coverage at all, and that is exactly why its
# missing-rpath bug survived: the fake-RiVLib suite hands over a PREBUILT shim
# via PHYTOGRAPH_RXP_SHIM, and the container hid the same bug behind its own
# LD_LIBRARY_PATH. A successful compile still cannot be tested here -- the fake
# RiVLib ships an EMPTY include/ and rxp_shim.cpp needs <riegl/scanlib.hpp>,
# which cannot be committed -- so these cover the command that gets composed and
# every way the build is allowed to fail. The real compile is verified against a
# real RiVLib by hand; see the workflow docs.
# ---------------------------------------------------------------------------

def _fake_cxx(tmp_path, *, exit_code=0, name="cxx"):
    """A stand-in compiler that records its argv and then does as it is told."""
    log = tmp_path / f"{name}.argv"
    script = tmp_path / name
    script.write_text(
        "#!/bin/sh\n"
        f'printf "%s\\n" "$@" >> "{log}"\n'
        # -dumpversion is the probe; always answer it so the probe succeeds
        # independently of whether the BUILD is meant to.
        'case "$1" in -dumpversion) echo 11.4.0; exit 0;; esac\n'
        f"exit {exit_code}\n"
    )
    script.chmod(0o755)
    return script, log


@pytest.mark.skipif(sys.platform == "win32", reason="POSIX shim build")
def test_the_shim_build_bakes_in_an_rpath(monkeypatch, tmp_path):
    """Without this the built shim cannot find libscanifc at load time.

    RiVLib sets SONAME libscanifc.so.2, so the shim records that as DT_NEEDED
    and nothing says where it lives: the container supplies
    LD_LIBRARY_PATH=/rivlib/lib, but _riegl_reader_invocation deliberately
    SCRUBS that for the native reader. Verified against the real library --
    ctypes.CDLL failed with "libscanifc.so.2: cannot open shared object file"
    until this flag was added.
    """
    reader = _reader()
    cxx, log = _fake_cxx(tmp_path)
    monkeypatch.setenv("PHYTOGRAPH_CXX", str(cxx))
    monkeypatch.setattr(reader, "_RIVLIB_ROOT", "/opt/rivlib")

    out = tmp_path / "librxpshim.so"
    # The fake compiler writes no output, so the build fails AFTER composing
    # the command -- which is the part under test.
    with pytest.raises(reader.ShimUnavailable):
        reader._compile_shim_gcc(str(tmp_path / "rxp_shim.cpp"), str(out))

    argv = log.read_text().split("\n")
    assert "-Wl,-rpath,/opt/rivlib/lib" in argv
    assert "-L/opt/rivlib/lib" in argv
    assert "-lscanifc" in argv
    # And it links the shared library, never a static archive: that is a
    # Windows-only concept and there is none in a Linux download.
    assert not any(a.endswith(".lib") for a in argv)


@pytest.mark.skipif(sys.platform == "win32", reason="POSIX shim build")
def test_the_shim_build_uses_the_compiler_the_probe_found(monkeypatch, tmp_path):
    """One definition of "can we build the shim", shared with the status badge.

    Hardcoding g++ in the build while the probe answered for something else
    would let Settings report a green toolchain row that the import then cannot
    use -- the exact drift find_msvc_vcvars exists to prevent on Windows.
    """
    reader = _reader()
    cxx, log = _fake_cxx(tmp_path, name="my-weird-cxx")
    monkeypatch.setenv("PHYTOGRAPH_CXX", str(cxx))

    assert reader.find_cxx_toolchain() == str(cxx)
    with pytest.raises(reader.ShimUnavailable):
        reader._compile_shim_gcc(
            str(tmp_path / "rxp_shim.cpp"), str(tmp_path / "out.so")
        )
    assert log.exists(), "the build must invoke the compiler the probe found"


@pytest.mark.skipif(sys.platform == "win32", reason="POSIX shim build")
def test_a_missing_compiler_costs_the_sky_shell_not_the_import(monkeypatch, tmp_path):
    """The regression: this used to be an uncaught FileNotFoundError.

    subprocess.run raises before returncode is ever read, so it escaped both
    stream_scan's `except ShimUnavailable` and main()'s `except RxpError` and
    killed the reader with a traceback -- losing a decode the user had already
    waited minutes for, over a shell they were willing to do without.
    """
    reader = _reader()
    monkeypatch.setenv("PHYTOGRAPH_CXX", str(tmp_path / "does-not-exist"))
    with pytest.raises(reader.ShimUnavailable):
        reader._compile_shim_gcc(
            str(tmp_path / "rxp_shim.cpp"), str(tmp_path / "out.so")
        )


@pytest.mark.skipif(sys.platform == "win32", reason="POSIX shim build")
def test_a_failed_build_costs_the_sky_shell_not_the_import(monkeypatch, tmp_path):
    """ShimUnavailable, not RxpError -- matching what MSVC already chose.

    A build that fails almost always means this RiVLib copy cannot supply what
    the shim needs (a wrong-ABI download is the Linux case). That costs the sky
    shell; failing the whole import throws away a readable scan.
    """
    reader = _reader()
    cxx, _ = _fake_cxx(tmp_path, exit_code=1)
    monkeypatch.setenv("PHYTOGRAPH_CXX", str(cxx))
    with pytest.raises(reader.ShimUnavailable):
        reader._compile_shim_gcc(
            str(tmp_path / "rxp_shim.cpp"), str(tmp_path / "out.so")
        )


@pytest.mark.skipif(sys.platform == "win32", reason="POSIX shim build")
def test_a_failed_build_leaves_nothing_in_the_cache(monkeypatch, tmp_path):
    """Publishing is atomic, so a broken shim can never be cached.

    _build_shim short-circuits on `if os.path.exists(out)`, so a half-linked or
    unloadable artifact at the cache path would be returned forever after,
    re-failing with no diagnosis. Linking straight onto that path also raced two
    concurrent imports, which the container never had to care about because its
    cache died with it.
    """
    reader = _reader()
    cxx, _ = _fake_cxx(tmp_path, exit_code=1)
    monkeypatch.setenv("PHYTOGRAPH_CXX", str(cxx))
    out = tmp_path / "librxpshim.so"
    with pytest.raises(reader.ShimUnavailable):
        reader._compile_shim_gcc(str(tmp_path / "rxp_shim.cpp"), str(out))
    assert not out.exists()
    assert not list(tmp_path.glob("rxpshim-build-*")), "temp build dir leaked"


def test_an_unloadable_shim_costs_the_sky_shell_not_the_import(tmp_path):
    """The catch-all for ABI failures no header check can predict.

    A RiVLib built for the wrong gcc, or a shim whose compiler was newer than
    the libstdc++ that wins the loader path (PyInstaller's bundle leads
    LD_LIBRARY_PATH in a packaged app and beats DT_RUNPATH), fails only at
    dlopen. That used to escape as an OSError and kill the import.
    """
    reader = _reader()
    not_a_library = tmp_path / "librxpshim.so"
    not_a_library.write_text("this is not an ELF object")
    with pytest.raises(reader.ShimUnavailable):
        reader._load_shim(str(not_a_library))


@pytest.mark.skipif(sys.platform == "win32", reason="POSIX cache dir")
def test_the_shim_cache_is_per_user_not_world_writable(monkeypatch, tmp_path):
    """/tmp is right for a container and wrong for a workstation.

    Not merely because it is swept: it is world-writable at a PREDICTABLE
    filename, since the stamp hashes only public inputs. Another user on a
    shared machine could plant the .so we are about to dlopen. Per-user data
    removes that, and the container keeps /tmp by saying so itself.
    """
    reader = _reader()
    monkeypatch.delenv("PHYTOGRAPH_RXP_SHIM_CACHE", raising=False)
    monkeypatch.delenv("PHYTOGRAPH_RXP_CONTAINER", raising=False)
    monkeypatch.setenv("XDG_DATA_HOME", str(tmp_path))
    if sys.platform != "darwin":
        assert reader._shim_cache_dir() == str(tmp_path / "Phytograph" / "riegl")
    assert not reader._shim_cache_dir().startswith("/tmp/Phytograph")

    monkeypatch.setenv("PHYTOGRAPH_RXP_CONTAINER", "1")
    assert reader._shim_cache_dir() == "/tmp"
