"""The model package: what a trained model is on disk.

A package is a directory holding two files:

- ``model.json``: everything needed to rebuild the network and interpret its
  output. That is the architecture and its hyperparameters, the hierarchy
  geometry it was trained on, its input channels, crop size, class schema and
  output column, and where it came from and how it scored.
- ``weights.pt``: the ``state_dict``, loaded with ``weights_only=True`` so a
  package can never execute code. Packages are meant to be shared: users will
  import models they did not train.

The class schema is written to map one-to-one onto a renderer ``ClassPalette``
(``src/renderer/lib/classPalettes.ts``). Each class has a ``value`` (the
integer written into the output column), a ``name`` and a ``color``. The
network's output index ``i`` is ``classes[i]``.
"""

from __future__ import annotations

import json
import re
from dataclasses import dataclass, field
from pathlib import Path

from .hierarchy import HierarchySpec

FORMAT = "phytograph-ml-model"
SCHEMA_VERSION = 1

# Input channels the inference path knows how to build, in the order they are
# concatenated. "dxyz" (offset from the crop centre, metres) is mandatory.
KNOWN_CHANNELS = {"dxyz": 3, "reflectance": 1}

_ID_RE = re.compile(r"^[a-z0-9][a-z0-9_\-]{0,63}$")
_HEX_RE = re.compile(r"^#[0-9a-fA-F]{6}$")


class PackageError(ValueError):
    """A model package is malformed. The message says what to fix."""


@dataclass
class ModelPackage:
    id: str
    name: str
    task: str
    arch: str
    hparams: dict
    hierarchy: HierarchySpec
    channels: list[str]
    classes: list[dict]
    output_slug: str
    crop_max_points: int = 24000
    crop_inner_fraction: float = 0.7
    description: str = ""
    training: dict = field(default_factory=dict)
    metrics: dict = field(default_factory=dict)
    path: Path | None = None

    @property
    def in_channels(self) -> int:
        return sum(KNOWN_CHANNELS[c] for c in self.channels)

    def to_json(self) -> dict:
        return {
            "format": FORMAT,
            "schema_version": SCHEMA_VERSION,
            "id": self.id,
            "name": self.name,
            "description": self.description,
            "task": self.task,
            "arch": self.arch,
            "hparams": self.hparams,
            "hierarchy": self.hierarchy.to_dict(),
            "inputs": {"channels": self.channels},
            "crop": {"max_points": self.crop_max_points,
                     "inner_fraction": self.crop_inner_fraction},
            "classes": self.classes,
            "output_slug": self.output_slug,
            "training": self.training,
            "metrics": self.metrics,
        }

    def summary(self) -> dict:
        """The subset of model.json the renderer lists and shows."""
        return {
            "id": self.id, "name": self.name, "description": self.description,
            "task": self.task, "arch": self.arch,
            "variant": self.hparams.get("variant"),
            "channels": self.channels, "classes": self.classes,
            "output_slug": self.output_slug, "metrics": self.metrics,
        }


