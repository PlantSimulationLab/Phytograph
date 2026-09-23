"""Network architectures, looked up by the ``arch`` name in a model package."""

from __future__ import annotations


def build_model(arch: str, **hparams):
    if arch == "pointnext":
        from .pointnext import PointNeXtSeg
        return PointNeXtSeg(**hparams)
    raise ValueError(f"unknown model architecture {arch!r}")
