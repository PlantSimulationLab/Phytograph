"""GPU assertions that only mean something on real NVIDIA hardware.

test_device_info.py already covers /api/device-info's shape and its decision
logic — but it does so with `monkeypatch`, substituting a fake
`get_gpu_runtime_info`. That proves the branching is right; it cannot prove the
probe works, that the driver is reachable, or that libhelios actually compiled
its CUDA path. Every one of those has to be checked against a real GPU.

These tests SKIP when no GPU is present, so they are inert in the normal Linux
CI job and on a developer's machine. .github/workflows/gpu.yml runs them on a
GPU runner, where the skip would be a lie — so it asserts up front that the
GPU is visible before invoking pytest, and these tests would then fail rather
than skip if the runtime could not see it.

What this file deliberately does NOT do is re-implement scan correctness. The
GPU parity check is the EXISTING tests/test_lidar_scan*.py suite (49 tests),
run on a GPU runner: its expectations were derived on CPU, so if the CUDA
ray-tracing path disagrees with the CPU path, those assertions fail. Writing a
second, weaker set of expectations here would only dilute that.
"""

import shutil
import subprocess

import pytest

import main


def _nvidia_smi_reports_a_gpu() -> bool:
    """True when nvidia-smi exists AND lists at least one device.

    Presence of the binary is not enough: a machine can carry the CLI with no
    driver or no card, which is exactly the case that must not silently pass.
    """
    exe = shutil.which("nvidia-smi")
    if not exe:
        return False
    try:
        out = subprocess.run(
            [exe, "--query-gpu=name", "--format=csv,noheader"],
            capture_output=True, text=True, timeout=30,
        )
    except (OSError, subprocess.SubprocessError):
        return False
    return out.returncode == 0 and bool(out.stdout.strip())


requires_gpu = pytest.mark.skipif(
    not _nvidia_smi_reports_a_gpu(),
    reason="no NVIDIA GPU visible to nvidia-smi",
)


@requires_gpu
def test_device_info_reports_the_gpu_path_on_real_hardware(client):
    """The unmocked probe must reach the driver and choose the GPU path.

    This is the assertion the mocked tests structurally cannot make: it exercises
    pyhelios.runtime.get_gpu_runtime_info against a real driver rather than a
    lambda, so a probe that silently regressed (a changed nvidia-smi output
    format, a missing runtime library) shows up here as a CPU verdict on a
    machine that plainly has a GPU.
    """
    body = client.get("/api/device-info").json()

    assert body["gpu_present"] is True, (
        "nvidia-smi lists a GPU but the backend's probe did not see one — "
        f"device-info said: {body}"
    )
    assert body["gpu_count"] >= 1
    assert body["gpu_name"], "a present GPU must report a name"
    assert body["effective_path"] == "gpu", (
        "a usable GPU on a non-macOS host must select the GPU path; "
        f"got {body['effective_path']!r} because: {body.get('reason')!r}"
    )


@requires_gpu
def test_libhelios_compiled_the_cuda_path():
    """A GPU-capable BUILD, distinct from a GPU-capable machine.

    scripts/build-pyhelios.mjs --require-gpu fails the build when the CUDA path
    did not compile, but that check reads the CMake cache at build time. This
    asserts the property from the other side, at runtime, against the library
    actually loaded — which is what would catch a bundle assembled from a
    stale CPU-only libhelios despite a green build.

    Skipped rather than failed if PyHelios exposes no such introspection: the
    point is to catch a regression, not to demand an API that may not exist.
    """
    import pyhelios

    info = getattr(pyhelios, "runtime", None)
    getter = getattr(info, "get_gpu_runtime_info", None) if info else None
    if getter is None:
        pytest.skip("pyhelios.runtime.get_gpu_runtime_info unavailable")

    rt = getter()
    assert rt.get("cuda_runtime_available") is True, (
        "libhelios did not report a usable CUDA runtime on a GPU machine — "
        f"the build may be CPU-only despite --require-gpu. runtime info: {rt}"
    )
    assert int(rt.get("cuda_device_count") or 0) >= 1, f"no CUDA devices: {rt}"
