"""Large-data thresholds must SCALE with the memory budget, not be constants.

`memory_budget`'s docstring claims "every large-cloud threshold in the backend
derives from this number; nothing else should hard-code a byte count". Three did
not, and each failed in BOTH directions at once - too eager on a workstation and
too late on a laptop - which is invisible on the 16 GB machine the app is
developed on because that is where the old constants were tuned:

- the DEM stream cutoff (a flat 5 M points, with the measured per-point cost
  sitting in the same file);
- the cloud-session COUNT cap (a flat 8, sitting next to a byte cap derived from
  the budget, so the two disagreed by an order of magnitude across machines);
- the session spill DISK cap (a flat 64 GiB, whose overflow DROPS a session -
  unrecoverable work for an edited cloud).

These assert the scaling RELATIONSHIP rather than the numbers, so retuning a
fraction does not break them, but reverting one to a constant does. 16 GB is
pinned as the case that must not change: it is what today's constants encode, so
a regression there would mean silently re-tuning every existing install.

Each derivation is a small pure function taking an explicit budget, which is why
this file needs no `importlib.reload(main)` -- reloading `main` rebuilds every
pydantic model class in it, and any other module still holding the old classes
then fails validation (it broke four unrelated triangulation tests that way).
"""
import main
import memory_budget as mb

GiB = mb.GiB


def _budget_for_ram(gib: float) -> int:
    """The budget a machine with this much RAM gets on the default fraction."""
    return int(gib * GiB * mb.DEFAULT_BUDGET_FRACTION)


def test_dem_stream_cutoff_scales_with_the_budget():
    laptop = main._dem_stream_min_points_for(_budget_for_ram(8))
    desktop = main._dem_stream_min_points_for(_budget_for_ram(16))
    workstation = main._dem_stream_min_points_for(_budget_for_ram(64))
    assert laptop < desktop < workstation, (
        "a flat point count streams needlessly on a big machine and too late on "
        "a small one; it must follow budget / _DEM_BYTES_PER_POINT"
    )
    # Proportional to the budget, which doubles with RAM.
    assert desktop == pytest_approx(laptop * 2)
    assert workstation == pytest_approx(desktop * 4)
    # And it is genuinely a function of the cost model, not a coincidence.
    assert desktop == int(_budget_for_ram(16) * main._DEM_STREAM_BUDGET_FRACTION
                          / main._DEM_BYTES_PER_POINT)


def test_dem_stream_cutoff_is_still_pinnable(monkeypatch):
    monkeypatch.setenv("PHYTOGRAPH_DEM_STREAM_MIN_POINTS", "1234567")
    assert main._dem_stream_min_points() == 1234567
    monkeypatch.delenv("PHYTOGRAPH_DEM_STREAM_MIN_POINTS")
    # Unpinned, it tracks the live budget.
    monkeypatch.setenv("PHYTOGRAPH_MEMORY_BUDGET_BYTES", str(8 * GiB))
    assert main._dem_stream_min_points() == main._dem_stream_min_points_for(8 * GiB)


def test_session_count_cap_scales_and_is_clamped():
    assert main._default_max_cloud_sessions(_budget_for_ram(8)) == 4, "low-end clamp"
    assert main._default_max_cloud_sessions(_budget_for_ram(16)) == 8, (
        "16 GB must keep today's value of 8: changing it would silently re-tune "
        "every existing install"
    )
    assert main._default_max_cloud_sessions(_budget_for_ram(32)) == 16
    assert main._default_max_cloud_sessions(_budget_for_ram(64)) == 32
    assert main._default_max_cloud_sessions(_budget_for_ram(512)) == 32, (
        "high-end clamp")


def test_session_count_cap_stays_an_int_attribute():
    # The eviction path reads it as a module attribute and ~30 tests monkeypatch
    # it directly; turning it into a callable would break all of them silently.
    assert isinstance(main._MAX_CLOUD_SESSIONS, int)
    assert main._MAX_CLOUD_SESSIONS >= main._SESSION_COUNT_MIN


def test_spill_disk_cap_scales_and_is_clamped():
    assert main._default_session_spill_max_bytes(_budget_for_ram(16)) == 64 * GiB, (
        "16 GB must keep today's flat 64 GiB"
    )
    assert main._default_session_spill_max_bytes(_budget_for_ram(8)) == 32 * GiB
    assert main._default_session_spill_max_bytes(_budget_for_ram(4)) == 16 * GiB, (
        "floor")
    assert main._default_session_spill_max_bytes(_budget_for_ram(512)) == 256 * GiB, (
        "ceiling")
    # The cap must stay well clear of the octree cache's 20 GB: these files ARE
    # the clouds, so trimming them is the failure the cap exists to postpone.
    assert main._default_session_spill_max_bytes(_budget_for_ram(8)) > 20 * GiB


def test_spill_disk_cap_is_still_pinnable(monkeypatch):
    monkeypatch.setenv("PHYTOGRAPH_SESSION_SPILL_MAX_BYTES", str(7 * GiB))
    assert main._session_spill_max_bytes() == 7 * GiB


def pytest_approx(value):
    import pytest
    return pytest.approx(value, rel=0.01)
