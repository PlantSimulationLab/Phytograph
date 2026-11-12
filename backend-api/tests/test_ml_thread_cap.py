"""PHYTOGRAPH_THREADS caps torch too (thread_cap.apply_torch). Named test_ml_*
so scripts/run-pytest.mjs runs it in the torch-only process."""

import pytest

import thread_cap

torch = pytest.importorskip("torch")


def test_the_cap_reaches_torch(monkeypatch):
    before = torch.get_num_threads()
    monkeypatch.setenv(thread_cap.ENV, "2")
    try:
        thread_cap.apply_torch(torch)
        assert torch.get_num_threads() == 2
    finally:
        torch.set_num_threads(before)


def test_unset_leaves_torch_alone(monkeypatch):
    monkeypatch.delenv(thread_cap.ENV, raising=False)
    before = torch.get_num_threads()
    thread_cap.apply_torch(torch)
    assert torch.get_num_threads() == before
