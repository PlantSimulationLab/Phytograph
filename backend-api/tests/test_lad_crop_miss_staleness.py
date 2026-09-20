"""A crop before LAD must not invalidate a backfilled miss buffer.

Cropping a scan down to one tree is the normal prelude to a per-tree LAD, and it
deletes a great many hits. The miss buffer was gap-filled against the pre-crop
hits, so a naive reading calls it stale and asks the user to re-run Backfill.
Both halves of that are wrong, and this file pins why:

  * A deleted hit OUTSIDE the voxel grid is restored to the inversion
    (`_session_to_lad_arrays(restore_mask=...)`), so the beam population the
    buffer was computed against is intact and the buffer is exact. LAD clears
    the stale flag itself in that case.
  * A deleted hit INSIDE the grid cannot be repaired — the return is either
    unplaceable or misplaced — so the flag survives and LAD warns. Re-running
    Backfill does NOT fix it (see test_backfill_misses.py: a re-run restores
    deleted hits and reproduces the measured scan), so the warning must not
    advise one.

The flag reaches the warning by a SECOND route that needs the opposite advice:
rows gone from the session outright (bake / split / extract, counted by
`unrestorable_hit_count`). Those cannot be restored, so gap-filling over what
remains re-creates the lost pulses as misses and a re-run IS the fix. The two
must not be conflated — see the last test.
"""

import time

import numpy as np
import pytest

import main


GRID = main.HeliosGrid(center=[0.0, 0.0, 0.0], size=[2.0, 2.0, 2.0],
                       nx=1, ny=1, nz=1)

# Two hits inside the 2 m box centred on the origin, two well outside it.
_POSITIONS = [
    [0.1, 0.1, 0.1],     # 0 inside
    [-0.4, 0.2, -0.3],   # 1 inside
    [10.0, 0.0, 0.0],    # 2 outside (beyond the grid)
    [-8.0, 0.0, 0.0],    # 3 outside (in front of the grid)
]


def _session(deleted_idx=(), with_buffer=True):
    n = len(_POSITIONS)
    sess = main.CloudSession(
        session_id=f"lad-crop-{'-'.join(map(str, deleted_idx)) or 'none'}",
        source_path="<test>",
        ascii_format=None,
        column_plan=None,
        positions=np.asarray(_POSITIONS, dtype=np.float64),
        colors=None,
        intensity=None,
        extras={"timestamp": np.asarray([1.0, 2.0, 3.0, 4.0], dtype=np.float32)},
        extra_dims_meta=[{"slug": "timestamp", "label": "Timestamp"}],
        deleted=np.zeros(n, dtype=bool),
        deleted_history=[],
        octree_cache_id=None,
        created_at=time.time(),
    )
    for i in deleted_idx:
        sess.deleted[i] = True
    if with_buffer:
        sess.backfilled_misses = {
            "positions": np.array([[0.0, 0.0, 900.0], [0.0, 900.0, 0.0]]),
            "directions": np.zeros((2, 3), dtype=np.float32),
        }
    return sess


def test_grid_masks_split_deletions_by_the_voxel_box():
    sess = _session(deleted_idx=(0, 2, 3))
    inside, outside = main._deleted_hit_grid_masks(sess, GRID)

    assert list(np.flatnonzero(inside)) == [0]
    assert list(np.flatnonzero(outside)) == [2, 3]
    # Point 1 was never deleted, so it is in neither set.
    assert not inside[1] and not outside[1]


def test_deletions_outside_the_grid_are_restored_to_the_inversion():
    """The beam that was extinguished outside the grid must still be traced, or
    LAD loses every pulse that crossed the grid and returned only beyond it."""
    sess = _session(deleted_idx=(2, 3))
    _inside, outside = main._deleted_hit_grid_masks(sess, GRID)

    xyz, _dirs, _labels, _vals, _flags = main._session_to_lad_arrays(
        sess, [0.0, 0.0, 5.0], include_backfilled=False, restore_mask=outside)

    # All four hits reach the inversion despite two being deleted.
    assert xyz.shape[0] == len(_POSITIONS)
    assert np.isclose(xyz, np.array([10.0, 0.0, 0.0])).all(axis=1).any()
    assert np.isclose(xyz, np.array([-8.0, 0.0, 0.0])).all(axis=1).any()


