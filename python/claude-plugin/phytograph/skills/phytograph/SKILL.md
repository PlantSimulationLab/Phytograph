---
name: phytograph
description: Process LiDAR point clouds of plants and trees headless with the phytograph Python package - clean, segment ground/trees/wood/organs, DEM and heights, QSM, skeleton, inventory, registration, leaf area density. Use when a task needs measurements from a point cloud (.las/.laz/.e57/.ply/.pcd/.ptx/.xyz) or a cloud from a simulation reduced the way a real scan would be.
---

# Phytograph from Python (plugin entry)

The instructions for the `phytograph` package ship inside the package, so that they always match
the installed version. This plugin follows the repository's main branch, not the user's install,
so it holds no instructions of its own: it finds the installed ones.

1. **Find the package.** Use the Python the user's project uses (its virtual environment if it
   has one) and run
   `python -c "import phytograph; print(phytograph.__version__, phytograph.skills_dir())"`.
   If the import fails, ask the user before installing: `pip install phytograph`.
2. **Read the installed skill in full and follow it**: `<skills_dir>/phytograph/SKILL.md`. It
   names reference files beside it (`references/*.md`); read the one for the tool you run before
   reporting its results.
3. **Offer to put the guidance in the project** so later sessions start with it:
   `python -m phytograph agent-files` (writes `AGENTS.md` and a `CLAUDE.md` that imports it).
   If the project already has its own `CLAUDE.md` without the line `@AGENTS.md`, tell the user.

If `phytograph.skills_dir` does not exist, the installed package predates the shipped skill.
Tell the user to upgrade (`pip install -U phytograph`); until then, work from `help(pg.Cloud)`
and https://plantsimulationlab.github.io/Phytograph/guide/scripting/.
