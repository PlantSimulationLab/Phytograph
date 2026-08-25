"""Backend half of the octree-cache-root parity guard.

The Python backend WRITES cached octrees; the Electron main process READS them
back through the app:// protocol handler. They silently disagreed on Windows
(%APPDATA% vs %LOCALAPPDATA%) and Linux, so every import on those platforms
built an octree the renderer could never fetch and the cloud never rendered
(GitHub issue #4). macOS agreed only by accident of a case-insensitive
filesystem, so dev and E2E — both macOS — never saw it.

src/shared/octreeCacheRoot.contract.json is the written-down truth. This module
asserts the Python resolver against it; src/main/octreeCacheRoot.test.ts asserts
the TypeScript resolver against the same file. Changing one implementation
without the other fails here or there.
"""

import json
import sys
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from main import _octree_cache_root  # noqa: E402

REPO_ROOT = Path(__file__).resolve().parents[2]
CONTRACT_PATH = REPO_ROOT / "src" / "shared" / "octreeCacheRoot.contract.json"

CONTRACT = json.loads(CONTRACT_PATH.read_text())
PLATFORMS = CONTRACT["platforms"]
OVERRIDE_ENV = CONTRACT["overrideEnv"]

# `sys.platform` values the backend actually sees, mapped to contract keys.
# Windows reports "win32"; Linux reports "linux" (the backend matches it as the
# else-branch, so any non-darwin non-win32 value lands there).
PLATFORM_IDS = {"darwin": "darwin", "win32": "win32", "linux": "linux"}

# Env vars that must be cleared so a developer's real environment can't make a
# mismatched implementation look correct.
ALL_BASE_ENVS = [OVERRIDE_ENV, "LOCALAPPDATA", "XDG_CACHE_HOME"]


def _expected_root(spec, env, home):
    """The contract's resolution rule, implemented straight from its prose."""
    from_env = env.get(spec["baseEnv"]) if spec["baseEnv"] else None
    base = Path(from_env) if from_env else Path(home).joinpath(*spec["baseHomeSegments"])
    return base.joinpath(*spec["segments"])


@pytest.fixture
def clean_env(monkeypatch):
    for name in ALL_BASE_ENVS:
        monkeypatch.delenv(name, raising=False)
    return monkeypatch


def _pin(monkeypatch, platform, home):
    monkeypatch.setattr(sys, "platform", platform)
    monkeypatch.setattr(Path, "home", staticmethod(lambda: Path(home)))


def test_contract_covers_every_platform():
    """Guard against the contract losing a platform and this suite asserting nothing."""
    assert sorted(PLATFORMS) == ["darwin", "linux", "win32"]


@pytest.mark.parametrize("platform", sorted(PLATFORM_IDS))
def test_matches_contract_without_base_env(clean_env, platform, tmp_path):
    spec = PLATFORMS[platform]
    home = tmp_path / "home"
    _pin(clean_env, PLATFORM_IDS[platform], home)

    root = _octree_cache_root()

    assert root == _expected_root(spec, {}, home)
    # The home fallback must genuinely be used, not silently skipped.
    assert str(root).startswith(str(home))


@pytest.mark.parametrize("platform", sorted(PLATFORM_IDS))
def test_honors_base_env(clean_env, platform, tmp_path):
    spec = PLATFORMS[platform]
    home = tmp_path / "home"
    _pin(clean_env, PLATFORM_IDS[platform], home)

    if not spec["baseEnv"]:
        # darwin has no base env: unrelated vars must not perturb the result.
        clean_env.setenv("LOCALAPPDATA", str(tmp_path / "ignored"))
        clean_env.setenv("XDG_CACHE_HOME", str(tmp_path / "also-ignored"))
        assert _octree_cache_root() == _expected_root(spec, {}, home)
        return

    base = tmp_path / "custom-base"
    clean_env.setenv(spec["baseEnv"], str(base))

    root = _octree_cache_root()

    assert root == _expected_root(spec, {spec["baseEnv"]: str(base)}, home)
    assert str(root).startswith(str(base))


@pytest.mark.parametrize("platform", sorted(PLATFORM_IDS))
def test_override_env_wins(clean_env, platform, tmp_path):
    """The supervisor pins this var when spawning the sidecar; it must win."""
    _pin(clean_env, PLATFORM_IDS[platform], tmp_path / "home")
    pinned = tmp_path / "pinned-by-supervisor"
    clean_env.setenv(OVERRIDE_ENV, str(pinned))
    clean_env.setenv("LOCALAPPDATA", str(tmp_path / "x"))
    clean_env.setenv("XDG_CACHE_HOME", str(tmp_path / "y"))

    assert _octree_cache_root() == pinned


def test_windows_cache_is_not_in_the_roaming_profile(clean_env, tmp_path):
    """The issue #4 regression in its own terms.

    A multi-gigabyte regenerable cache belongs in Local, never Roaming (which
    domain profiles sync). If a future 'fix' for a mismatch moves either side to
    the roaming user-data dir, this fails.
    """
    _pin(clean_env, "win32", tmp_path / "home")
    parts = _octree_cache_root().parts
    assert "Local" in parts
    assert "Roaming" not in parts
