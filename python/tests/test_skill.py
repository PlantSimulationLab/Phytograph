"""The agent skill shipped in the package: present, well-formed, and naming only
recipes, tools and keywords that exist. No backend needed."""
from __future__ import annotations

import ast
import inspect
import re
import sys
import zipfile
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / "python"))
import build_wheel  # noqa: E402

import phytograph as pg  # noqa: E402
from phytograph import recipes  # noqa: E402

from _snippets import check_markdown  # noqa: E402

SKILL_DIR = pg.skills_dir() / "phytograph"
SKILL = SKILL_DIR / "SKILL.md"
REFERENCES = sorted((SKILL_DIR / "references").glob("*.md"))
ALL_MD = [SKILL, *REFERENCES]


def frontmatter(text: str) -> dict:
    m = re.match(r"^---\n(.*?)\n---\n", text, re.S)
    assert m, "SKILL.md must open with YAML frontmatter"
    out = {}
    for line in m.group(1).splitlines():
        k, _, v = line.partition(":")
        out[k.strip()] = v.strip()
    return out


def _section(text: str, heading: str) -> str:
    return text.split(heading)[1].split("\n## ")[0]


def test_the_skill_is_well_formed():
    meta = frontmatter(SKILL.read_text())
    # agentskills.io: name matches the folder, lowercase-hyphen, description present and bounded.
    assert meta["name"] == SKILL.parent.name
    assert re.fullmatch(r"[a-z0-9-]{1,64}", meta["name"])
    assert 0 < len(meta["description"]) <= 1024


def test_the_entry_file_stays_the_decision_core():
    # Progressive disclosure: the long "reading results" material lives in
    # references/, loaded on demand. Grow a reference file, not the entry.
    assert len(SKILL.read_text().splitlines()) <= 140


def test_every_reference_is_linked_and_every_link_resolves():
    text = SKILL.read_text()
    links = set(re.findall(r"\]\((references/[^)]+)\)", text))
    for link in links:
        assert (SKILL_DIR / link).is_file(), f"SKILL.md links {link}, which does not exist"
    files = {f"references/{p.name}" for p in REFERENCES}
    assert files, "the skill has no reference files"
    assert files == links, f"reference files not linked from SKILL.md: {sorted(files - links)}"


def test_every_recipe_the_skill_names_exists_and_every_recipe_is_named():
    named = set(re.findall(r"`(\w+)\(", _section(SKILL.read_text(), "## Start from a recipe")))
    public = {n for n in recipes.__all__ if callable(getattr(recipes, n))
              and not isinstance(getattr(recipes, n), type)}
    assert named == public, (named ^ public)


def test_every_call_in_the_skill_binds_against_the_real_signature():
    # Catches a misnamed keyword, a positional passed to a keyword-only
    # parameter (`denoise("ror")`), or a keyword the written method ignores.
    problems = []
    for md in ALL_MD:
        problems += [f"{md.relative_to(SKILL_DIR)} {p}" for p in check_markdown(md.read_text())]
    assert not problems, "\n".join(problems)


def test_every_keyword_the_skill_names_belongs_to_some_tool():
    # `name=value` spans outside calls (tables, prose) must still be real keywords.
    keywords = set()
    for owner in (pg.Cloud, pg.Backend):
        for _, fn in inspect.getmembers(owner, callable):
            try:
                keywords |= set(inspect.signature(fn).parameters)
            except (TypeError, ValueError):
                continue
    for fn in (getattr(recipes, n) for n in recipes.__all__):
        if callable(fn):
            keywords |= set(inspect.signature(fn).parameters)
    for md in ALL_MD:
        for name in re.findall(r"`(\w+)=[^`]*`", md.read_text()):
            assert name in keywords, f"{md.name} names `{name}=`, which no tool accepts"


def _tool(name: str):
    name = name.removeprefix("be.").removeprefix("cloud.")
    return getattr(pg.Cloud, name, None) or getattr(pg.Backend, name)


def test_the_api_default_column_is_the_signatures_default():
    rows = [r for r in _section(SKILL.read_text(), "## Where the API's defaults").splitlines()
            if r.startswith("| `")]
    assert rows
    for row in rows:
        tool_cell, api_cell, app_cell = [c.strip() for c in row.strip("|").split("|")]
        fn = _tool(tool_cell.strip("`"))
        sig = inspect.signature(fn)
        for name, value in re.findall(r"`(\w+)=([^`]+)`", api_cell):
            assert sig.parameters[name].default == ast.literal_eval(value), (
                f"SKILL.md says {fn.__qualname__}({name}={value}) by default; "
                f"the signature says {sig.parameters[name].default!r}")
        for name, _ in re.findall(r"`(\w+)=([^`]+)`", app_cell):
            assert name in sig.parameters, f"{fn.__qualname__} has no `{name}`"


def test_the_skill_ships_in_the_wheel(tmp_path):
    whl = build_wheel.build(tmp_path)
    with zipfile.ZipFile(whl) as z:
        for md in ALL_MD:
            entry = "phytograph/skills/" + md.relative_to(pg.skills_dir()).as_posix()
            assert z.read(entry) == md.read_bytes(), entry


def test_setuptools_package_data_covers_every_skill_file():
    # `pip install .` builds with setuptools, not build_wheel.py; its globs
    # must reach every file the skill has.
    import fnmatch
    text = (ROOT / "python" / "pyproject.toml").read_text()
    globs = re.findall(r'"(skills/[^"]+)"', text.split("[tool.setuptools.package-data]")[1])
    for md in ALL_MD:
        rel = md.relative_to(pg.skills_dir().parent).as_posix()
        assert any(fnmatch.fnmatch(rel, g) and rel.count("/") == g.count("/") for g in globs), rel


def test_the_root_agents_md_fits_on_a_screen_and_names_real_paths():
    agents = ROOT / "AGENTS.md"
    text = agents.read_text()
    assert len(text.splitlines()) <= 60
    for path in re.findall(r"`((?:python|docs)/[^`\s]+)`", text):
        assert (ROOT / path).exists(), f"AGENTS.md names {path}, which does not exist"
    assert "agent-files" in text and "skills path" in text
    assert check_markdown(text) == []


PLUGIN = ROOT / "python" / "claude-plugin" / "phytograph"


def test_the_claude_plugin_is_a_pointer_with_the_same_frontmatter():
    import json
    pointer = (PLUGIN / "skills" / "phytograph" / "SKILL.md").read_text()
    head = re.match(r"^---\n.*?\n---\n", SKILL.read_text(), re.S).group(0)
    # Identical frontmatter, so the plugin triggers on exactly the requests the
    # package's own skill does; the body only finds the installed skill.
    assert pointer.startswith(head)
    assert "skills_dir()" in pointer and "agent-files" in pointer
    assert "## Rules that hold for every tool" not in pointer, "the plugin must not copy the skill"
    manifest = json.loads((PLUGIN / ".claude-plugin" / "plugin.json").read_text())
    market = json.loads((ROOT / ".claude-plugin" / "marketplace.json").read_text())
    entry = next(p for p in market["plugins"] if p["name"] == manifest["name"])
    assert (ROOT / entry["source"]).resolve() == PLUGIN.resolve()
    assert "version" not in manifest, "unversioned: the plugin tracks the repository"
    docs = (ROOT / "docs" / "docs" / "guide" / "scripting.md").read_text()
    assert f"claude plugin install {manifest['name']}@{market['name']}" in docs
