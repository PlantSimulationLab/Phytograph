"""The octree cache size cap must never delete an EDITED cloud's only copy.

`_evict_octree_cache` is a plain least-recently-used-first LRU over the cache
root, ranked on each entry's MTIME (see `_touch_octree_dir` for why not atime),
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


def make_octree(root: Path, cache_id: str, size: int, used: float) -> Path:
    """A cache dir of a known size and a known last-used time (the LRU's key).

    The key is the directory's MTIME. It used to be its atime, which cannot
    work: the evictor's own size walk lists every entry, and listing a directory
    sets its atime — so one pass flattened the whole ordering. On a managed
    Windows box a planted atime did not even survive a second of background
    scanning, which is why this file's baseline test failed at random.
    """
    d = root / cache_id
    d.mkdir()
    (d / "metadata.json").write_bytes(b"x" * size)
    os.utime(d, (used, used))
    return d


class _FakeSession:
    """Stands in for a live CloudSession.

    Only the two octree-id fields matter to the evictor, and building a real
    CloudSession would drag in full point arrays. `test_session_field_names`
    below pins the field names against the real dataclass, so a rename breaks
    this file rather than silently making every assertion here vacuous.
    """

    def __init__(self, octree_cache_id=None, miss_octree_cache_id=None,
                 rendered_octree_cache_id=None):
        self.octree_cache_id = octree_cache_id
        self.miss_octree_cache_id = miss_octree_cache_id
        self.rendered_octree_cache_id = rendered_octree_cache_id


def test_session_field_names_match_the_real_dataclass():
    """Guard the stub above against a field rename on CloudSession."""
    names = {f.name for f in dataclasses.fields(main.CloudSession)}
    assert {
        "octree_cache_id",
        "miss_octree_cache_id",
        "rendered_octree_cache_id",
    } <= names


def test_trims_oldest_first_to_the_cap(cache_root):
    """Baseline: the LRU still works, so the pinning tests below mean something."""
    make_octree(cache_root, IDS[0], 100, used=1000.0)  # oldest
    make_octree(cache_root, IDS[1], 100, used=2000.0)
    make_octree(cache_root, IDS[2], 100, used=3000.0)  # newest

    evicted = _evict_octree_cache(max_bytes=250)

    assert evicted == [IDS[0]]
    assert not (cache_root / IDS[0]).exists()
    assert (cache_root / IDS[1]).exists()
    assert (cache_root / IDS[2]).exists()


def test_under_the_cap_evicts_nothing(cache_root):
    make_octree(cache_root, IDS[0], 100, used=1000.0)
    assert _evict_octree_cache(max_bytes=10_000) == []
    assert (cache_root / IDS[0]).exists()


def test_keep_protects_the_dir_just_written(cache_root):
    """The pre-existing guarantee: a fresh convert never drops itself."""
    fresh = make_octree(cache_root, IDS[0], 300, used=1000.0)  # oldest AND biggest
    make_octree(cache_root, IDS[1], 100, used=2000.0)

    evicted = _evict_octree_cache(max_bytes=350, keep=fresh)

    assert evicted == [IDS[1]]
    assert fresh.exists()


def test_live_session_octree_is_never_evicted(cache_root, no_live_sessions):
    """THE REGRESSION.

    An edited cloud's octree is the oldest entry and the cache is over cap, but a
    live session is still rendering from it — evicting it would destroy edits
    that exist nowhere else. The younger, unpinned entry goes instead.
    """
    edited = make_octree(cache_root, IDS[0], 200, used=1000.0)   # oldest
    disposable = make_octree(cache_root, IDS[1], 200, used=9000.0)  # newest
    no_live_sessions["sess-a"] = _FakeSession(octree_cache_id=IDS[0])

    evicted = _evict_octree_cache(max_bytes=250)

    assert evicted == [IDS[1]]
    assert edited.exists(), "evicting a live session's octree destroys unsaved edits"
    assert not disposable.exists()


def test_live_session_miss_octree_is_pinned_too(cache_root, no_live_sessions):
    """The sky/miss shell is a second dir owned by the same session."""
    hits = make_octree(cache_root, IDS[0], 200, used=1000.0)
    misses = make_octree(cache_root, IDS[1], 200, used=1100.0)
    spare = make_octree(cache_root, IDS[2], 200, used=9000.0)
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
        make_octree(cache_root, cid, 500, used=1000.0 + i)
        no_live_sessions[f"sess-{i}"] = _FakeSession(octree_cache_id=cid)

    evicted = _evict_octree_cache(max_bytes=100)

    assert evicted == []
    assert all((cache_root / cid).exists() for cid in IDS[:3])


def test_a_session_with_no_octree_at_all_pins_nothing(cache_root, no_live_sessions):
    """A session holding no octree id of any kind must not pin — or block —
    anything. (An unbaked edit is NOT this case: it keeps the drawn id in
    `rendered_octree_cache_id`; see the tests below.)"""
    make_octree(cache_root, IDS[0], 200, used=1000.0)
    make_octree(cache_root, IDS[1], 200, used=2000.0)
    no_live_sessions["sess-a"] = _FakeSession(octree_cache_id=None)

    assert _live_session_octree_ids() == set()
    assert _evict_octree_cache(max_bytes=250) == [IDS[0]]


def test_the_octree_a_cropped_cloud_is_still_drawn_from_is_pinned(cache_root, no_live_sessions):
    """THE SECOND REGRESSION, and the one an instant crop widened.

    `delete_region` clears `octree_cache_id` because the cached octree no longer
    describes the session's points. But the renderer does not stop drawing it —
    it keeps streaming from that directory and hides the deleted points with a
    clip volume / per-tile mask, which is what makes an applied delete instant.
    Between the delete and the rebuild, the only eviction pin was gone, so the
    next convert could delete the directory a visible cloud was rendering from.

    Crop now leans on that window deliberately (its octree rebuild runs in the
    background), so the pin is load-bearing rather than theoretical.
    """
    drawn = make_octree(cache_root, IDS[0], 200, used=1000.0)   # oldest
    disposable = make_octree(cache_root, IDS[1], 200, used=9000.0)
    no_live_sessions["sess-a"] = _FakeSession(
        octree_cache_id=None, rendered_octree_cache_id=IDS[0]
    )

    evicted = _evict_octree_cache(max_bytes=250)

    assert evicted == [IDS[1]]
    assert drawn.exists(), "evicted the octree a live cropped cloud is rendering from"
    assert not disposable.exists()


def test_mark_octree_stale_keeps_the_first_drawn_id(no_live_sessions):
    """Two deletes before any rebuild: the pin must stay on the octree actually
    on screen, which is the one from BEFORE the first delete."""
    sess = _FakeSession(octree_cache_id=IDS[0])
    main._mark_octree_stale_locked(sess)
    assert sess.octree_cache_id is None
    assert sess.rendered_octree_cache_id == IDS[0]
    # A second delete has no current id to promote and must not clear the pin.
    main._mark_octree_stale_locked(sess)
    assert sess.rendered_octree_cache_id == IDS[0]


def test_live_session_ids_snapshot_every_field(no_live_sessions):
    no_live_sessions["a"] = _FakeSession(octree_cache_id=IDS[0], miss_octree_cache_id=IDS[1])
    no_live_sessions["b"] = _FakeSession(octree_cache_id=IDS[2])
    no_live_sessions["c"] = _FakeSession(rendered_octree_cache_id=IDS[3])
    assert _live_session_octree_ids() == {IDS[0], IDS[1], IDS[2], IDS[3]}


class TestTheKeySurvivesBeingRead:
    """The LRU's sort key must not be destroyed by the act of ranking on it.

    This is why the key is mtime and not atime, and it is worth a test rather
    than a comment because the atime version LOOKED correct: every assertion
    above passed with it, because each of those tests plants its times and
    evicts once. The damage only shows on the SECOND pass.
    """

    def test_an_under_cap_pass_does_not_disturb_the_ordering(self, cache_root):
        """The pass that deletes nothing is the one that proved the old bug: it
        walks every entry to total the cache, and with atime that walk alone
        reset every entry to `now`.

        RECENCY RUNS OPPOSITE TO NAME ORDER here, and that is the whole point.
        A flattened key degenerates to whatever the filesystem enumerates
        first — sha1 order — so a test that plants oldest-first in ascending
        name order agrees with the broken behaviour by accident and proves
        nothing. These four are planted newest-first.
        """
        for i, cid in enumerate(IDS[:4]):
            make_octree(cache_root, cid, 100, used=4000.0 - i * 1000.0)

        assert _evict_octree_cache(max_bytes=10**9) == []

        # IDS[3] is the OLDEST and the LAST by name.
        assert _evict_octree_cache(max_bytes=350) == [IDS[3]]

    def test_eviction_order_is_stable_across_repeated_passes(self, cache_root):
        """Evict one at a time, three times over, again with recency opposite to
        name order. With the atime key the first pass flattened everything that
        survived it and the later passes fell back to enumeration order."""
        for i, cid in enumerate(IDS[:4]):
            make_octree(cache_root, cid, 100, used=4000.0 - i * 1000.0)

        assert _evict_octree_cache(max_bytes=350) == [IDS[3]]
        assert _evict_octree_cache(max_bytes=250) == [IDS[2]]
        assert _evict_octree_cache(max_bytes=150) == [IDS[1]]
        assert sorted(p.name for p in cache_root.iterdir()) == [IDS[0]]

    def test_reading_a_file_inside_an_entry_is_not_a_use(self, cache_root):
        """Not a preference — a statement of what the filesystem gives us.

        The renderer streams `app://octree/<sha1>/<file>`, which opens a file
        INSIDE the directory and so cannot move the directory's own timestamp.
        Recency is therefore recorded deliberately by `_touch_octree_dir`, and a
        future change that tries to infer it from reads will fail here.
        """
        d = make_octree(cache_root, IDS[0], 100, used=1000.0)
        (d / "octree.bin").write_bytes(b"y" * 100)
        os.utime(d, (1000.0, 1000.0))
        before = d.stat().st_mtime

        (d / "octree.bin").read_bytes()

        assert d.stat().st_mtime == before


class TestAdoptingAnEntryRefreshesIt:
    """Recency comes from adoption, because that is the only use the backend can
    see: a cache HIT, or a reuse that skips the build entirely."""

    #: A parseable metadata.json padded out to a known size, so the cap
    #: arithmetic in these tests reads the same way as in the ones above.
    _META = (
        '{"boundingBox": {"min": [0,0,0], "max": [1,1,1]}, "attributes": [],'
        ' "_pad": "%s"}'
    )

    def _installed(self, root, cache_id, used, size=200):
        d = make_octree(root, cache_id, 0, used=used)
        text = self._META % ("x" * max(0, size - len(self._META % "")))
        (d / "metadata.json").write_text(text)
        os.utime(d, (used, used))
        return d

    def test_reading_metadata_marks_the_entry_used(self, cache_root):
        d = self._installed(cache_root, IDS[0], 1000.0)
        assert d.stat().st_mtime == 1000.0

        main._read_octree_metadata_and_mark_used(d)

        assert d.stat().st_mtime > 1000.0

    def test_the_plain_reader_does_not(self, cache_root):
        """So the wrapper is doing the work, not some incidental write."""
        d = self._installed(cache_root, IDS[0], 1000.0)
        main._read_octree_metadata(d)
        assert d.stat().st_mtime == 1000.0

    def test_an_adopted_entry_outlives_an_older_untouched_one(self, cache_root):
        """The end-to-end property: reuse protects an entry from the cap."""
        old = self._installed(cache_root, IDS[0], 1000.0)
        self._installed(cache_root, IDS[1], 2000.0)

        main._read_octree_metadata_and_mark_used(old)   # a cache hit on the older one

        evicted = _evict_octree_cache(max_bytes=250)
        assert evicted == [IDS[1]], "the entry nobody asked for should have gone"
        assert old.is_dir()

    def test_a_vanished_entry_does_not_fail_the_caller(self, cache_root):
        """A concurrent eviction between the read and the stamp costs a recency
        mark, which is recoverable; raising would fail an import over it."""
        main._touch_octree_dir(cache_root / IDS[5])  # never existed


def test_every_adoption_of_a_cache_dir_marks_it_used():
    """Chokepoint. Reading an entry's metadata IS adopting it — no caller does
    so for any other reason — so a bare `_read_octree_metadata` outside the
    wrapper is an un-recorded use, and un-recorded uses are what make an LRU
    evict the thing you are about to want.
    """
    import ast
    import inspect

    tree = ast.parse(inspect.getsource(main))
    offenders = []
    for node in ast.walk(tree):
        if not isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef)):
            continue
        if node.name == "_read_octree_metadata_and_mark_used":
            continue  # the wrapper itself, which is where the raw call belongs
        for call in ast.walk(node):
            if (isinstance(call, ast.Call) and isinstance(call.func, ast.Name)
                    and call.func.id == "_read_octree_metadata"):
                offenders.append(node.name)
    assert offenders == [], (
        f"{sorted(set(offenders))} adopt an octree cache dir without marking it "
        f"used — call _read_octree_metadata_and_mark_used"
    )
