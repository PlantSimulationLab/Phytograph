"""Installing a finished octree must survive a transient Windows handle.

`_build_octree_from_las` ends by renaming `<key>.staging` onto `<key>`. On
Windows that rename fails with PermissionError / WinError 5 whenever any process
holds a handle inside the directory, and on a managed machine something always
briefly does: Defender and the Search indexer open the octree's freshly written
files to scan them, and `_write_octree_labels` closes its sidecar microseconds
before the rename. A pre-existing `cache_dir` has the mirror-image problem — a
deleted-but-still-open file leaves the directory delete-pending, where it still
exists and cannot be renamed onto.

Reported from the field as a 5-position .riproject import that died on its last
position with

    PermissionError: [WinError 5] Access is denied:
      '...\octrees\f2bbba1b....staging' -> '...\octrees\f2bbba1b...'

after four positions had converted fine — i.e. transient, not a permissions
policy. The install now retries; the rename itself stays the atomic install, so
the CANCEL-SAFETY INVARIANT (a cache entry is absent or complete, never half)
is unchanged.
"""

import sys
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

import main  # noqa: E402


def _staged(tmp_path: Path) -> tuple[Path, Path]:
    staging = tmp_path / "abc123.staging"
    staging.mkdir()
    (staging / "metadata.json").write_text("{}")
    (staging / "octree.bin").write_bytes(b"\x00" * 16)
    return staging, tmp_path / "abc123"


def test_installs_normally(tmp_path):
    staging, cache_dir = _staged(tmp_path)
    main._install_octree_dir(staging, cache_dir)
    assert (cache_dir / "metadata.json").is_file()
    assert not staging.exists()


def test_retries_a_transient_access_denied(tmp_path, monkeypatch):
    """The exact field failure: the first renames raise, a later one wins."""
    staging, cache_dir = _staged(tmp_path)
    real_rename = Path.rename
    attempts = {"n": 0}

    def flaky(self, target):
        attempts["n"] += 1
        if attempts["n"] <= 3:
            raise PermissionError(13, "Access is denied", str(self), 5, str(target))
        return real_rename(self, target)

    monkeypatch.setattr(Path, "rename", flaky)
    monkeypatch.setattr(main, "_OCTREE_INSTALL_RETRY_SECONDS", 10.0)

    main._install_octree_dir(staging, cache_dir)

    assert attempts["n"] == 4
    assert (cache_dir / "metadata.json").is_file()


def test_retries_a_delete_pending_destination(tmp_path, monkeypatch):
    """rmtree of an existing cache_dir can fail the same way and also retries."""
    staging, cache_dir = _staged(tmp_path)
    cache_dir.mkdir()
    (cache_dir / "octree.bin").write_bytes(b"old")
    calls = {"n": 0}
    real_rmtree = main._shutil.rmtree

    def flaky(path, *a, **kw):
        calls["n"] += 1
        if calls["n"] <= 2:
            raise PermissionError(13, "Access is denied", str(path), 5)
        return real_rmtree(path, *a, **kw)

    monkeypatch.setattr(main._shutil, "rmtree", flaky)
    monkeypatch.setattr(main, "_OCTREE_INSTALL_RETRY_SECONDS", 10.0)

    main._install_octree_dir(staging, cache_dir)

    assert calls["n"] == 3
    assert (cache_dir / "octree.bin").read_bytes() != b"old"


def test_a_persistent_failure_still_raises_the_original_error(tmp_path, monkeypatch):
    """A genuinely locked-down cache root must report, not spin forever."""
    staging, cache_dir = _staged(tmp_path)

    def always(self, target):
        raise PermissionError(13, "Access is denied", str(self), 5, str(target))

    monkeypatch.setattr(Path, "rename", always)
    monkeypatch.setattr(main, "_OCTREE_INSTALL_RETRY_SECONDS", 0.2)

    with pytest.raises(PermissionError):
        main._install_octree_dir(staging, cache_dir)


def test_a_race_lost_to_another_process_is_a_success(tmp_path, monkeypatch):
    """Another PROCESS installing the same key wrote identical bytes, so an
    install that can never win is already satisfied — retrying it into an error
    would fail an import for a cache entry that is present and correct."""
    staging, cache_dir = _staged(tmp_path)

    def rival(self, target):
        # Whoever else was building this key finished first.
        Path(target).mkdir(exist_ok=True)
        (Path(target) / "metadata.json").write_text("{}")
        raise PermissionError(13, "Access is denied", str(self), 5, str(target))

    monkeypatch.setattr(Path, "rename", rival)
    monkeypatch.setattr(main, "_OCTREE_INSTALL_RETRY_SECONDS", 10.0)

    main._install_octree_dir(staging, cache_dir)

    assert (cache_dir / "metadata.json").is_file()
    assert not staging.exists()


