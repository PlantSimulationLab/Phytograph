# Phytograph: start here (AI coding agents)

Phytograph processes LiDAR point clouds of plants and trees: import, clean, segment ground,
trees, wood and organs, DEM and heights, QSM, skeleton, inventory, registration, and leaf area
density. It is a desktop app (Electron) plus a Python package, `phytograph`, that runs the same
processing engine headless. **If you are here to process point clouds, use the package; you do
not need the app or this repository's source.**

## Using the package

```bash
pip install phytograph
```

```python
import phytograph as pg
from phytograph import recipes

with pg.Backend() as be, be.open("tree.laz") as cloud:   # starts a private engine process
    qsm, record = recipes.tree_qsm(cloud)
    print(qsm.metrics["trunk_diameter_mm"], record.advisories)
```

- `pg.Backend()` starts the engine and talks to it over loopback HTTP. The first run downloads
  it (~400 MB, cached per version); `python -m phytograph download` fetches it ahead of time.
- **Read the skill before writing code.** It holds the recipes, the order of operations, where
  the defaults differ from the app's, and how to read each result. In this repository:
  `python/phytograph/skills/phytograph/SKILL.md` (and its `references/`). From an installed
  package: `python -m phytograph skills path`. The installed copy matches the installed version;
  prefer it.
- **Start from a recipe** (`python/phytograph/recipes.py`), not from the individual tools.
- Every tool has an explicit signature: `help(pg.Cloud.qsm)`. Never guess a parameter.
- In the user's own project, `python -m phytograph agent-files` writes an `AGENTS.md` with this
  guidance for the installed version.
- Guide: https://plantsimulationlab.github.io/Phytograph/guide/scripting/

If the skill was wrong or missing something you needed, end your reply with a one-line
proposed addition to it. Do not edit the skill unless the user asks.

## Changing Phytograph itself

Contributor documentation is in `docs/docs/developers/` (start with
`docs/docs/developers/architecture/index.md`; the package is described in
`docs/docs/developers/architecture/scripting-client.md`). A maintainer's checkout also has a
developer guide in `CLAUDE.md`, which is not in the repository; read it when present.
