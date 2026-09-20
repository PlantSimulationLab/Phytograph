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

# `available_bytes()` returns 0 when it cannot measure, by design, so an
# assertion on it reads as a bare `assert 0 > 0` that names nothing. On macOS
# there is no SC_AVPHYS_PAGES, so the os.sysconf fallback cannot answer either
# and psutil is the ONLY path — which makes a venv missing it look like a
# mysterious arithmetic failure rather than a missing dependency.
_FIX_THE_VENV = (
    "Almost always a venv that predates psutil being added to "
    "requirements.txt: run `pip install -r backend-api/requirements.txt`. "
    "psutil is a DECLARED dependency, but memory_budget degrades to "
    "os.sysconf/resource rather than raising when it is absent, so the drift "
    "is otherwise silent — and on macOS (no SC_AVPHYS_PAGES) that fallback "
    "cannot measure at all."
)
_PSUTIL_MISSING = f"psutil is not importable. {_FIX_THE_VENV}"
_MEASUREMENT_UNAVAILABLE = (
    f"available_bytes() is 0, i.e. the OS memory measurement failed. "
    f"{_FIX_THE_VENV}"
)


def test_psutil_the_declared_measurement_backend_is_installed():
    """The drift-catcher, asserted on the dependency rather than its symptom.

    Without psutil `rss_bytes()` falls back to `resource.ru_maxrss`, which is
    the PEAK and never decreases — so admission control sizes every later job
    against a high-water mark instead of current usage, silently and only on
    the machines where the venv has drifted. Shipped builds are unaffected
    (PyInstaller collects psutil via `collectAll` in build-backend.mjs); this
    guards the dev venv, which nothing re-syncs on its own.
    """
    assert mb._psutil is not None, _PSUTIL_MISSING


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
    assert snap["available_bytes"] > 0, _MEASUREMENT_UNAVAILABLE
    assert snap["physical_bytes"] >= snap["available_bytes"]


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


# ---- admission_budget_bytes: the budget capped by what is actually free ------
#
# `budget_bytes()` is a property of the MACHINE and must stay stable (it decides
# a session's on-disk-vs-in-RAM layout at import); admission is a decision about
# NOW. Before this split, a 16 GB laptop with 2.4 GB free still admitted 8 GB of
# concurrent work and paged itself to death. These pin the split in both
# directions, since collapsing either one back into the other is silent.

def test_admission_budget_is_capped_by_available_memory(monkeypatch):
    monkeypatch.delenv("PHYTOGRAPH_MEMORY_BUDGET_BYTES", raising=False)
    monkeypatch.delenv("PHYTOGRAPH_MEMORY_BUDGET_FRACTION", raising=False)
    monkeypatch.setattr(mb, "physical_ram_bytes", lambda: 16 * mb.GiB)
    # Plenty free: the machine-level budget is the binding constraint.
    monkeypatch.setattr(mb, "available_bytes", lambda: 14 * mb.GiB)
    assert mb.budget_bytes() == 8 * mb.GiB
    assert mb.admission_budget_bytes() == 8 * mb.GiB
    # Busy machine: free memory binds instead, and the machine budget is unmoved.
    monkeypatch.setattr(mb, "available_bytes", lambda: 3 * mb.GiB)
    assert mb.admission_budget_bytes() == int(3 * mb.GiB * mb._AVAILABLE_HEADROOM)
    assert mb.budget_bytes() == 8 * mb.GiB, (
        "budget_bytes() must NOT move with free memory: it sets a session's "
        "store-backed layout at import, which cannot flap"
    )


def test_admission_budget_never_starves_and_honours_a_pin(monkeypatch):
    monkeypatch.delenv("PHYTOGRAPH_MEMORY_BUDGET_FRACTION", raising=False)
    monkeypatch.setattr(mb, "physical_ram_bytes", lambda: 16 * mb.GiB)
    # Almost nothing free: floored, so work still proceeds one job at a time
    # rather than deadlocking behind a budget of ~0.
    monkeypatch.delenv("PHYTOGRAPH_MEMORY_BUDGET_BYTES", raising=False)
    monkeypatch.setattr(mb, "available_bytes", lambda: 64 * 1024 * 1024)
    assert mb.admission_budget_bytes() == mb._MIN_ADMISSION_BYTES
    # Unmeasurable availability degrades to the plain budget, never to the floor.
    monkeypatch.setattr(mb, "available_bytes", lambda: 0)
    assert mb.admission_budget_bytes() == 8 * mb.GiB
    # A PINNED budget is honoured exactly: the user named a number, and quietly
    # admitting less would make the Settings field a lie.
    monkeypatch.setenv("PHYTOGRAPH_MEMORY_BUDGET_BYTES", str(6 * mb.GiB))
    monkeypatch.setattr(mb, "available_bytes", lambda: 1 * mb.GiB)
    assert mb.admission_budget_bytes() == 6 * mb.GiB


def test_snapshot_reports_the_admission_budget(monkeypatch):
    """The Settings readout reads this key; losing it blanks the readout."""
    monkeypatch.delenv("PHYTOGRAPH_MEMORY_BUDGET_BYTES", raising=False)
    snap = mb.snapshot()
    assert "admission_budget_bytes" in snap
    assert 0 < int(snap["admission_budget_bytes"]) <= int(snap["budget_bytes"])


def test_estimate_session_bytes_can_skip_memmapped_columns(tmp_path):
    """`main._session_ram_bytes` is this function plus a memmap skip.

    They were two separate copies of the same traversal, so a column added to
    CloudSession had to be remembered in both -- and the RAM tally, which decides
    eviction, was the copy that would silently undercount. This pins the skip
    that makes one definition serve both.
    """
    import numpy as np

    n = 1000
    path = tmp_path / "positions.npy"
    mapped = np.lib.format.open_memmap(
        str(path), mode="w+", dtype=np.float64, shape=(n, 3))

    class Sess:
        positions = mapped                      # on disk: page cache, not RAM
        colors = np.zeros((n, 3), dtype=np.uint16)   # in RAM
        intensity = None
        deleted = np.zeros(n, dtype=bool)            # in RAM
        timestamps = None
        beam_origins = None
        deleted_base = None
        extras: dict = {}
        deleted_history: list = []
        backfilled_misses: dict = {}

    everything = mb.estimate_session_bytes(Sess())
    ram_only = mb.estimate_session_bytes(
        Sess(), skip=lambda a: isinstance(a, np.memmap))

    assert everything == n * 24 + n * 6 + n * 1
    assert ram_only == n * 6 + n * 1, "the memmapped column must not count as RAM"
    assert ram_only < everything


def test_session_ram_bytes_is_the_shared_traversal():
    """The chokepoint: `main` must not grow its own copy again."""
    import inspect

    import main

    src = inspect.getsource(main._session_ram_bytes)
    assert "estimate_session_bytes" in src, (
        "_session_ram_bytes must delegate to memory_budget.estimate_session_bytes, "
        "not re-walk the session's arrays"
    )
    assert "np.memmap" in src, "it must still skip memmapped columns"
