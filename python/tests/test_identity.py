"""Engine identity without starting the engine (phytograph._identity)."""
from __future__ import annotations

import json
import re
import subprocess
import sys

import pytest

import phytograph as pg
from phytograph import _download, _identity
from conftest import ROOT


def _fake_bundle(tmp_path, *, lib="aa" * 32, sources="bb" * 32, digest="cc" * 32, stamp=True):
    install = tmp_path / "install"
    exe_dir = install / "resources" / "phytograph_backend"
    exe_dir.mkdir(parents=True)
    (exe_dir / "phytograph_backend").write_text("#!/bin/sh\n")
    if stamp:
        (exe_dir / _identity.IDENTITY_FILE).write_text(json.dumps({
            "schema": 1, "engine_version": pg.EXPECTED_BACKEND_VERSION,
            "sources_sha256": sources, "libhelios_sha256": lib,
            "pyhelios": {"describe": "v0.1.41", "commit": "1" * 40},
            "helios_core": {"describe": "v1.3.96", "commit": "2" * 40},
            "python": "3.11.15", "packages": {"numpy": "2.3.5"}, "os": "darwin", "arch": "arm64"}))
    else:
        (exe_dir / _identity.VERSION_STAMP).write_text(pg.EXPECTED_BACKEND_VERSION + "\n")
        (exe_dir / _identity.SOURCES_STAMP).write_text(sources + "\n")
        (exe_dir / _identity.LIBHELIOS_STAMP).write_text(lib + "\n")
    if digest:
        (install / ".complete").write_text(digest + "\n")
    return exe_dir


def test_bundle_identity_reads_the_stamp_and_the_archive_digest(tmp_path):
    ident = _identity.bundle_identity(_fake_bundle(tmp_path))
    assert ident["source"] == "bundle"
    assert ident["libhelios_sha256"] == "aa" * 32
    assert ident["helios_core"]["describe"] == "v1.3.96"
    assert ident["archive_sha256"] == "cc" * 32
    assert re.fullmatch(r"[0-9a-f]{64}", ident["key"])


def test_a_rebuilt_libhelios_changes_the_key_without_a_version_change(tmp_path):
    a = _identity.bundle_identity(_fake_bundle(tmp_path / "a"))
    b = _identity.bundle_identity(_fake_bundle(tmp_path / "b", lib="dd" * 32))
    assert a["engine_version"] == b["engine_version"]
    assert a["key"] != b["key"]


def test_the_key_ignores_where_the_bundle_is_and_how_it_got_there(tmp_path):
    """The same build from the app (no archive) and from a download share a key."""
    a = _identity.bundle_identity(_fake_bundle(tmp_path / "a"))
    b = _identity.bundle_identity(_fake_bundle(tmp_path / "b", digest=None))
    assert a["location"] != b["location"] and b["archive_sha256"] is None
    assert a["key"] == b["key"]


def test_a_bundle_without_the_identity_stamp_falls_back_to_the_plain_stamps(tmp_path):
    ident = _identity.bundle_identity(_fake_bundle(tmp_path, stamp=False))
    assert ident["schema"] == 0
    assert ident["libhelios_sha256"] == "aa" * 32
    assert ident["engine_version"] == pg.EXPECTED_BACKEND_VERSION


def test_engine_identity_never_downloads(tmp_path, monkeypatch):
    monkeypatch.setenv("PHYTOGRAPH_BACKEND_CACHE", str(tmp_path / "empty"))
    monkeypatch.delenv("PHYTOGRAPH_BACKEND_EXE", raising=False)
    monkeypatch.delenv(_download.OFFLINE_ENV, raising=False)

    def no_network(*a, **k):
        raise AssertionError("engine_identity() tried the network")
    monkeypatch.setattr(_download, "_http_get", no_network)
    with pytest.raises(pg.BackendNotFound, match="Offline mode"):
        pg.engine_identity(source="download")


def test_engine_identity_of_an_explicit_bundle(tmp_path, monkeypatch):
    exe_dir = _fake_bundle(tmp_path)
    monkeypatch.setenv("PHYTOGRAPH_BACKEND_EXE", str(exe_dir / "phytograph_backend"))
    ident = pg.engine_identity()
    assert ident["libhelios_sha256"] == "aa" * 32 and ident["archive_sha256"] == "cc" * 32


def test_package_list_matches_the_build_stamp():
    mjs = (ROOT / "scripts" / "backend-identity.mjs").read_text()
    block = re.search(r"const PACKAGES = \[(.*?)\];", mjs, re.S).group(1)
    assert tuple(re.findall(r"'([^']+)'", block)) == _identity.PACKAGES


def test_dev_identity_and_the_cli_agree():
    proc = subprocess.run([sys.executable, "-m", "phytograph", "identity", "--json", "--source", "dev"],
                          capture_output=True, text=True, timeout=120, cwd=ROOT / "python")
    assert proc.returncode == 0, proc.stderr
    cli = json.loads(proc.stdout)
    assert cli["source"] == "dev"
    assert cli["engine_version"] == pg.EXPECTED_BACKEND_VERSION
    assert re.fullmatch(r"[0-9a-f]{64}", cli["libhelios_sha256"] or "0" * 64)
    assert cli["helios_core"]["commit"]
    assert cli["packages"]["numpy"]
    assert cli["key"] == pg.engine_identity(source="dev")["key"]


def test_a_backend_reports_the_identity_it_was_launched_from(backend):
    ident = backend.identity
    assert ident is not None and ident["source"] == "dev"
    assert ident["key"] == pg.engine_identity(source="dev")["key"]