def validate(meta: dict) -> ModelPackage:
    """Parse and check a model.json dict. Raises PackageError naming the first
    problem found."""
    if not isinstance(meta, dict) or meta.get("format") != FORMAT:
        raise PackageError(f"not a Phytograph model (format must be {FORMAT!r})")
    ver = meta.get("schema_version")
    if ver != SCHEMA_VERSION:
        raise PackageError(
            f"model schema version {ver} is not supported (this Phytograph reads "
            f"version {SCHEMA_VERSION})"
        )
    mid = meta.get("id", "")
    if not isinstance(mid, str) or not _ID_RE.match(mid):
        raise PackageError("id must be 1-64 chars of a-z, 0-9, '_' or '-', starting alphanumeric")
    for key in ("name", "task", "arch", "output_slug"):
        if not isinstance(meta.get(key), str) or not meta[key]:
            raise PackageError(f"missing {key!r}")
    if meta["arch"] != "pointnext":
        raise PackageError(f"unknown architecture {meta['arch']!r}")

    channels = (meta.get("inputs") or {}).get("channels") or []
    if not channels or channels[0] != "dxyz":
        raise PackageError("inputs.channels must start with 'dxyz'")
    unknown = [c for c in channels if c not in KNOWN_CHANNELS]
    if unknown:
        raise PackageError(f"unknown input channel(s): {', '.join(unknown)}")

    classes = meta.get("classes")
    if not isinstance(classes, list) or len(classes) < 2:
        raise PackageError("classes must list at least two classes")
    seen = set()
    for c in classes:
        v = c.get("value") if isinstance(c, dict) else None
        if not isinstance(v, int) or not (1 <= v <= 255):
            raise PackageError("each class needs an integer value in 1..255 (0 is Unclassified)")
        if v in seen:
            raise PackageError(f"class value {v} appears twice")
        seen.add(v)
        if not isinstance(c.get("name"), str) or not c["name"]:
            raise PackageError(f"class {v} has no name")
        if not _HEX_RE.match(str(c.get("color", ""))):
            raise PackageError(f"class {v} color must be #rrggbb")

    hp = dict(meta.get("hparams") or {})
    if hp.get("num_classes") != len(classes):
        raise PackageError("hparams.num_classes does not match the number of classes")
    hier = HierarchySpec.from_dict(meta.get("hierarchy") or {})
    if hier.voxel <= 0 or hier.levels < 2 or hier.k < 2:
        raise PackageError("hierarchy must have voxel > 0, levels >= 2 and k >= 2")
    crop = meta.get("crop") or {}
    pkg = ModelPackage(
        id=mid, name=meta["name"], task=meta["task"], arch=meta["arch"],
        hparams=hp, hierarchy=hier, channels=list(channels), classes=classes,
        output_slug=meta["output_slug"],
        crop_max_points=int(crop.get("max_points", 24000)),
        crop_inner_fraction=float(crop.get("inner_fraction", 0.7)),
        description=str(meta.get("description", "")),
        training=dict(meta.get("training") or {}),
        metrics=dict(meta.get("metrics") or {}),
    )
    if hp.get("in_channels") != pkg.in_channels:
        raise PackageError("hparams.in_channels does not match inputs.channels")
    if not (0.1 <= pkg.crop_inner_fraction <= 1.0) or pkg.crop_max_points < 256:
        raise PackageError("crop.max_points must be >= 256 and inner_fraction in 0.1..1")
    return pkg


def load_meta(path: str | Path) -> ModelPackage:
    """Read and validate a package directory's model.json (no torch import)."""
    path = Path(path)
    try:
        meta = json.loads((path / "model.json").read_text())
    except FileNotFoundError:
        raise PackageError(f"{path} has no model.json") from None
    except json.JSONDecodeError as e:
        raise PackageError(f"model.json is not valid JSON: {e}") from None
    pkg = validate(meta)
    if not (path / "weights.pt").is_file():
        raise PackageError(f"{path} has no weights.pt")
    pkg.path = path
    return pkg


def load_model(pkg: ModelPackage, device="cpu"):
    """Instantiate the network and load its weights, in eval mode."""
    import torch

    from .models import build_model

    model = build_model(pkg.arch, **pkg.hparams)
    state = torch.load(pkg.path / "weights.pt", map_location="cpu", weights_only=True)
    try:
        model.load_state_dict(state)
    except RuntimeError as e:
        raise PackageError(f"weights do not match the architecture in model.json: {e}") from None
    return model.to(device).eval()


def save(pkg: ModelPackage, state_dict: dict, out_dir: str | Path) -> Path:
    """Write a package. Validates the metadata first, so a bad package is never
    written."""
    import torch

    validate(pkg.to_json())
    out = Path(out_dir)
    out.mkdir(parents=True, exist_ok=True)
    torch.save({k: v.detach().cpu() for k, v in state_dict.items()}, out / "weights.pt")
    (out / "model.json").write_text(json.dumps(pkg.to_json(), indent=2) + "\n")
    pkg.path = out
    return out
