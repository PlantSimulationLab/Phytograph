"""The CI stack dumper names every thread and its frames, and keeps running
while the threads it watches come and go -- the case that crashed the
faulthandler-based dumper it replaced (see stack_dumper.py)."""

import io
import threading
import time
from pathlib import Path

import pytest

import stack_dumper


def _parked_in_a_named_function(ready: threading.Event, release: threading.Event) -> None:
    ready.set()
    release.wait(10)


def test_format_all_stacks_names_threads_and_their_frames():
    ready, release = threading.Event(), threading.Event()
    t = threading.Thread(target=_parked_in_a_named_function, args=(ready, release), name="parked-worker")
    t.start()
    try:
        assert ready.wait(5)
        text = stack_dumper.format_all_stacks()
    finally:
        release.set()
        t.join(5)
    assert "(parked-worker)" in text
    assert "_parked_in_a_named_function" in text
    assert "(MainThread)" in text
    assert "test_format_all_stacks_names_threads_and_their_frames" in text


def test_periodic_dump_survives_threads_that_start_and_finish_mid_dump():
    """Hundreds of short-lived threads return while the dumper walks them. The
    old watchdog read their frames without the GIL and crashed on exactly this;
    this one must keep writing complete dumps."""
    buf = io.StringIO()
    stop = stack_dumper.start_periodic_stack_dump(buf, 0.01)
    try:
        deadline = time.monotonic() + 1.0
        while time.monotonic() < deadline:
            threads = [threading.Thread(target=sum, args=(range(2000),)) for _ in range(20)]
            for th in threads:
                th.start()
            for th in threads:
                th.join()
    finally:
        stop.set()
    dumps = buf.getvalue().count("--- stacks at ")
    assert dumps >= 10, f"only {dumps} dumps in 1 s at a 10 ms interval"
    assert "(MainThread)" in buf.getvalue()


def test_a_failed_write_ends_the_dumper_quietly(tmp_path: Path):
    f = open(tmp_path / "stacks.log", "w", encoding="utf-8")
    f.close()  # every write now raises ValueError
    stop = stack_dumper.start_periodic_stack_dump(f, 0.01)
    time.sleep(0.1)
    assert not any(t.name == "stack-dumper" and t.is_alive() for t in threading.enumerate())
    stop.set()


def test_a_non_positive_interval_is_refused():
    with pytest.raises(ValueError):
        stack_dumper.start_periodic_stack_dump(io.StringIO(), 0)


def test_backend_wrapper_no_longer_uses_the_unsafe_periodic_dump():
    """The source check that keeps the crash from coming back: the periodic
    dump goes through stack_dumper, and faulthandler is kept for fatal faults
    only."""
    src = (Path(__file__).resolve().parents[1] / "backend_wrapper.py").read_text(encoding="utf-8")
    assert "dump_traceback_later" not in src
    assert "start_periodic_stack_dump" in src
    assert "faulthandler.enable(" in src
