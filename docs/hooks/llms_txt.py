"""MkDocs hook: write ``llms.txt`` and ``llms-full.txt`` into the built site.

``llms.txt`` (https://llmstxt.org) is a Markdown index an AI agent can read
instead of crawling HTML: a title, a one-paragraph summary, and link lists.
``llms-full.txt`` is the full Markdown of the same pages, concatenated, plus
the agent skill shipped in the Python package. Both are generated from the
nav and the page sources on every build, so they cannot go stale.

The functions below take plain data (the nav list, the docs folder) so
``python/tests/test_llms_txt.py`` can run them on the real tree without
MkDocs.
"""
from __future__ import annotations

import re
from pathlib import Path
from typing import Iterable, List, Optional, Tuple

# (heading in llms.txt, nav prefix of the pages it lists, part of llms-full.txt)
SECTIONS = [
    ("Scripting with Python", ("guide/scripting.md",
                               "developers/architecture/scripting-client.md"), True),
    ("User guide", ("guide/",), True),
    ("Concepts", ("concepts/",), True),
    ("Optional", ("workflows/", "reference/"), False),
]
SKILL = Path("python/phytograph/skills/phytograph")   # relative to the repo root

INSTALLED_FIRST = (
    "If the `phytograph` Python package is installed, its own agent skill matches the installed "
    "version and wins over anything here: `python -m phytograph skills path` prints its folder, "
    "and `python -m phytograph agent-files` writes it into a project as `AGENTS.md`.")


def flatten(nav: list) -> List[Tuple[str, str]]:
    """[(title or '', path)] in nav order."""
    out: List[Tuple[str, str]] = []
    for item in nav:
        if isinstance(item, str):
            out.append(("", item))
        elif isinstance(item, dict):
            for title, value in item.items():
                if isinstance(value, str):
                    out.append((title, value))
                else:
                    out.extend(flatten(value))
    return out


def page_title(docs_dir: Path, path: str, nav_title: str) -> str:
    text = (docs_dir / path).read_text(encoding="utf-8")
    m = re.search(r"^# (.+)$", text, re.M)
    return nav_title or (m.group(1).strip() if m else path)


def page_blurb(docs_dir: Path, path: str, limit: int = 220) -> str:
    """The first prose paragraph after the H1, flattened to one line."""
    text = (docs_dir / path).read_text(encoding="utf-8")
    text = re.sub(r"^---\n.*?\n---\n", "", text, flags=re.S)
    after = text.split("\n# ", 1)[-1].split("\n", 1)[-1]
    for para in re.split(r"\n\s*\n", after):
        p = para.strip()
        if not p or p[0] in "#!|<`-*>" or p.startswith("```") or p.startswith("!["):
            continue
        p = re.sub(r"\s+", " ", p)
        p = re.sub(r"\[([^\]]+)\]\([^)]+\)", r"\1", p)
        return p if len(p) <= limit else p[:limit].rsplit(" ", 1)[0] + "…"
    return ""


def url_for(site_url: str, path: str) -> str:
    rel = path[:-3]
    if rel == "index" or rel.endswith("/index"):
        rel = rel[:-5]
    else:
        rel += "/"
    return site_url.rstrip("/") + "/" + rel


def select(nav: list) -> List[Tuple[str, List[Tuple[str, str]], bool]]:
    """[(section heading, [(nav title, path)], full)] with each page in the
    first section that claims it."""
    pages = flatten(nav)
    seen = set()
    out = []
    for heading, prefixes, full in SECTIONS:
        chosen = [(t, p) for t, p in pages
                  if p not in seen and any(p == x or (x.endswith("/") and p.startswith(x))
                                           for x in prefixes)]
        seen.update(p for _, p in chosen)
        out.append((heading, chosen, full))
    return out


def resolve_snippets(text: str, repo_root: Path) -> str:
    """Inline ``--8<-- "path"`` lines (pymdownx.snippets, base_path = repo root)."""
    def inline(m: re.Match) -> str:
        return (repo_root / m.group(2)).read_text(encoding="utf-8").rstrip("\n")
    return re.sub(r'^(\s*)--8<--\s+"([^"]+)"\s*$', inline, text, flags=re.M)


def llms_txt(nav: list, docs_dir: Path, site_url: str, site_name: str, summary: str) -> str:
    lines = [f"# {site_name}", "", f"> {summary}", "", INSTALLED_FIRST, ""]
    for heading, pages, _ in select(nav):
        if not pages:
            continue
        lines += [f"## {heading}", ""]
        for title, path in pages:
            blurb = page_blurb(docs_dir, path)
            lines.append(f"- [{page_title(docs_dir, path, title)}]({url_for(site_url, path)})"
                         + (f": {blurb}" if blurb else ""))
        lines.append("")
    return "\n".join(lines)


def llms_full_txt(nav: list, docs_dir: Path, site_url: str, site_name: str, summary: str,
                  repo_root: Path) -> str:
    parts = [f"# {site_name}", "", f"> {summary}", "", INSTALLED_FIRST, ""]
    for heading, pages, full in select(nav):
        if not full:
            continue
        for title, path in pages:
            body = resolve_snippets((docs_dir / path).read_text(encoding="utf-8"), repo_root)
            parts += ["", "---", "", f"Source: {url_for(site_url, path)}", "", body.strip(), ""]
    skill_dir = repo_root / SKILL
    if skill_dir.is_dir():
        parts += ["", "---", "",
                  "The agent skill shipped in the `phytograph` package, as on the main branch. "
                  "An installed package carries the copy for its own version.", ""]
        for f in [skill_dir / "SKILL.md", *sorted((skill_dir / "references").glob("*.md"))]:
            parts += [f"Source: {(SKILL / f.relative_to(skill_dir)).as_posix()}", "",
                      f.read_text(encoding="utf-8").strip(), ""]
    return "\n".join(parts) + "\n"


def on_post_build(config, **kwargs) -> None:
    docs_dir = Path(config["docs_dir"])
    repo_root = Path(config["config_file_path"]).resolve().parent.parent
    site_dir = Path(config["site_dir"])
    args = (config["nav"], docs_dir, config["site_url"], config["site_name"],
            config["site_description"])
    (site_dir / "llms.txt").write_text(llms_txt(*args), encoding="utf-8")
    (site_dir / "llms-full.txt").write_text(llms_full_txt(*args, repo_root), encoding="utf-8")
