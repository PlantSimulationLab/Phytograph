"""The octree cache size cap must never delete an EDITED cloud's only copy.

`_evict_octree_cache` is a plain oldest-atime-first LRU over the cache root,
trimming it to `PHYTOGRAPH_OCTREE_CACHE_MAX_BYTES` (20 GB by default). That is
the right policy for an octree that is genuinely a cache — one whose cloud still
matches the file it was imported from, so a missing dir is silently rebuilt from
that file on demand.

It is the wrong policy the moment a cloud DIVERGES from its source. The first
bake/crop/filter/split edits the in-RAM session arrays and nothing rewrites the
file, so the source no longer describes the cloud; octree recovery
(`handleOctreeMissing` in the renderer) therefore refuses to rebuild a diverged
cloud from source rather than silently reverting the user's work. Evicting such
a dir to satisfy a size cap destroys that work, and surfaces as the dead-end
toast "Edited point cloud unavailable".

`keep` did not cover this: it only ever names the dirs the CURRENT operation just
wrote, so baking cloud B was free to evict edited cloud A's octree beside it.
Live sessions are now pinned unconditionally.
"""

import dataclasses
import os
import sys
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

import main  # noqa: E402
from main import _evict_octree_cache, _live_session_octree_ids  # noqa: E402

# 40-char hex, the only dir names the evictor considers.
IDS = [f"{i:040x}" for i in range(1, 8)]


@pytest.fixture
def cache_root(tmp_path, monkeypatch):
    root = tmp_path / "octrees"
    root.mkdir()
    monkeypatch.setenv("PHYTOGRAPH_OCTREE_CACHE_ROOT", str(root))
    return root


@pytest.fixture(autouse=True)
def no_live_sessions(monkeypatch):
    """Every test starts with an empty session table and cannot leak into others."""
    monkeypatch.setattr(main, "_cloud_sessions", {})
    return main._cloud_sessions


def make_octree(root: Path, cache_id: str, size: int, atime: float) -> Path:
    """A cache dir of a known size with a known access time (the LRU's sort key)."""
    d = root / cache_id
    d.mkdir()
    (d / "metadata.json").write_bytes(b"x" * size)
    os.utime(d, (atime, atime))
    return d


class _FakeSession:
    """Stands in for a live CloudSession.

    Only the two octree-id fields matter to the evictor, and building a real
    CloudSession would drag in full point arrays. `test_session_field_names`
    below pins the field names against the real dataclass, so a rename breaks
    this file rather than silently making every assertion here vacuous.
    """

    def __init__(self, octree_cache_id=None, miss_octree_cache_id=None):
        self.octree_cache_id = octree_cache_id
        self.miss_octree_cache_id = miss_octree_cache_id


def test_session_field_names_match_the_real_dataclass():
    """Guard the stub above against a field rename on CloudSession."""
    names = {f.name for f in dataclasses.fields(main.CloudSession)}
    assert {"octree_cache_id", "miss_octree_cache_id"} <= names


def test_trims_oldest_first_to_the_cap(cache_root):
    """Baseline: the LRU still works, so the pinning tests below mean something."""
    make_octree(cache_root, IDS[0], 100, atime=1000.0)  # oldest
    make_octree(cache_root, IDS[1], 100, atime=2000.0)
    make_octree(cache_root, IDS[2], 100, atime=3000.0)  # newest

    evicted = _evict_octree_cache(max_bytes=250)

    assert evicted == [IDS[0]]
    assert not (cache_root / IDS[0]).exists()
    assert (cache_root / IDS[1]).exists()
    assert (cache_root / IDS[2]).exists()


def test_under_the_cap_evicts_nothing(cache_root):
    make_octree(cache_root, IDS[0], 100, atime=1000.0)
    assert _evict_octree_cache(max_bytes=10_000) == []
    assert (cache_root / IDS[0]).exists()


def test_keep_protects_the_dir_just_written(cache_root):
    """The pre-existing guarantee: a fresh convert never drops itself."""
    fresh = make_octree(cache_root, IDS[0], 300, atime=1000.0)  # oldest AND biggest
    make_octree(cache_root, IDS[1], 100, atime=2000.0)

    evicted = _evict_octree_cache(max_bytes=350, keep=fresh)

    assert evicted == [IDS[1]]
    assert fresh.exists()


def test_live_session_octree_is_never_evicted(cache_root, no_live_sessions):
    """THE REGRESSION.

    An edited cloud's octree is the oldest entry and the cache is over cap, but a
    live session is still rendering from it — evicting it would destroy edits
    that exist nowhere else. The younger, unpinned entry goes instead.
    """
    edited = make_octree(cache_root, IDS[0], 200, atime=1000.0)   # oldest
    disposable = make_octree(cache_root, IDS[1], 200, atime=9000.0)  # newest
    no_live_sessions["sess-a"] = _FakeSession(octree_cache_id=IDS[0])

    evicted = _evict_octree_cache(max_bytes=250)

    assert evicted == [IDS[1]]
    assert edited.exists(), "evicting a live session's octree destroys unsaved edits"
    assert not disposable.exists()


def test_live_session_miss_octree_is_pinned_too(cache_root, no_live_sessions):
    """The sky/miss shell is a second dir owned by the same session."""
    hits = make_octree(cache_root, IDS[0], 200, atime=1000.0)
    misses = make_octree(cache_root, IDS[1], 200, atime=1100.0)
    spare = make_octree(cache_root, IDS[2], 200, atime=9000.0)
    no_live_sessions["sess-a"] = _FakeSession(
        octree_cache_id=IDS[0], miss_octree_cache_id=IDS[1]
    )

    evicted = _evict_octree_cache(max_bytes=450)

    assert evicted == [IDS[2]]
    assert hits.exists() and misses.exists()
    assert not spare.exists()


def test_stays_over_cap_rather_than_evicting_live_sessions(cache_root, no_live_sessions):
    """The deliberate trade.

    Overshooting a cap on regenerable disk is recoverable; deleting the only copy
    of an edit is not. When everything left is pinned, eviction gives up.
    """
    for i, cid in enumerate(IDS[:3]):
        make_octree(cache_root, cid, 500, atime=1000.0 + i)
        no_live_sessions[f"sess-{i}"] = _FakeSession(octree_cache_id=cid)

    evicted = _evict_octree_cache(max_bytes=100)

    assert evicted == []
    assert all((cache_root / cid).exists() for cid in IDS[:3])


def test_a_session_with_no_octree_pins_nothing(cache_root, no_live_sessions):
    """A session whose octree is stale (`octree_cache_id = None`, e.g. after an
    unbaked edit) must not accidentally pin — or block — anything."""
    make_octree(cache_root, IDS[0], 200, atime=1000.0)
    make_octree(cache_root, IDS[1], 200, atime=2000.0)
    no_live_sessions["sess-a"] = _FakeSession(octree_cache_id=None)

    assert _live_session_octree_ids() == set()
    assert _evict_octree_cache(max_bytes=250) == [IDS[0]]


def test_live_session_ids_snapshot_both_fields(no_live_sessions):
    no_live_sessions["a"] = _FakeSession(octree_cache_id=IDS[0], miss_octree_cache_id=IDS[1])
    no_live_sessions["b"] = _FakeSession(octree_cache_id=IDS[2])
    assert _live_session_octree_ids() == {IDS[0], IDS[1], IDS[2]}
