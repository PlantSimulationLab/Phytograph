"""The memory budget: measurement, the derived budget, and admission control.

`memory_budget` is what every large-cloud threshold in the backend derives
from, so its contract is pinned here: the budget is a fraction of physical RAM
unless pinned by env, admission serialises jobs whose working sets do not fit
together, and a job larger than the whole budget is admitted alone rather than
refused (refusing is the cost advisory's job, before any work starts).
"""
import threading
import time

import numpy as np
import pytest

import memory_budget as mb


def test_physical_ram_is_measured_and_budget_is_a_fraction_of_it(monkeypatch):
    monkeypatch.delenv("PHYTOGRAPH_MEMORY_BUDGET_BYTES", raising=False)
    monkeypatch.delenv("PHYTOGRAPH_MEMORY_BUDGET_FRACTION", raising=False)
    phys = mb.physical_ram_bytes()
    assert phys > 1 * mb.GiB, "the test host must report its RAM"
    assert mb.budget_bytes() == int(phys * mb.DEFAULT_BUDGET_FRACTION)
    assert mb.budget_source() == "fraction"


def test_budget_fraction_scales_with_the_machine(monkeypatch):
    monkeypatch.delenv("PHYTOGRAPH_MEMORY_BUDGET_BYTES", raising=False)
    monkeypatch.setenv("PHYTOGRAPH_MEMORY_BUDGET_FRACTION", "0.25")
    assert mb.budget_bytes() == int(mb.physical_ram_bytes() * 0.25)
    # Nonsense fractions fall back to the default rather than zeroing the budget.
    monkeypatch.setenv("PHYTOGRAPH_MEMORY_BUDGET_FRACTION", "7")
    assert mb.budget_fraction() == mb.DEFAULT_BUDGET_FRACTION


def test_pinned_budget_wins_over_the_fraction(monkeypatch):
    monkeypatch.setenv("PHYTOGRAPH_MEMORY_BUDGET_BYTES", str(3 * mb.GiB))
    monkeypatch.setenv("PHYTOGRAPH_MEMORY_BUDGET_FRACTION", "0.9")
    assert mb.budget_bytes() == 3 * mb.GiB
    assert mb.budget_source() == "env"
    snap = mb.snapshot()
    assert snap["budget_bytes"] == 3 * mb.GiB
    assert snap["rss_bytes"] > 0
    assert snap["physical_bytes"] >= snap["available_bytes"] > 0


def test_rss_includes_children_only_when_asked():
    solo = mb.rss_bytes()
    with_children = mb.rss_bytes(include_children=True)
    assert solo > 0
    assert with_children >= solo


def test_bytes_per_point_matches_the_session_dtypes():
    # positions float64 + deleted bool
    assert mb.bytes_per_point() == 25
    # + colors uint16x3, intensity uint16, timestamps float64, 3 float32 extras
    assert mb.bytes_per_point(n_extras=3, colors=True, intensity=True, timestamps=True) == 25 + 6 + 2 + 8 + 12


def test_estimate_session_bytes_counts_every_array_it_holds():
    class Sess:
        positions = np.zeros((1000, 3), dtype=np.float64)
        colors = np.zeros((1000, 3), dtype=np.uint16)
        intensity = None
        deleted = np.zeros(1000, dtype=bool)
        deleted_history = [np.zeros(1000, dtype=bool), np.zeros(1000, dtype=bool)]
        extras = {"a": np.zeros(1000, dtype=np.float32)}
        timestamps = None
        beam_origins = None
        backfilled_misses = {"positions": np.zeros((10, 3))}

    assert mb.estimate_session_bytes(Sess()) == 24000 + 6000 + 1000 + 2000 + 4000 + 240


def test_admission_serialises_jobs_that_do_not_fit_together():
    logs = []
    adm = mb.Admission(lambda: 100, log=logs.append, log_after_s=0.05)
    order = []
    first_in = threading.Event()
    release_first = threading.Event()

    def job_a():
        with adm.admit(60, "a"):
            order.append("a-in")
            first_in.set()
            release_first.wait(5)
            order.append("a-out")

    def job_b():
        first_in.wait(5)
        with adm.admit(60, "b"):
            order.append("b-in")

    ta = threading.Thread(target=job_a)
    tb = threading.Thread(target=job_b)
    ta.start(); tb.start()
    first_in.wait(5)
    time.sleep(0.2)          # b must be WAITING now, not admitted
    assert order == ["a-in"]
    assert [j["label"] for j in adm.in_flight()] == ["a"]
    assert any("waiting" in m for m in logs), logs
    release_first.set()
    ta.join(5); tb.join(5)
    assert order == ["a-in", "a-out", "b-in"]
    assert adm.in_flight() == []


def test_jobs_that_fit_together_run_concurrently():
    adm = mb.Admission(lambda: 100)
    with adm.admit(40, "a"):
        with adm.admit(40, "b"):
            assert sorted(j["label"] for j in adm.in_flight()) == ["a", "b"]
            assert adm.admitted_bytes() == 80


def test_a_job_bigger_than_the_budget_is_admitted_alone_and_logged():
    logs = []
    adm = mb.Admission(lambda: 100, log=logs.append)
    with adm.admit(500, "huge"):
        assert adm.in_flight()[0]["bytes"] == 500
    assert any("exceeds" in m and "running it alone" in m for m in logs), logs


def test_fmt_bytes_is_human():
    assert mb.fmt_bytes(3 * mb.GiB) == "3.0 GB"
    assert mb.fmt_bytes(200 * 1024 ** 2) == "200 MB"
    assert mb.fmt_bytes(1024) == "1 KB"
