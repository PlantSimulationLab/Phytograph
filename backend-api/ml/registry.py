"""Where installed models live, and how they are listed, found and imported.

There are two roots:

- **Bundled** (read-only): ``resources/ml_models/<id>/`` in the repo, shipped
  via ``extraResources`` to ``$PHYTOGRAPH_RESOURCES/ml_models``. As for the
  RIEGL build context (``_riegl_docker_context`` in main.py), the parent of
  that env var is tried too, since it points one level inside extraResources.
  Pinned against package.json by ``tests/test_ml_registry.py``.
- **User** (read-write): ``<per-user data dir>/Phytograph/ml_models/<id>/``,
  holding models the user imported (and, later, trained). It is the same
  per-OS base ``_riegl_extract_dir`` uses. ``PHYTOGRAPH_ML_MODELS_DIR``
  overrides it.

Only the backend knows these paths; the renderer sees models through
``/api/ml/models``. That is deliberate: two processes each computing a
per-OS path is how the octree cache root diverged (see CLAUDE.md).

A user model may not reuse a bundled model's id. Otherwise an import could
silently shadow the shipped default under the same name.
"""

from __future__ import annotations

import os
import shutil
import sys
import tempfile
from pathlib import Path

from .package import ModelPackage, PackageError, load_meta

DEFAULT_WOOD_MODEL = "wood-leaf-pointnext-s-v1"


def bundled_roots() -> list[Path]:
    roots = []
    env = os.environ.get("PHYTOGRAPH_RESOURCES")
    if env:
        roots += [Path(env) / "ml_models", Path(env).parent / "ml_models"]
    roots.append(Path(__file__).resolve().parents[2] / "resources" / "ml_models")
    return roots


def user_root() -> Path:
    override = os.environ.get("PHYTOGRAPH_ML_MODELS_DIR")
    if override:
        return Path(override)
    if sys.platform == "darwin":
        base = Path.home() / "Library" / "Application Support" / "Phytograph"
    elif sys.platform.startswith("win"):
        base = Path(os.environ.get("LOCALAPPDATA", Path.home() / "AppData" / "Local")) / "Phytograph"
    else:
        base = Path(os.environ.get("XDG_DATA_HOME", Path.home() / ".local" / "share")) / "Phytograph"
    return base / "ml_models"


def _scan(root: Path) -> list[ModelPackage]:
    out = []
    if not root.is_dir():
        return out
    for d in sorted(root.iterdir()):
        if (d / "model.json").is_file():
            try:
                out.append(load_meta(d))
            except PackageError:
                # A broken package is skipped rather than failing the whole
                # listing; import is where the user sees why a package fails.
                continue
    return out


def list_models() -> list[tuple[ModelPackage, str]]:
    """Every loadable model as (package, origin), origin "bundled" or "user".
    The first bundled root that has a given id wins."""
    seen: dict[str, tuple[ModelPackage, str]] = {}
    for root in bundled_roots():
        for p in _scan(root):
            seen.setdefault(p.id, (p, "bundled"))
    for p in _scan(user_root()):
        seen.setdefault(p.id, (p, "user"))
    return list(seen.values())


def find(model_id: str | None, task: str | None = None) -> ModelPackage:
    """The package for ``model_id``. With None, the default model for ``task``
    (currently only wood_leaf has one)."""
    if not model_id:
        if task not in (None, "wood_leaf"):
            raise PackageError(f"no default model for task {task!r}")
        model_id = DEFAULT_WOOD_MODEL
    for pkg, _ in list_models():
        if pkg.id == model_id:
            if task and pkg.task != task:
                raise PackageError(f"model {model_id!r} is a {pkg.task!r} model, not {task!r}")
            return pkg
    raise PackageError(f"model {model_id!r} is not installed")


def import_package(src: str | Path) -> ModelPackage:
    """Validate the package directory ``src`` and copy it into the user root
    under its own id. Re-importing a user model's id replaces it, while a
    bundled id is refused."""
    src = Path(src)
    pkg = load_meta(src)  # validates model.json and checks weights.pt exists
    # Loading the weights proves they match the declared architecture, so a
    # package that would only fail at first use is refused now instead.
    from .package import load_model
    load_model(pkg, "cpu")
    for other, origin in list_models():
        if other.id == pkg.id and origin == "bundled":
            raise PackageError(f"{pkg.id!r} is the id of a built-in model; give the package another id")
    root = user_root()
    root.mkdir(parents=True, exist_ok=True)
    dest = root / pkg.id
    tmp = Path(tempfile.mkdtemp(prefix=f".{pkg.id}-", dir=root))
    try:
        for name in ("model.json", "weights.pt"):
            shutil.copy2(src / name, tmp / name)
        if dest.exists():
            shutil.rmtree(dest)
        tmp.rename(dest)
    finally:
        if tmp.exists():
            shutil.rmtree(tmp, ignore_errors=True)
    return load_meta(dest)


def delete_user_model(model_id: str) -> None:
    for pkg, origin in list_models():
        if pkg.id == model_id:
            if origin != "user":
                raise PackageError(f"{model_id!r} is built in and cannot be removed")
            shutil.rmtree(pkg.path)
            return
    raise PackageError(f"model {model_id!r} is not installed")
