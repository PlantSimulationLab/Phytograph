"""The scripting guide (docs/docs/guide/scripting.md) agrees with the package.

The guide and the agent skill are written separately, so they can drift. Every
call in the guide is bound against the real signature (the same check the
skill gets), every recipe it lists exists, and its table of defaults that
differ from the app's agrees with the signatures. No backend needed."""
from __future__ import annotations

import ast
import inspect
import re
from pathlib import Path

import phytograph as pg
from phytograph import recipes

from _snippets import check_markdown

GUIDE = Path(__file__).resolve().parents[2] / "docs" / "docs" / "guide" / "scripting.md"


def test_every_call_in_the_guide_binds_against_the_real_signature():
    problems = check_markdown(GUIDE.read_text())
    assert not problems, "\n".join(problems)


def test_the_recipe_table_lists_exactly_the_public_recipes():
    section = GUIDE.read_text().split("## Recipes")[1].split("\n## ")[0]
    named = set(re.findall(r"^\| `(\w+)\(", section, re.M))
    public = {n for n in recipes.__all__ if callable(getattr(recipes, n))
              and not isinstance(getattr(recipes, n), type)}
    assert named == public, named ^ public


def test_the_defaults_table_matches_the_signatures():
    text = GUIDE.read_text()
    table = text.split("A few defaults differ from the app's:")[1].split("\n\n")[1]
    rows = [r for r in table.splitlines() if r.startswith("| `")]
    assert len(rows) >= 4
    for row in rows:
        tool, script, _app = [c.strip() for c in row.strip("|").split("|")]
        name = tool.strip("`").removeprefix("be.")
        fn = getattr(pg.Cloud, name, None) or getattr(pg.Backend, name)
        sig = inspect.signature(fn)
        for k, v in re.findall(r"`(\w+)=([^`]+)`", script):
            assert sig.parameters[k].default == ast.literal_eval(v), (name, k)