def test_every_octree_install_uses_the_retrying_helper():
    """No `staging_dir.rename(cache_dir)` may be written by hand again.

    There are two places a finished octree is moved into the cache — the
    converter path (`_build_octree_from_las`) and the in-place translate
    (`_translate_octree_in_place`) — and both must retry, for the same reason.
    The second one is the more insidious: its `except Exception` turns a failed
    rename into a SILENT fall back to a full reconvert, the ~83 s on a 10 M-point
    scan that the fast path exists to avoid. Nothing surfaces; the transform is
    just mysteriously slow, and only on Windows, and only sometimes.
    """
    import re
    lines = Path(main.__file__).resolve().read_text(encoding="utf-8").splitlines()
    handwritten = []
    # Any way of moving a staging tree into a cache slot, not just the one
    # spelling the first cut looked for: `x.rename(y)`, `os.rename`, `os.replace`,
    # `shutil.move`, whenever a cache/staging dir is on the line.
    move = re.compile(r"(\.rename\(|os\.rename\(|os\.replace\(|shutil\.move\(|_shutil\.move\()")
    for i, line in enumerate(lines):
        if not move.search(line):
            continue
        if not any(tok in line for tok in ("cache_dir", "staging_dir", "staging")):
            continue
        for j in range(i, -1, -1):
            stripped = lines[j].lstrip()
            if stripped.startswith("def ") and (len(lines[j]) - len(stripped)) == 0:
                # The helper's own implementation is the one legitimate rename.
                if stripped.split("(")[0][4:] != "_install_octree_dir":
                    handwritten.append(f"{stripped.split('(')[0][4:]} (line {i + 1})")
                break
    assert not handwritten, (
        "these install an octree without the Windows retry; call "
        f"_install_octree_dir instead: {handwritten}"
    )
    joined = chr(10).join(lines)
    assert joined.count("_install_octree_dir(") >= 3, (
        "expected the definition plus both call sites"
    )


def test_a_complete_rival_install_is_never_touched(tmp_path, monkeypatch):
    """M1 from the independent review. The first cut only recognised a rival's
    finished install AFTER its own rmtree failed — by which point that rmtree
    could have half-deleted the rival's complete tree (rmtree stops at the first
    locked file; NTFS lists hierarchy.bin before octree.bin), leaving a
    metadata.json that passes the cache-hit gate over a directory the renderer
    can never stream from. The rival must be detected before anything is
    touched."""
    staging, cache_dir = _staged(tmp_path)
    cache_dir.mkdir()
    for name in ("metadata.json", "hierarchy.bin", "octree.bin"):
        (cache_dir / name).write_bytes(b"rival")
    # Captured BEFORE patching: `main._shutil` is the shutil module itself, so
    # patching its attribute would otherwise make "real" call the patch.
    real_rmtree = main._shutil.rmtree

    def guarded_rmtree(path, *a, **kw):
        # The helper may clean its OWN staging dir; the rival's tree is off limits.
        if Path(path) == staging:
            return real_rmtree(path, *a, **kw)
        raise AssertionError(f"rmtree touched {path}")

    def no_rename(self, target):
        raise AssertionError("rename attempted over a complete rival install")

    monkeypatch.setattr(main._shutil, "rmtree", guarded_rmtree)
    monkeypatch.setattr(Path, "rename", no_rename)

    main._install_octree_dir(staging, cache_dir)

    for name in ("metadata.json", "hierarchy.bin", "octree.bin"):
        assert (cache_dir / name).read_bytes() == b"rival"
    assert not staging.exists()


def test_a_delete_pending_probe_does_not_escape_the_retry(tmp_path, monkeypatch):
    """M2 from the review: on a delete-pending path Windows answers os.stat with
    ERROR_ACCESS_DENIED, and pathlib's is_file()/exists() do NOT swallow that
    errno — so a probe inside the except block threw straight out of the loop
    on the first attempt. Both probes are guarded now."""
    staging, cache_dir = _staged(tmp_path)
    real_rename = Path.rename
    real_is_file = Path.is_file
    real_exists = Path.exists
    real_rmtree = main._shutil.rmtree

    # A delete-pending directory, consistently: for two attempts EVERY probe on
    # it answers ERROR_ACCESS_DENIED — exists(), is_file() on its metadata, and
    # the rmtree the helper tries once it assumes the dir is still there. The
    # window closes on the rmtree (that is the operation Windows is waiting to
    # finish), after which the path is genuinely absent and the rename lands.
    window = {"left": 2}
    renames = {"n": 0}

    def denied(path):
        return PermissionError(13, "Access is denied", str(path), 5)

    def pending_exists(self):
        if self == cache_dir and window["left"] > 0:
            raise denied(self)
        return real_exists(self)

    def pending_is_file(self):
        if self.parent == cache_dir and self.name == "metadata.json" and window["left"] > 0:
            raise denied(self)
        return real_is_file(self)

    def pending_rmtree(path, *a, **kw):
        if Path(path) == cache_dir and window["left"] > 0:
            window["left"] -= 1
            raise denied(path)
        return real_rmtree(path, *a, **kw)

    def counting_rename(self, target):
        renames["n"] += 1
        return real_rename(self, target)

    monkeypatch.setattr(Path, "exists", pending_exists)
    monkeypatch.setattr(Path, "is_file", pending_is_file)
    monkeypatch.setattr(main._shutil, "rmtree", pending_rmtree)
    monkeypatch.setattr(Path, "rename", counting_rename)
    monkeypatch.setattr(main, "_OCTREE_INSTALL_RETRY_SECONDS", 10.0)

    main._install_octree_dir(staging, cache_dir)   # must not raise

    assert window["left"] == 0, "the helper gave up before the pending state cleared"
    assert renames["n"] == 1, "the rename must land exactly once, after the window"
    assert real_is_file(cache_dir / "metadata.json")
    assert not staging.exists()


def test_a_cancel_between_retries_unwinds(tmp_path, monkeypatch):
    """L3: a cancelled import must not sit out the full retry window."""
    import threading
    import time as _time
    staging, cache_dir = _staged(tmp_path)
    ev = threading.Event()

    def always(self, target):
        ev.set()
        raise PermissionError(13, "Access is denied", str(self), 5, str(target))

    monkeypatch.setattr(Path, "rename", always)
    monkeypatch.setattr(main, "_OCTREE_INSTALL_RETRY_SECONDS", 60.0)

    started = _time.time()
    with pytest.raises(main.ScanCancelled):
        main._install_octree_dir(staging, cache_dir, cancel_event=ev)
    assert _time.time() - started < 5.0
