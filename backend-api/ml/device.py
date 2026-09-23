"""Which torch device ML work runs on.

``/api/device-info`` answers a different question for Helios ray tracing (an
``nvidia-smi`` probe against a libhelios compiled with or without CUDA). Torch
has its own answer, which can differ: the torch wheel's CUDA build may not
support an old GPU, and Apple's MPS exists only to torch. So this module asks
torch itself, and it checks that a kernel really runs rather than trusting
``is_available()``. The check is not academic: on Farm's V100 nodes the cu13
wheel reports ``is_available() == True`` and then fails the first kernel with
"no kernel image is available for execution on the device".
"""

from __future__ import annotations

import functools
import os


@functools.lru_cache(maxsize=1)
def probe() -> dict:
    """Describe the best usable torch device. Cached: the answer cannot change
    within a process, and probing CUDA costs ~1 s."""
    info = {"torch": None, "device": "cpu", "cuda": False, "mps": False,
            "device_name": None, "vram_gb": None, "reason": None}
    try:
        import torch
    except Exception as e:  # pragma: no cover - torch ships in the bundle
        info["reason"] = f"torch unavailable: {e}"
        return info
    info["torch"] = torch.__version__
    forced = os.environ.get("PHYTOGRAPH_ML_DEVICE", "").strip().lower()
    if forced == "cpu":
        info["reason"] = "PHYTOGRAPH_ML_DEVICE=cpu"
        return info

    if torch.cuda.is_available():
        try:
            x = torch.ones(8, device="cuda")
            float((x * 2).sum())
            props = torch.cuda.get_device_properties(0)
            info.update(cuda=True, device="cuda", device_name=props.name,
                        vram_gb=round(props.total_memory / 2**30, 1))
            return info
        except Exception as e:
            info["reason"] = f"CUDA present but unusable: {str(e).splitlines()[0]}"

    mps = getattr(torch.backends, "mps", None)
    if mps is not None and mps.is_available():
        try:
            float((torch.ones(8, device="mps") * 2).sum())
            info.update(mps=True, device="mps", device_name="Apple GPU (MPS)")
            return info
        except Exception as e:
            info["reason"] = f"MPS present but unusable: {str(e).splitlines()[0]}"
    if info["reason"] is None:
        info["reason"] = "no CUDA or MPS device"
    return info


def best_device(requested: str | None = None) -> str:
    """``requested`` ('cuda', 'mps', 'cpu' or None/'auto'), falling back to CPU
    when the requested accelerator is not usable."""
    p = probe()
    if requested in (None, "", "auto"):
        return p["device"]
    if requested == "cuda" and p["cuda"]:
        return "cuda"
    if requested == "mps" and p["mps"]:
        return "mps"
    return "cpu"
