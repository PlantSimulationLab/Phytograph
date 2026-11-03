"""Build the phytograph wheel with the standard library only.

The package is pure Python, so its wheel is just a zip of the sources plus a
``.dist-info`` directory (PEP 427). Building it here, rather than with
``pip wheel`` / setuptools, means the app build needs no packaging tools on the
runner and never writes ``build/`` or ``*.egg-info`` into the tree. The output
is byte-for-byte reproducible: entries are sorted and timestamps are fixed.

    python python/build_wheel.py --out resources/python

Run by ``scripts/build-python-wheel.mjs`` from ``npm run build``; the wheel
ships inside the app (``resources/python``) so a user installs the package
that matches their app's backend exactly. Pinned by
``python/tests/test_wheel.py``, which installs the result and imports it.
"""
from __future__ import annotations

import argparse
import base64
import hashlib
import json
import re
import sys
import zipfile
from pathlib import Path

HERE = Path(__file__).resolve().parent
PKG = HERE / "phytograph"
EPOCH = (1980, 1, 1, 0, 0, 0)   # the earliest time a zip entry can carry


def _project() -> dict:
    text = (HERE / "pyproject.toml").read_text(encoding="utf-8")

    def field(name: str) -> str:
        m = re.search(rf'^{name}\s*=\s*"([^"]*)"', text, re.M)
        if not m:
            raise SystemExit(f"build_wheel: no `{name}` in pyproject.toml")
        return m.group(1)

    deps = re.search(r"^dependencies\s*=\s*\[(.*?)\]", text, re.M | re.S)
    extras = dict(re.findall(r'^(\w+)\s*=\s*\[\s*"([^"]+)"\s*\]', text.split("[project.optional-dependencies]")[-1]
                             .split("\n[")[0], re.M))
    return {"name": field("name"), "version": field("version"),
            "summary": field("description"), "requires_python": field("requires-python"),
            "deps": re.findall(r'"([^"]+)"', deps.group(1)) if deps else [], "extras": extras}


def _metadata(p: dict) -> str:
    lines = ["Metadata-Version: 2.1", f"Name: {p['name']}", f"Version: {p['version']}",
             f"Summary: {p['summary']}", "License: MIT",
             f"Requires-Python: {p['requires_python']}"]
    lines += [f"Requires-Dist: {d}" for d in p["deps"]]
    for extra, dep in p["extras"].items():
        lines += [f"Provides-Extra: {extra}", f'Requires-Dist: {dep}; extra == "{extra}"']
    lines += ["Description-Content-Type: text/markdown", ""]
    readme = HERE / "README.md"
    return "\n".join(lines) + "\n" + (readme.read_text(encoding="utf-8") if readme.exists() else "")


def _digest(data: bytes) -> str:
    return "sha256=" + base64.urlsafe_b64encode(hashlib.sha256(data).digest()).rstrip(b"=").decode()


def read_digests(directory: Path) -> dict:
    """{asset: sha256} from the `<asset>.sha256` files pack_backend.py writes."""
    out = {}
    for f in sorted(Path(directory).glob("*.sha256")):
        digest, name = f.read_text().split()[:2]
        out[name] = digest.lower()
    return out


def build(out_dir: Path, *, backend_digests: "dict | None" = None,
          require_platforms: bool = False) -> Path:
    """Build the wheel. `backend_digests` ({asset name: sha256}) is embedded as
    `phytograph/_backend_manifest.json`, pinning the archives a PyPI install
    downloads; with `require_platforms` every published platform must be there."""
    p = _project()
    dist_info = f"{p['name']}-{p['version']}.dist-info"
    files = {}
    for src in sorted(PKG.rglob("*.py")):
        if "__pycache__" in src.parts:
            continue
        files[src.relative_to(HERE).as_posix()] = src.read_bytes()
    if "phytograph/__init__.py" not in files:
        raise SystemExit("build_wheel: phytograph/__init__.py is missing")
    if backend_digests is not None:
        sys.path.insert(0, str(HERE))
        from phytograph import _download
        expected = {_download.asset_name(p["version"], o, a) for o, a in _download.SUPPORTED}
        unknown = set(backend_digests) - expected
        if unknown:
            raise SystemExit(f"build_wheel: digests for unexpected assets {sorted(unknown)}")
        missing = expected - set(backend_digests)
        if require_platforms and missing:
            raise SystemExit(f"build_wheel: no backend digest for {sorted(missing)}; refusing to "
                             "publish a version some platforms could not download.")
        files["phytograph/_backend_manifest.json"] = json.dumps(
            {"version": p["version"], "sha256": dict(sorted(backend_digests.items()))},
            indent=1).encode()
    files[f"{dist_info}/METADATA"] = _metadata(p).encode("utf-8")
    files[f"{dist_info}/WHEEL"] = (
        "Wheel-Version: 1.0\nGenerator: phytograph-build_wheel\n"
        "Root-Is-Purelib: true\nTag: py3-none-any\n").encode()
    files[f"{dist_info}/top_level.txt"] = b"phytograph\n"
    record = "".join(f"{path},{_digest(data)},{len(data)}\n" for path, data in files.items())
    record += f"{dist_info}/RECORD,,\n"
    files[f"{dist_info}/RECORD"] = record.encode()

    out_dir.mkdir(parents=True, exist_ok=True)
    whl = out_dir / f"{p['name']}-{p['version']}-py3-none-any.whl"
    tmp = whl.with_suffix(".tmp")
    with zipfile.ZipFile(tmp, "w", zipfile.ZIP_DEFLATED) as z:
        for path, data in files.items():   # RECORD last, as the spec recommends
            info = zipfile.ZipInfo(path, date_time=EPOCH)
            info.compress_type = zipfile.ZIP_DEFLATED
            info.external_attr = 0o644 << 16
            z.writestr(info, data)
    tmp.replace(whl)
    return whl


def main(argv=None) -> int:
    ap = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    ap.add_argument("--out", required=True, type=Path, help="directory to write the wheel into")
    ap.add_argument("--backend-digests", type=Path,
                    help="directory of <asset>.sha256 files to embed (the release's PyPI wheel)")
    ap.add_argument("--require-all-platforms", action="store_true",
                    help="fail unless every published platform has a digest")
    args = ap.parse_args(argv)
    digests = read_digests(args.backend_digests) if args.backend_digests else None
    for old in args.out.glob("phytograph-*.whl") if args.out.is_dir() else []:
        old.unlink()   # one wheel, the current version, never a stale sibling
    print(build(args.out, backend_digests=digests, require_platforms=args.require_all_platforms))
    return 0


if __name__ == "__main__":
    sys.exit(main())
