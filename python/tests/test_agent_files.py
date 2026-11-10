"""`python -m phytograph agent-files` and `skills install`: the guidance an agent
finds in a user's project. No backend needed."""
from __future__ import annotations

import re
from pathlib import Path

import pytest

import phytograph as pg
from phytograph import __main__ as cli
from phytograph import _agent_files as af

SKILL_DIR = pg.skills_dir() / "phytograph"


def _run(*argv) -> int:
    return cli.main(list(map(str, argv)))


def test_agents_md_is_the_installed_skill_plus_generated_facts(tmp_path):
    assert _run("agent-files", tmp_path) == 0
    text = (tmp_path / "AGENTS.md").read_text()
    lines = text.splitlines()
    assert lines[0] == af.MARKER_LINE
    assert f"`phytograph` {pg.__version__}" in text
    assert f"engine {pg.EXPECTED_BACKEND_VERSION}" in text
    assert SKILL_DIR.as_posix() in text
    # The body IS the skill (one source): every non-heading line of SKILL.md's
    # body appears, with references/ links made absolute.
    body = af.skill_body(SKILL_DIR)
    for line in body.splitlines()[1:]:
        assert line in lines, f"AGENTS.md is missing a skill line: {line!r}"
    for link in re.findall(r"\]\(([^)]+)\)", text):
        if link.startswith("/"):
            assert (SKILL_DIR / "references").as_posix() in link
            assert Path(link).is_file(), link
    assert "](references/" not in text
    assert text.count("\n# ") == 1, "one H1 only"


def test_claude_md_imports_agents_md(tmp_path):
    _run("agent-files", tmp_path)
    assert (tmp_path / "CLAUDE.md").read_text() == f"{af.MARKER_LINE}\n\n@AGENTS.md\n"


def test_the_marker_rule(tmp_path, capsys):
    _run("agent-files", tmp_path)
    capsys.readouterr()
    _run("agent-files", tmp_path)
    assert capsys.readouterr().out.count(": unchanged") == 2
    # A managed file whose content is stale is rewritten.
    p = tmp_path / "AGENTS.md"
    p.write_text(af.MARKER_LINE + "\n\nold guidance\n")
    _run("agent-files", tmp_path)
    assert p.read_text() == af.agents_md()
    # Without the marker on the first line the file is the user's.
    own = "My notes\n" + af.MARKER_LINE + "\n"
    p.write_text(own)
    _run("agent-files", tmp_path)
    assert p.read_text() == own
    assert "user-owned" in capsys.readouterr().out


def test_a_users_claude_md_without_the_import_gets_a_note(tmp_path, capsys):
    (tmp_path / "CLAUDE.md").write_text("# my project\n")
    _run("agent-files", tmp_path)
    err = capsys.readouterr().err
    assert "@AGENTS.md" in err
    assert (tmp_path / "CLAUDE.md").read_text() == "# my project\n"
    (tmp_path / "CLAUDE.md").write_text("# my project\n@AGENTS.md\n")
    _run("agent-files", tmp_path)
    assert "@AGENTS.md" not in capsys.readouterr().err


@pytest.mark.parametrize("value", ["0", "off", "false", "no"])
def test_the_opt_out_writes_nothing(tmp_path, monkeypatch, value):
    monkeypatch.setenv(af.ENV_OPT_OUT, value)
    assert _run("agent-files", tmp_path) == 0
    assert list(tmp_path.iterdir()) == []


def test_dry_run_writes_nothing(tmp_path, capsys):
    _run("agent-files", tmp_path, "--dry-run")
    assert list(tmp_path.iterdir()) == []
    assert "would be written" in capsys.readouterr().out


def test_a_missing_directory_is_an_error(tmp_path, capsys):
    assert _run("agent-files", tmp_path / "nope") == 1
    assert "not a directory" in capsys.readouterr().err


def test_skills_install_copies_every_file_and_stamps_it(tmp_path):
    dest = tmp_path / ".claude" / "skills"
    assert _run("skills", "install", "--to", dest) == 0
    for src in SKILL_DIR.rglob("*"):
        if src.is_file() and "__pycache__" not in src.parts:
            dst = dest / "phytograph" / src.relative_to(SKILL_DIR)
            assert dst.read_bytes() == src.read_bytes(), dst
    assert pg.__version__ in (dest / "phytograph" / af.STAMP).read_text()
    # Re-running replaces what it installed.
    (dest / "phytograph" / "SKILL.md").write_text("stale")
    assert _run("skills", "install", "--to", dest) == 0
    assert (dest / "phytograph" / "SKILL.md").read_bytes() == (SKILL_DIR / "SKILL.md").read_bytes()


def test_skills_install_refuses_a_folder_it_did_not_install(tmp_path, capsys):
    mine = tmp_path / "phytograph"
    mine.mkdir()
    (mine / "SKILL.md").write_text("mine")
    assert _run("skills", "install", "--to", tmp_path) == 1
    assert "--force" in capsys.readouterr().err
    assert (mine / "SKILL.md").read_text() == "mine"
    assert _run("skills", "install", "--to", tmp_path, "--force") == 0
    assert (mine / "SKILL.md").read_bytes() == (SKILL_DIR / "SKILL.md").read_bytes()
