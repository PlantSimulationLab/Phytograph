"""The synthetic-scan memory budget must not contradict the process budget.

Two user-facing memory settings sat adjacent in Settings with near-identical
labels and were wholly independent: "Synthetic scan memory budget (MB)" went
straight to Helios's `setSyntheticScanMemoryBudget`, and "Memory budget (MB)"
went to `memory_budget`. Nothing reconciled them, so:

- pinning the process budget to 2 GB left the ray trace using Helios's 4 GiB
  (CPU) / 8 GiB (GPU) default -- the setting the user had actually touched was
  the one being ignored;
- asking for a 32 GB scan budget on an 8 GB machine was accepted in silence.

`_synthetic_scan_budget_bytes` reconciles both directions. It returns None only
when Helios's own default is already the tighter number, so this changes nothing
on a machine whose budget is the larger of the two.
"""
import pytest

import main
import memory_budget as mb

GiB = mb.GiB


@pytest.fixture
def budget(monkeypatch):
    def _set(gib: float):
        monkeypatch.setenv("PHYTOGRAPH_MEMORY_BUDGET_BYTES", str(int(gib * GiB)))
    return _set


@pytest.fixture(autouse=True)
def _cpu_host(monkeypatch):
    """Pin the Helios default to the CPU one, so the tests do not depend on
    whether the machine running them happens to have a CUDA GPU."""
    monkeypatch.setattr(main, "_HELIOS_SCAN_BUDGET_DEFAULT_GPU", 4 * GiB)
    monkeypatch.setattr(main, "_HELIOS_SCAN_BUDGET_DEFAULT_CPU", 4 * GiB)


def test_an_explicit_request_is_clamped_to_the_process_budget(budget):
    budget(8)
    # Under the budget: honoured exactly. The user asked for less, and less is
    # a legitimate thing to want (it bounds a single trace, not the machine).
    assert main._synthetic_scan_budget_bytes(2048) == 2 * GiB
    # Over the budget: clamped, rather than silently allocating past the number
    # the user set two fields above.
    assert main._synthetic_scan_budget_bytes(32768) == 8 * GiB


def test_a_tight_process_budget_overrides_helioss_larger_default(budget):
    # The direction that actually loses data: the user pins 2 GB and says nothing
    # about scans, so Helios would still have taken its 4 GiB default.
    budget(2)
    assert main._synthetic_scan_budget_bytes(None) == 2 * GiB


def test_a_generous_budget_leaves_helioss_default_alone(budget):
    # No override when the budget is the looser of the two: Helios owns its own
    # default, and returning a number here would quietly RAISE the scan's ceiling
    # on every machine with lots of RAM.
    budget(64)
    assert main._synthetic_scan_budget_bytes(None) is None


def test_zero_and_negative_requests_are_not_treated_as_a_pin(budget):
    # The wire contract is "positive means override"; 0 must fall through to the
    # default path, not clamp the trace to nothing.
    budget(64)
    assert main._synthetic_scan_budget_bytes(0) is None
    assert main._synthetic_scan_budget_bytes(-5) is None


def test_the_clamp_never_returns_a_useless_zero(budget):
    # A pathologically small budget must still leave a workable buffer rather
    # than handing Helios 0 bytes, which would fail the trace outright.
    budget(0.0001)
    assert main._synthetic_scan_budget_bytes(4096) >= 1
