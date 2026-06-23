"""Tests for /api/device-info — the GPU-vs-CPU compute-path report.

The packaged Windows/Linux builds always compile the CUDA path (the release CI
fails otherwise) and macOS is always CPU-only, so the effective path is decided
by a runtime probe for a usable NVIDIA GPU.
"""

import main


def test_device_info_shape_and_invariants(client):
    res = client.get("/api/device-info")
    assert res.status_code == 200
    b = res.json()
    assert set(b) >= {
        "gpu_present", "gpu_count", "gpu_name",
        "driver_version", "effective_path", "reason",
    }
    assert b["effective_path"] in ("gpu", "cpu")
    assert isinstance(b["gpu_present"], bool)
    assert isinstance(b["gpu_count"], int)
    assert b["reason"]  # always explains the path
    # The GPU path is only ever reported when a GPU is actually present.
    if b["effective_path"] == "gpu":
        assert b["gpu_present"] is True


def test_gpu_when_present_on_non_macos(client, monkeypatch):
    import pyhelios.runtime as rt
    import platform as _platform
    monkeypatch.setattr(_platform, "system", lambda: "Linux")
    monkeypatch.setattr(rt, "get_gpu_runtime_info", lambda: {
        "cuda_runtime_available": True,
        "cuda_device_count": 2,
        "cuda_version": "550.0",
        "platform": "Linux",
    })
    monkeypatch.setattr(main, "_gpu_name", lambda: "Mock GPU")
    b = client.get("/api/device-info").json()
    assert b["effective_path"] == "gpu"
    assert b["gpu_present"] is True
    assert b["gpu_count"] == 2
    assert b["gpu_name"] == "Mock GPU"
    assert b["driver_version"] == "550.0"
    assert "GPU" in b["reason"]


def test_cpu_when_no_gpu_present(client, monkeypatch):
    import pyhelios.runtime as rt
    import platform as _platform
    monkeypatch.setattr(_platform, "system", lambda: "Linux")
    monkeypatch.setattr(rt, "get_gpu_runtime_info", lambda: {
        "cuda_runtime_available": False,
        "cuda_device_count": 0,
        "platform": "Linux",
    })
    b = client.get("/api/device-info").json()
    assert b["effective_path"] == "cpu"
    assert b["gpu_present"] is False
    assert b["gpu_name"] is None  # not queried when no GPU


def test_macos_is_always_cpu_even_if_probe_claims_a_gpu(client, monkeypatch):
    # macOS has no CUDA: report CPU regardless of the runtime probe, with a
    # macOS-specific reason.
    import pyhelios.runtime as rt
    import platform as _platform
    monkeypatch.setattr(_platform, "system", lambda: "Darwin")
    monkeypatch.setattr(rt, "get_gpu_runtime_info", lambda: {
        "cuda_runtime_available": True, "cuda_device_count": 1, "platform": "Darwin",
    })
    b = client.get("/api/device-info").json()
    assert b["effective_path"] == "cpu"
    assert "macos" in b["reason"].lower()
