"""Launching (or attaching to) a Phytograph backend.

A script never imports the compute stack (open3d, pyhelios, torch). It runs the
same backend the desktop app runs — the PyInstaller bundle inside an installed
Phytograph, or a dev checkout's ``backend-api`` venv — as a private child
process, and talks to it over HTTP on loopback with a per-launch token.
"""
from __future__ import annotations

import os
import secrets
import shutil
import signal
import subprocess
import sys
import tempfile
import time
from pathlib import Path
from typing import Any, Dict, List, Optional, Sequence, Union

import httpx

from . import _ports
from ._transport import ProgressFn, Transport
from ._version import EXPECTED_BACKEND_VERSION
from .errors import BackendNotFound, BackendStartError, PhytographError, VersionMismatch

PathLike = Union[str, "os.PathLike[str]"]

_EXE_NAME = "phytograph_backend.exe" if sys.platform == "win32" else "phytograph_backend"


# --------------------------------------------------------------------------
# Locating a backend
# --------------------------------------------------------------------------
def _repo_root() -> Optional[Path]:
    """The checkout this package lives in, when it is run from one (an editable
    install or ``PYTHONPATH=python``). ``python/phytograph/backend.py`` →
    repo root two levels up, recognised by ``backend-api/backend_wrapper.py``."""
    root = Path(__file__).resolve().parents[2]
    return root if (root / "backend-api" / "backend_wrapper.py").is_file() else None


def _dev_python(root: Path) -> Optional[Path]:
    venv = root / "backend-api" / "venv"
    for cand in (venv / "bin" / "python", venv / "Scripts" / "python.exe"):
        if cand.is_file():
            return cand
    return None


def _installed_app_candidates() -> List[Path]:
    """Where an installed Phytograph keeps its bundled backend. Mirrors
    ``resourcesRoot()`` in ``src/main/backend.ts``: ``<resourcesPath>/resources``."""
    home = Path.home()
    rel = Path("resources") / "phytograph_backend" / _EXE_NAME
    if sys.platform == "darwin":
        apps = [Path("/Applications/Phytograph.app"), home / "Applications" / "Phytograph.app"]
        return [a / "Contents" / "Resources" / rel for a in apps]
    if sys.platform == "win32":
        bases = [os.environ.get("LOCALAPPDATA", ""), os.environ.get("PROGRAMFILES", "")]
        return [Path(b) / "Programs" / "Phytograph" / "resources" / rel for b in bases if b] + \
               [Path(b) / "Phytograph" / "resources" / rel for b in bases if b]
    # Linux ships an AppImage, whose files exist only while it is mounted; an
    # extracted one (``--appimage-extract`` → squashfs-root) or a .deb works.
    return [Path("/opt/Phytograph/resources") / rel,
            home / "squashfs-root" / "resources" / rel]


_STAMP_FILE = "phytograph_backend_version.txt"   # written by scripts/build-backend.mjs


def _bundle_version(exe: Path) -> Optional[str]:
    """The version a PyInstaller bundle was built as, from the stamp beside it."""
    try:
        return (exe.parent / _STAMP_FILE).read_text().strip() or None
    except OSError:
        return None


def _bundle_command(exe: Path, description: str):
    # resources = <...>/resources, the parent of phytograph_backend/
    return [str(exe)], exe.parent, exe.resolve().parents[1], description


def _resolve_command(source: str, executable: Optional[PathLike],
                     progress: Optional[ProgressFn] = None):
    """(argv, cwd, resources_dir, description) for the backend to launch.

    Order: an explicit executable; a dev checkout's venv (when this package
    lives in one); an installed app OF THIS VERSION; a previously downloaded
    backend; and finally a download of the one matching this package."""
    from . import _download

    exe = executable or os.environ.get("PHYTOGRAPH_BACKEND_EXE")
    if exe:
        p = Path(exe).expanduser()
        if not p.is_file():
            raise BackendNotFound(f"Backend executable not found: {p}")
        if p.suffix == ".py":  # a backend_wrapper.py in some checkout
            root = p.resolve().parents[1]
            py = _dev_python(root) or Path(sys.executable)
            return [str(py), str(p)], p.parent, root / "resources", f"{p} (via {py})"
        return _bundle_command(p, str(p))

    if source in ("auto", "dev"):
        root = _repo_root()
        py = _dev_python(root) if root else None
        if root and py:
            wrapper = root / "backend-api" / "backend_wrapper.py"
            return [str(py), str(wrapper)], wrapper.parent, root / "resources", f"dev checkout {root}"
        if source == "dev":
            raise BackendNotFound("source='dev' needs a checkout with backend-api/venv "
                                  "(see CLAUDE.md 'Setup').")

    other_versions = []
    if source in ("auto", "app"):
        for cand in _installed_app_candidates():
            if not cand.is_file():
                continue
            v = _bundle_version(cand)
            # An app of another version would be refused at /version anyway;
            # skip it here so a matching download can be used instead.
            if v is None or v == EXPECTED_BACKEND_VERSION:
                return _bundle_command(cand, f"installed app {cand}")
            other_versions.append(f"{cand} is {v}")
        if source == "app":
            raise BackendNotFound(
                f"No installed Phytograph app of version {EXPECTED_BACKEND_VERSION} was found"
                + (f" ({'; '.join(other_versions)})" if other_versions else "") + ".")

    # "auto" and "download": a cached download, else fetch it now.
    exe_path = _download.install(progress=progress)
    return _bundle_command(exe_path, f"downloaded backend {exe_path.parents[2]}")


