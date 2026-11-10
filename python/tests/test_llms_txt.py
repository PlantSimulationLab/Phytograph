"""docs/hooks/llms_txt.py: the llms.txt / llms-full.txt the docs build writes,
run on the real docs tree without MkDocs. No backend needed."""
from __future__ import annotations

import importlib.util
import re
from pathlib import Path

import yaml

ROOT = Path(__file__).resolve().parents[2]
DOCS = ROOT / "docs" / "docs"
_spec = importlib.util.spec_from_file_location("llms_txt", ROOT / "docs" / "hooks" / "llms_txt.py")
llms = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(llms)


class _Loader(yaml.SafeLoader):
    pass


# mkdocs.yml uses !!python/name tags for extensions; the nav needs none of them.
_Loader.add_multi_constructor("tag:yaml.org,2002:python/", lambda loader, suffix, node: None)


def _config():
    cfg = yaml.load((ROOT / "docs" / "mkdocs.yml").read_text(), Loader=_Loader)
    assert "hooks/llms_txt.py" in cfg["hooks"], "the hook is not registered in mkdocs.yml"
    return cfg


def _render():
    cfg = _config()
    args = (cfg["nav"], DOCS, cfg["site_url"], cfg["site_name"], cfg["site_description"])
    return cfg, llms.llms_txt(*args), llms.llms_full_txt(*args, ROOT)


def test_llms_txt_links_every_guide_concepts_and_scripting_page():
    cfg, index, _ = _render()
    assert index.startswith(f"# {cfg['site_name']}\n\n> ")
    pages = [p for _, p in llms.flatten(cfg["nav"])]
    wanted = [p for p in pages if p.startswith(("guide/", "concepts/"))] + [
        "developers/architecture/scripting-client.md"]
    for p in wanted:
        assert llms.url_for(cfg["site_url"], p) in index, p
    # Every link points at a page that exists.
    for url in re.findall(r"\]\((https://[^)]+)\)", index):
        rel = url[len(cfg["site_url"]):].rstrip("/")
        assert (DOCS / f"{rel}.md").is_file() or (DOCS / rel / "index.md").is_file(), url
    assert "## Optional" in index
    assert "python -m phytograph skills path" in index


def test_llms_full_txt_holds_the_pages_and_the_skill():
    _, _, full = _render()
    scripting = (DOCS / "guide" / "scripting.md").read_text().strip()
    assert scripting in full
    skill = ROOT / "python" / "phytograph" / "skills" / "phytograph"
    for f in [skill / "SKILL.md", *(skill / "references").glob("*.md")]:
        assert f.read_text().strip() in full, f.name
    assert "--8<--" not in full
    assert "Source: https://" in full


def test_snippet_lines_are_inlined(tmp_path):
    (tmp_path / "x.md").write_text("included\n")
    assert llms.resolve_snippets('a\n--8<-- "x.md"\nb', tmp_path) == "a\nincluded\nb"


def test_urls_follow_directory_urls():
    assert llms.url_for("https://e.org/P/", "guide/index.md") == "https://e.org/P/guide/"
    assert llms.url_for("https://e.org/P/", "guide/install.md") == "https://e.org/P/guide/install/"
    assert llms.url_for("https://e.org/P/", "index.md") == "https://e.org/P/"
