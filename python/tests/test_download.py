"""`pip install phytograph` alone: the backend download, against a local fake
release server (PHYTOGRAPH_BACKEND_URL). The archive is built in the real
layout; its "executable" is a shell stub that starts the dev checkout's real
backend, so download → verify → extract → launch → version check → a real
import all run, in seconds. Packing and running the real PyInstaller bundle is
`test_real_bundle_archive` (opt-in: it moves ~1 GB)."""
from __future__ import annotations

import functools
import hashlib
import http.server
import io
import json
import os
import re
import sys
import tarfile
import threading
from pathlib import Path

import pytest

import phytograph as pg
from phytograph import _download, backend as backend_mod
from conftest import E2E_FIXTURES, ROOT

pytestmark = pytest.mark.skipif(sys.platform == "win32", reason="the fake backend is a POSIX shell stub")
VERSION = pg.EXPECTED_BACKEND_VERSION


# ── a fake release ──────────────────────────────────────────────────────────

def _add_bytes(t: tarfile.TarFile, name: str, data: bytes, mode: int = 0o644) -> None:
    info = tarfile.TarInfo(name)
    info.size, info.mode = len(data), mode
    t.addfile(info, io.BytesIO(data))


def make_archive(out_dir: Path, *, version=VERSION, extra=None) -> Path:
    os_name, arch = _download.platform_key()
    name = _download.asset_name(version, os_name, arch)
    # The dev venv locally; CI has none and serves the backend from the
    # runner's own Python (see the "Scripting client tests" step in ci.yml).
    py = backend_mod._dev_python(ROOT) or Path(sys.executable)
    wrapper = ROOT / "backend-api" / "backend_wrapper.py"
    stub = f'#!/bin/sh\nexec "{py}" "{wrapper}" "$@"\n'.encode()
    dest = out_dir / name
    with tarfile.open(dest, "w:gz") as t:
        _add_bytes(t, _download.MANIFEST_NAME,
                   json.dumps({"version": version, "os": os_name, "arch": arch}).encode())
        _add_bytes(t, "resources/phytograph_backend/phytograph_backend", stub, 0o755)
        _add_bytes(t, "resources/phytograph_backend/phytograph_backend_version.txt", f"{version}\n".encode())
        _add_bytes(t, "resources/phytograph_backend/_internal/libreal.dylib", b"lib")
        link = tarfile.TarInfo("resources/phytograph_backend/_internal/liblink.dylib")
        link.type, link.linkname = tarfile.SYMTYPE, "libreal.dylib"     # in-bundle link, as PyInstaller makes
        t.addfile(link)
        t.add(ROOT / "resources" / "potree_converter", arcname="resources/potree_converter")
        for member, data in (extra or {}).items():
            _add_bytes(t, member, data)
    (out_dir / f"{name}.sha256").write_text(f"{hashlib.sha256(dest.read_bytes()).hexdigest()}  {name}\n")
    return dest


@pytest.fixture
def release(tmp_path, monkeypatch):
    """A release server: files under <root>/v<version>/, plus a request log."""
    root = tmp_path / "server"
    (root / f"v{VERSION}").mkdir(parents=True)
    requests = []

    class Handler(http.server.SimpleHTTPRequestHandler):
        def log_message(self, *a):
            pass

        def do_GET(self):
            requests.append(self.path)
            super().do_GET()

    srv = http.server.ThreadingHTTPServer(("127.0.0.1", 0), functools.partial(Handler, directory=str(root)))
    threading.Thread(target=srv.serve_forever, daemon=True).start()
    monkeypatch.setenv("PHYTOGRAPH_BACKEND_URL", f"http://127.0.0.1:{srv.server_address[1]}")
    monkeypatch.setenv("PHYTOGRAPH_BACKEND_CACHE", str(tmp_path / "cache"))
    monkeypatch.delenv("PHYTOGRAPH_BACKEND_EXE", raising=False)
    yield root / f"v{VERSION}", requests
    srv.shutdown()


# ── tests ───────────────────────────────────────────────────────────────────

def test_first_use_downloads_verifies_and_runs_then_reuses_the_cache(release, forest_plot):
    vdir, requests = release
    make_archive(vdir)
    with pg.Backend(source="download") as be:
        assert "downloaded backend" in be.description
        with be.open(forest_plot) as c:
            assert len(c) == 24498
    archive_gets = [r for r in requests if not r.endswith(".sha256")]
    assert len(archive_gets) == 1
    exe = _download.cached_executable()
    assert exe is not None and os.access(exe, os.X_OK)
    link = exe.parent / "_internal" / "liblink.dylib"
    assert link.is_symlink() and link.read_bytes() == b"lib"
    # Second launch: no network at all.
    requests.clear()
    with pg.Backend(source="download") as be:
        assert be.version == VERSION
    assert requests == []