# --------------------------------------------------------------------------
# The Backend handle
# --------------------------------------------------------------------------
class Backend:
    """A running Phytograph backend and the entry point of the scripting API.

    ``Backend()`` launches a private headless backend and owns it: it is shut
    down by ``close()``, by leaving a ``with`` block, or — because it watches a
    stdin pipe (``PHYTOGRAPH_EXIT_WITH_PARENT``) — when the script dies however
    it dies. ``Backend.attach(url, token)`` talks to one someone else runs.

    Parameters
    ----------
    source:
        ``"auto"`` tries, in order: a dev checkout's venv (when this package
        lives in one), an installed Phytograph app of this version, a backend
        downloaded earlier, and finally downloads the matching backend (about
        400 MB, once). ``"app"``, ``"dev"`` or ``"download"`` use only that.
    executable:
        Explicit backend binary (or a ``backend_wrapper.py``); also read from
        ``PHYTOGRAPH_BACKEND_EXE``.
    progress:
        ``callback(fraction_or_None, message)`` for long runs. ``True`` prints a
        tqdm bar if tqdm is installed, else one line per message.
    confirm_costly:
        Heavy tools stop at a backend cost estimate; a script confirms them by
        default. ``False`` raises :class:`~phytograph.errors.CostWarning`.
    startup_timeout:
        Seconds to wait for ``/health``. A dev checkout may recompile
        ``libhelios`` on first start, which takes minutes.
    env:
        Extra environment for the backend (e.g. ``PHYTOGRAPH_MAX_CLOUD_SESSIONS``).
    """

    def __init__(self, *, source: str = "auto", executable: Optional[PathLike] = None,
                 progress: Union[ProgressFn, bool, None] = None, confirm_costly: bool = True,
                 startup_timeout: float = 600.0, env: Optional[Dict[str, str]] = None,
                 _attach: Optional[Dict[str, Any]] = None):
        if source not in ("auto", "app", "dev", "download"):
            raise ValueError("source must be 'auto', 'app', 'dev' or 'download'")
        self._proc: Optional[subprocess.Popen] = None
        self._log_path: Optional[Path] = None
        self._work_dir: Optional[Path] = None
        progress_fn = _progress_printer() if progress is True else (progress or None)
        if _attach is not None:
            self.url, token, self.description = _attach["url"], _attach["token"], f"attached {_attach['url']}"
        else:
            argv, cwd, resources, self.description = _resolve_command(source, executable, progress_fn)
            port = _ports.find_free_port()
            token = secrets.token_hex(32)
            self.url = f"http://127.0.0.1:{port}"
            self._launch(argv, cwd, resources, port, token, env or {})
        self._transport = Transport(self.url, token, progress=progress_fn,
                                    confirm_costly=confirm_costly)
        try:
            self._wait_healthy(startup_timeout if _attach is None else 10.0)
            self.version = self._check_version()
        except BaseException:
            self.close()
            raise

    @classmethod
    def attach(cls, url: str, token: Optional[str] = None, **kwargs: Any) -> "Backend":
        """Use a backend that is already running (it is NOT shut down on close).
        ``token`` is that backend's ``PHYTOGRAPH_BACKEND_TOKEN``, if it has one."""
        return cls(_attach={"url": url.rstrip("/"), "token": token}, **kwargs)

    # -- lifecycle ---------------------------------------------------------
    def _launch(self, argv: Sequence[str], cwd: Path, resources: Path, port: int,
                token: str, extra_env: Dict[str, str]) -> None:
        # One private directory per launch, removed by close(): the log, and the
        # OCTREE CACHE. The cache must not be the app's: the backend's 20 GB LRU
        # eviction pins only its OWN live sessions' octrees, so a batch script
        # sharing the app's cache root could evict the octree of a cloud the
        # user has edited in the running app — the only copy of those edits
        # (CLAUDE.md "Octree cache root"). A script never reads its octrees back.
        work = Path(tempfile.mkdtemp(prefix="phytograph-script-"))
        self._work_dir = work
        self._log_path = work / "backend.log"
        env = {**os.environ, **extra_env,
               "PHYTOGRAPH_BACKEND_PORT": str(port),
               "PHYTOGRAPH_BACKEND_TOKEN": token,
               "PHYTOGRAPH_EXIT_WITH_PARENT": "1",
               "PHYTOGRAPH_LOG_DIR": str(work),
               "PHYTOGRAPH_OCTREE_CACHE_ROOT": str(work / "octrees")}
        if resources.is_dir():
            env.setdefault("PHYTOGRAPH_RESOURCES", str(resources))
        # The parent's own dev-session pins must not leak into a private backend.
        for k in ("PHYTOGRAPH_DEV_BACKEND", "PHYTOGRAPH_RENDERER_PORT"):
            env.pop(k, None)
        log = open(self._log_path, "wb")
        try:
            self._proc = subprocess.Popen(
                list(argv) + ["--port", str(port), "--host", "127.0.0.1"],
                cwd=str(cwd), env=env, stdin=subprocess.PIPE, stdout=log, stderr=subprocess.STDOUT,
                # Own process group, so close() can take the whole tree down
                # (same reason as `detached` in src/main/backend.ts).
                start_new_session=(sys.platform != "win32"),
                creationflags=(subprocess.CREATE_NEW_PROCESS_GROUP if sys.platform == "win32" else 0),
            )
        finally:
            log.close()

    def _log_tail(self, n: int = 40) -> str:
        if not self._log_path or not self._log_path.exists():
            return ""
        lines = self._log_path.read_text(errors="replace").splitlines()
        return "\n".join(lines[-n:])

    def _wait_healthy(self, timeout: float) -> None:
        deadline = time.monotonic() + timeout
        last: Optional[Exception] = None
        while time.monotonic() < deadline:
            if self._proc is not None and self._proc.poll() is not None:
                raise BackendStartError(
                    f"Backend exited with code {self._proc.returncode} during startup "
                    f"({self.description}).\n{self._log_tail()}")
            try:
                self._transport.get_json("/health")
                return
            except Exception as e:  # noqa: BLE001 — connection refused until it binds
                last = e
                time.sleep(0.25)
        raise BackendStartError(f"Backend did not answer /health within {timeout:.0f}s "
                                f"({self.description}): {last}\n{self._log_tail()}")

    def _check_version(self) -> str:
        v = self._transport.get_json("/version").get("version")
        if v != EXPECTED_BACKEND_VERSION:
            raise VersionMismatch(
                f"This phytograph package expects backend {EXPECTED_BACKEND_VERSION}, but "
                f"{self.description} is {v}. Install the package that matches your app "
                f"(pip install phytograph=={v}), or update the app.")
        return v

    def close(self, *, timeout: float = 20.0) -> None:
        """Free the backend: shut down a launched one (and delete its private
        cache and log); just disconnect from an attached one.

        Shutdown is a clean exit triggered by closing the backend's stdin (the
        parent watchdog's signal); only if that takes longer than ``timeout`` —
        longer than the watchdog's own grace period — is the tree killed."""
        t = getattr(self, "_transport", None)
        if t is not None:
            t.close()
        proc, self._proc = getattr(self, "_proc", None), None
        if proc is not None and proc.poll() is None:
            try:
                if proc.stdin:
                    proc.stdin.close()  # EOF = the parent watchdog's shutdown signal
                proc.wait(timeout=timeout)
            except subprocess.TimeoutExpired:
                _kill_tree(proc)
        work, self._work_dir = getattr(self, "_work_dir", None), None
        if work is not None and (proc is None or proc.poll() is not None):
            shutil.rmtree(work, ignore_errors=True)

    def __enter__(self) -> "Backend":
        return self

    def __exit__(self, *exc: Any) -> None:
        self.close()

    def __del__(self) -> None:
        # Best effort, and short: this can run during interpreter shutdown. The
        # stdin pipe closing with this process is the real guarantee.
        try:
            self.close(timeout=2.0)
        except Exception:  # noqa: BLE001
            pass

    def __repr__(self) -> str:
        return f"<phytograph.Backend {self.url} v{getattr(self, 'version', '?')}>"

    # -- API ---------------------------------------------------------------
    @property
    def transport(self) -> Transport:
        return self._transport

    def health(self) -> Dict[str, Any]:
        return self._transport.get_json("/health")

    def _create_body(self, path: PathLike, world_shift, source_units, origin,
                     options: Dict[str, Any]) -> Dict[str, Any]:
        p = Path(path).expanduser().resolve()
        body: Dict[str, Any] = {"source_path": str(p), **options}
        if world_shift is not None:
            body["world_shift"] = list(map(float, world_shift))
        if source_units is not None:
            body["source_units"] = source_units
        if origin is not None:
            body["origin"] = list(map(float, origin))
        return body

    def open_scans(self, path: PathLike, *, world_shift: Optional[Sequence[float]] = None,
                   source_units: Optional[str] = None, origin: Optional[Sequence[float]] = None,
                   **options: Any) -> List["Cloud"]:
        """Import a file as ONE CLOUD PER SCAN POSITION, as the app does. An E57
        with several scans or a PTX with several blocks gives several clouds,
        each with its own scanner pose; any other file gives a list of one."""
        from .cloud import Cloud
        body = self._create_body(path, world_shift, source_units, origin, options)
        res = self._transport.post_stream("/api/cloud/session/create-multi", body)
        if not isinstance(res, dict) or res.get("error") or "scans" not in res:
            err = res.get("error") if isinstance(res, dict) else res
            raise PhytographError(f"Import of {body['source_path']} failed: {err}", detail=res)
        clouds: List[Cloud] = []
        failed = []
        for entry in res["scans"]:
            sess = entry.get("session")
            if entry.get("error") or not sess:
                failed.append(f"{entry.get('name')}: {entry.get('error')}")
                continue
            clouds.append(Cloud(self, sess["session_id"], info=sess, name=entry.get("name")))
        if failed:
            for c in clouds:
                c.close()
            raise PhytographError(f"Import of {body['source_path']} failed for "
                                  + "; ".join(failed), detail=res)
        return clouds

    def open(self, path: PathLike, *, world_shift: Optional[Sequence[float]] = None,
             source_units: Optional[str] = None, scan_index: Optional[int] = None,
             origin: Optional[Sequence[float]] = None, **options: Any) -> "Cloud":
        """Import a point cloud file (LAS/LAZ/E57/PLY/PCD/PTX/XYZ/…) into a cloud
        session and return its :class:`Cloud`. The file is read once; every later
        operation works on the session.

        A file holding several scan positions (multi-scan E57, multi-block PTX)
        is not merged: pass ``scan_index=i`` for one of them, or use
        :meth:`open_scans` for all. Extra keyword options are passed through to
        ``CloudSessionCreateRequest`` (e.g. ``ascii_format``, ``drop_slugs``)."""
        from .cloud import Cloud
        body = self._create_body(path, world_shift, source_units, origin, options)
        if scan_index is None:
            clouds = self.open_scans(path, world_shift=world_shift, source_units=source_units,
                                     origin=origin, **options)
            if len(clouds) == 1:
                return clouds[0]
            names = [c.name for c in clouds]
            for c in clouds:
                c.close()
            raise PhytographError(
                f"{Path(path).name} holds {len(names)} scan positions; merging them would "
                f"put every scan under one scanner pose. Use open_scans() for all of them, "
                f"or open(..., scan_index=i) for one.", detail={"scans": names})
        body["scan_index"] = int(scan_index)
        info = self._transport.post_stream("/api/cloud/session/create", body)
        if not isinstance(info, dict) or info.get("error") or "session_id" not in info:
            err = info.get("error") if isinstance(info, dict) else info
            raise PhytographError(f"Import of {body['source_path']} failed: {err}", detail=info)
        return Cloud(self, info["session_id"], info=info,
                     name=f"{Path(path).stem} — scan {int(scan_index) + 1}")

    def from_numpy(self, positions: "np.ndarray", *, colors: Optional["np.ndarray"] = None,
                   intensity: Optional["np.ndarray"] = None, timestamp: Optional["np.ndarray"] = None,
                   columns: Optional[Dict[str, "np.ndarray"]] = None,
                   world_shift: Optional[Sequence[float]] = None,
                   name: Optional[str] = None) -> "Cloud":
        """A cloud from arrays already in memory — a simulation, another
        library's output, or points you edited with NumPy.

        ``positions`` is (N, 3) world coordinates. ``colors`` (N, 3) and
        ``intensity`` (N,) are 0-1 floats (uint8 / uint16 colors are rescaled); ``timestamp`` (N,) is kept at float64. ``columns`` maps names
        to (N,) per-point values — ``{"is_miss": ...}`` marks sky/miss rows as an
        imported scan's would. ``world_shift`` is subtracted for precision, as
        the import wizard's global shift; reads still return world coordinates.
        """
        import io
        import numpy as np
        from .cloud import Cloud
        members: Dict[str, np.ndarray] = {"positions": np.asarray(positions, dtype=np.float64)}
        if colors is not None:
            c = np.asarray(colors)
            if c.dtype.kind in "iu":
                # 8- or 16-bit color by dtype; a generic int array by its range.
                scale = {np.dtype(np.uint8): 255.0, np.dtype(np.uint16): 65535.0}.get(
                    c.dtype, 255.0 if c.max(initial=0) <= 255 else 65535.0)
                c = c.astype(np.float64) / scale
            members["colors"] = np.asarray(c, dtype=np.float32)
        if intensity is not None:
            members["intensity"] = np.asarray(intensity, dtype=np.float32)
        if timestamp is not None:
            members["timestamp"] = np.asarray(timestamp, dtype=np.float64)
        for k, v in (columns or {}).items():
            if k in members:
                raise ValueError(f"column {k!r} clashes with a built-in member; pass it by keyword")
            members[k] = np.asarray(v)
        buf = io.BytesIO()
        np.savez(buf, **members)
        params = {}
        if world_shift is not None:
            params["world_shift"] = ",".join(repr(float(v)) for v in world_shift)
        info = self._transport.post_bytes("/api/cloud/session/create-from-arrays",
                                          buf.getvalue(), params=params)
        return Cloud(self, info["session_id"], info=info, name=name or "arrays")

    def lad(self, scans: Sequence["Scan"], grid: "Grid", **options: Any) -> "LADResult":
        """Leaf area density by Beer's-law inversion over a voxel ``grid``,
        from one or more :class:`~phytograph.results.Scan` positions.

        Unlike every other tool this one NEEDS the sky/miss points (they are the
        transmitted beams), so import scans with their misses. Options are
        ``LADComputeRequest`` fields: ``lmax``, ``max_aspect_ratio``,
        ``min_voxel_hits``, ``gtheta``/``gtheta_override``, ``element_width``,
        ``terrain_follow``, …"""
        from .results import LADResult
        body = {"scans": [s._entry() for s in scans], "grid": grid._body(), **options}
        res = self._transport.post_stream("/api/lad/compute", body)
        if not isinstance(res, dict) or not res.get("success"):
            err = res.get("error") if isinstance(res, dict) else res
            raise PhytographError(f"LAD failed: {err}", detail=res)
        return LADResult._from(res)

    def cloud(self, session_id: str) -> "Cloud":
        """A handle on an existing session (e.g. one the app created)."""
        from .cloud import Cloud
        return Cloud(self, session_id)