def test_deletions_inside_the_grid_are_not_restored():
    sess = _session(deleted_idx=(0,))
    _inside, outside = main._deleted_hit_grid_masks(sess, GRID)

    xyz, _dirs, _labels, _vals, _flags = main._session_to_lad_arrays(
        sess, [0.0, 0.0, 5.0], include_backfilled=False, restore_mask=outside)

    assert xyz.shape[0] == len(_POSITIONS) - 1
    assert not np.isclose(xyz, np.array([0.1, 0.1, 0.1])).all(axis=1).any()


@pytest.mark.parametrize("deleted_idx, expect_stale", [
    ((2, 3), False),   # crop around the grid — buffer stays exact
    ((0,), True),      # deleted a return from inside the grid — unrepairable
    ((0, 2), True),    # mixed: the inside deletion still spoils it
])
def test_stale_flag_survives_only_an_in_grid_deletion(deleted_idx, expect_stale):
    """The rule LAD applies before warning the user. A crop that only removes
    points outside the voxel grid must NOT warn — that is the common case, and
    telling the user to re-run Backfill there is both needless and misleading."""
    sess = _session(deleted_idx=deleted_idx)
    sess.backfilled_misses_stale = True  # set by delete_region on any crop

    inside, outside = main._deleted_hit_grid_masks(sess, GRID)
    _xyz, _dirs, _labels, _vals, flags = main._session_to_lad_arrays(
        sess, [0.0, 0.0, 5.0], restore_mask=outside)

    assert flags["misses_stale"] is True  # carried from the session
    # LAD's own rule (main.py, _do_lad_computation): every deletion restored and
    # nothing unrestorable => the pre-crop buffer still matches the hits it sees.
    n_in_grid = int(inside.sum())
    n_unrestorable = int(getattr(sess, "unrestorable_hit_count", 0) or 0)
    effective_stale = not (n_in_grid == 0 and n_unrestorable == 0)
    assert effective_stale is expect_stale


def test_lad_warning_does_not_advise_rerunning_backfill():
    """Re-running Backfill reconstructs the scan AS MEASURED (it restores deleted
    hits), so it cannot repair an in-grid deletion. The warning must not send the
    user down that path — the advice was actively harmful before this was fixed,
    since a re-run fed only survivors resurrects cropped pulses as sky misses."""
    import inspect

    src = inspect.getsource(main._do_lad_computation)
    # Anchor on the NOT-recoverable sub-branch specifically. Two others nearby
    # legitimately advise a re-run and must not be matched: `misses_moved` (a
    # transform really is repaired by recomputing) and the recoverable
    # sub-branch (rows gone from the session — gap-filling over what remains
    # re-creates the lost pulses as misses).
    start = src.index('# The rows are still present, just deleted inside the grid.')
    stale_warning = src[start:start + 900]
    lowered = stale_warning.lower()

    assert 'will not fix' in lowered, (
        "the in-grid-crop warning should say a Backfill re-run won't help")
    assert 're-run backfill misses on the cropped cloud' not in lowered


def test_stale_warning_distinguishes_recoverable_from_unrepairable():
    """`misses_stale` survives to the warning by TWO routes that need opposite
    advice, and conflating them is a regression this pins.

    * Rows GONE from the session (bake / split / extract, counted by
      `unrestorable_hit_count`): gap-filling over what remains re-creates the
      lost pulses as misses, so re-running Backfill IS the fix.
    * Rows still present but deleted INSIDE the voxel grid: Backfill restores
      deleted hits and reconstructs the scan as measured, so a re-run changes
      nothing and must not be advised.
    """
    import inspect

    src = inspect.getsource(main._do_lad_computation)
    start = src.index('elif scan_flags.get("misses_stale")')
    block = src[start:start + 1800]

    assert 'misses_stale_recoverable' in block, (
        "the two routes are no longer distinguished — one of them now carries "
        "advice that is wrong for the other")

    recoverable = block.index('if scan_flags.get("misses_stale_recoverable")')
    unrepairable = block.index('# The rows are still present, just deleted inside the grid.')
    assert recoverable < unrepairable

    recoverable_text = block[recoverable:unrepairable].lower()
    unrepairable_text = block[unrepairable:].lower()

    # The recoverable branch advises a re-run; the other explicitly does not.
    assert 're-run backfill misses' in recoverable_text
    assert 'will not fix' not in recoverable_text
    assert 'will not fix' in unrepairable_text