def test_a_tampered_archive_is_refused_and_nothing_is_installed(release):
    vdir, _ = release
    good = make_archive(vdir)
    data = bytearray(good.read_bytes())
    data[len(data) // 2] ^= 0xFF
    good.write_bytes(bytes(data))           # .sha256 still describes the original
    with pytest.raises(pg.BackendNotFound, match="integrity check"):
        _download.install()
    assert _download.cached_executable() is None
    assert not any(_download.cache_root().glob(f"{VERSION}-*"))


def test_an_embedded_digest_overrides_the_server(release, monkeypatch):
    """A PyPI wheel pins the bytes: a server-side .sha256 that agrees with a
    swapped archive must not be enough."""
    vdir, requests = release
    archive = make_archive(vdir)
    monkeypatch.setattr(_download, "embedded_digests", lambda: {archive.name: "0" * 64})
    with pytest.raises(pg.BackendNotFound, match="integrity check"):
        _download.install()
    assert not any(r.endswith(".sha256") for r in requests)


def test_an_unpublished_version_says_what_to_do(release):
    with pytest.raises(pg.BackendNotFound) as e:
        _download.install()
    msg = str(e.value)
    assert "two newest releases" in msg and "pip install -U phytograph" in msg


def test_an_archive_copied_by_hand_installs_with_no_network(release, tmp_path, monkeypatch):
    """The HPC / air-gapped path: archive + its .sha256 copied over, and the
    release server unreachable."""
    vdir, requests = release
    archive = make_archive(vdir)
    offline = tmp_path / "usb"
    offline.mkdir()
    for f in (archive, vdir / f"{archive.name}.sha256"):
        (offline / f.name).write_bytes(f.read_bytes())
    monkeypatch.setenv("PHYTOGRAPH_BACKEND_URL", "http://127.0.0.1:9")   # nothing listens
    exe = _download.install(archive=offline / archive.name)
    assert exe == _download.cached_executable()
    assert requests == []


def test_an_archive_without_its_digest_is_not_trusted(release, tmp_path, monkeypatch):
    vdir, _ = release
    archive = make_archive(vdir)
    lone = tmp_path / archive.name
    lone.write_bytes(archive.read_bytes())
    monkeypatch.setenv("PHYTOGRAPH_BACKEND_URL", "http://127.0.0.1:9")
    with pytest.raises(pg.BackendNotFound):
        _download.install(archive=lone)
    assert _download.cached_executable() is None
    with pytest.raises(pg.BackendNotFound, match="No archive at"):
        _download.install(archive=tmp_path / "missing" / archive.name)


@pytest.mark.parametrize("member, linkname, why", [
    ("../escape.txt", None, "unsafe path"),
    ("/abs.txt", None, "unsafe path"),
    ("resources/x", "../../../etc/passwd", "link out"),
    ("resources/y", "/etc/passwd", "absolute link"),
])
def test_unsafe_archive_entries_are_refused(release, member, linkname, why):
    vdir, _ = release
    archive = make_archive(vdir)
    with tarfile.open(archive, "r:gz") as src:
        members = [(m, src.extractfile(m).read() if m.isfile() else None) for m in src.getmembers()]
    with tarfile.open(archive, "w:gz") as t:
        for m, data in members:
            t.addfile(m, io.BytesIO(data) if data is not None else None)
        bad = tarfile.TarInfo(member)
        if linkname:
            bad.type, bad.linkname = tarfile.SYMTYPE, linkname
            t.addfile(bad)
        else:
            bad.size = 1
            t.addfile(bad, io.BytesIO(b"x"))
    (vdir / f"{archive.name}.sha256").write_text(
        f"{hashlib.sha256(archive.read_bytes()).hexdigest()}  {archive.name}\n")
    with pytest.raises(pg.BackendNotFound, match=why):
        _download.install()
    assert _download.cached_executable() is None


def test_an_installed_app_of_another_version_is_passed_over(release, tmp_path, monkeypatch):
    vdir, _ = release
    make_archive(vdir)
    app_exe = tmp_path / "OldApp" / "resources" / "phytograph_backend" / "phytograph_backend"
    app_exe.parent.mkdir(parents=True)
    app_exe.write_text("#!/bin/sh\nexit 1\n")
    (app_exe.parent / "phytograph_backend_version.txt").write_text("0.1.0\n")
    monkeypatch.setattr(backend_mod, "_installed_app_candidates", lambda: [app_exe])
    monkeypatch.setattr(backend_mod, "_repo_root", lambda: None)   # as for a pip install
    argv, _, _, desc = backend_mod._resolve_command("auto", None)
    assert "downloaded backend" in desc and str(app_exe) not in argv
    # An app of THIS version is used as-is, with no download.
    (app_exe.parent / "phytograph_backend_version.txt").write_text(f"{VERSION}\n")
    assert backend_mod._resolve_command("auto", None)[0] == [str(app_exe)]


def test_glibc_floor_matches_the_measured_linux_floor():
    src = (ROOT / "scripts" / "glibc-floor.mjs").read_text()
    floor = re.search(r"GLIBC_FLOOR = '([\d.]+)'", src).group(1)
    assert _download.LINUX_GLIBC_FLOOR == tuple(int(x) for x in floor.split("."))


def test_asset_names_cover_the_release_matrix():
    workflow = (ROOT / ".github" / "workflows" / "release.yml").read_text()
    for os_name, arch in _download.SUPPORTED:
        name = _download.asset_name(VERSION, os_name, arch)
        assert name.endswith(".zip" if os_name == "windows" else ".tar.gz")
    # The matrix has exactly these four (platform, arch) jobs.
    assert len(re.findall(r"^\s+- platform: ", workflow, re.M)) == len(_download.SUPPORTED)


def test_release_wheel_pins_every_platform(tmp_path):
    sys.path.insert(0, str(ROOT / "python"))
    import build_wheel
    names = [_download.asset_name(VERSION, o, a) for o, a in _download.SUPPORTED]
    digests = {n: hashlib.sha256(n.encode()).hexdigest() for n in names}
    with pytest.raises(SystemExit, match="no backend digest"):
        build_wheel.build(tmp_path / "a", backend_digests=dict(list(digests.items())[:3]),
                          require_platforms=True)
    whl = build_wheel.build(tmp_path / "b", backend_digests=digests, require_platforms=True)
    import zipfile
    with zipfile.ZipFile(whl) as z:
        manifest = json.loads(z.read("phytograph/_backend_manifest.json"))
    assert manifest == {"version": VERSION, "sha256": dict(sorted(digests.items()))}


@pytest.mark.skipif(not os.environ.get("PHYTOGRAPH_TEST_REAL_ARCHIVE"),
                    reason="opt-in: packs and extracts the real ~1 GB bundle (set PHYTOGRAPH_TEST_REAL_ARCHIVE=1)")
def test_real_bundle_archive(release, forest_plot, tmp_path):
    """The shipped PyInstaller bundle, packed by the release packer, run from
    the download cache — no app, no venv."""
    vdir, _ = release
    sys.path.insert(0, str(ROOT / "python"))
    import pack_backend
    pack_backend.pack(vdir)
    with pg.Backend(source="download") as be:
        assert "downloaded backend" in be.description
        with be.open(forest_plot) as c:
            c.segment_ground()
            assert len(c) == 24498 and "ground_class" in c.columns


def test_release_workflow_packs_signed_bytes_and_publishes_last():
    """Source-level pins on release.yml: each would fail silently otherwise.
    Packing before signing ships unsigned natives (Windows application control
    blocks them; issue #6); a wheel published before every platform's archive
    exists points some users at nothing."""
    wf = (ROOT / ".github" / "workflows" / "release.yml").read_text()
    pos = {name: wf.index(f"- name: {name}") for name in (
        "Sign Python backend (macOS)", "Sign PotreeConverter (macOS)",
        "Sign bundled native libraries (Windows)", "Package headless backend",
        "Build & publish app", "Upload headless backend to the release")}
    assert pos["Sign Python backend (macOS)"] < pos["Package headless backend"]
    assert pos["Sign PotreeConverter (macOS)"] < pos["Package headless backend"]
    assert pos["Sign bundled native libraries (Windows)"] < pos["Package headless backend"]
    assert pos["Build & publish app"] < pos["Upload headless backend to the release"]
    upload = wf[pos["Upload headless backend to the release"]:].split("- name:", 2)[1]
    assert "!inputs.dry_run" in upload
    wheel_job = wf[wf.index("  build-python-wheel:"):wf.index("  publish-pypi:")]
    assert "needs.build.result == 'success'" in wheel_job
    assert "--require-all-platforms" in wheel_job
    pypi_job = wf[wf.index("  publish-pypi:"):wf.index("  prune-old-releases:")]
    assert "!inputs.dry_run" in pypi_job and "id-token: write" in pypi_job


def test_pruning_also_removes_old_backend_archives():
    """Retention is 'newest two releases', like the installers (a decision, not
    an accident): the pruner's binary pattern must match the archive names."""
    src = (ROOT / "scripts" / "prune-release-assets.mjs").read_text()
    pattern = re.search(r"const BINARY_RE = /(.+)/i", src).group(1)
    for os_name, arch in _download.SUPPORTED:
        assert re.search(pattern, _download.asset_name(VERSION, os_name, arch), re.I)