def _kill_tree(proc: subprocess.Popen) -> None:
    try:
        if sys.platform == "win32":
            subprocess.run(["taskkill", "/PID", str(proc.pid), "/T", "/F"],
                           stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        else:
            os.killpg(proc.pid, signal.SIGKILL)
    except (OSError, ProcessLookupError):
        pass
    try:
        proc.wait(timeout=5)
    except subprocess.TimeoutExpired:
        pass


def _progress_printer() -> ProgressFn:
    try:
        from tqdm import tqdm  # type: ignore
    except ImportError:
        last = {"msg": None}

        def _print(frac: Optional[float], msg: str) -> None:
            if msg and msg != last["msg"]:
                pct = f"{frac * 100:5.1f}% " if frac is not None else ""
                print(f"  {pct}{msg}", file=sys.stderr)
                last["msg"] = msg
        return _print

    bar = {"b": None}

    def _tqdm(frac: Optional[float], msg: str) -> None:
        if bar["b"] is None or (frac is not None and frac < bar["b"].n / 1000 - 1e-9):
            if bar["b"] is not None:
                bar["b"].close()
            bar["b"] = tqdm(total=1000, leave=False)
        b = bar["b"]
        if frac is not None:
            b.update(max(0, int(frac * 1000) - b.n))
        if msg:
            b.set_description_str(msg)
    return _tqdm

