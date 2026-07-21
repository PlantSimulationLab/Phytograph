# Phytograph

A desktop application for measuring, comparing, and modeling plant
architecture from LiDAR scans — built for plant scientists who work with
point clouds, meshes, and procedural plant models.

📖 **Full documentation & user guide**: <https://plantsimulationlab.github.io/phytograph/>

Phytograph runs on **macOS** (Apple Silicon and Intel), **Windows 10/11**,
and **Linux** (x64). It ships as a single self-contained app with its own
embedded scientific Python environment — you don't need to install Python,
Conda, or anything else.

---

## Download & install

Get the latest installer from the
**[Releases page](https://github.com/PlantSimulationLab/Phytograph/releases/latest)**:

| Platform | Download |
|---|---|
| macOS (Apple Silicon — M1/M2/M3/M4) | [`Phytograph-arm64.dmg`](https://github.com/PlantSimulationLab/Phytograph/releases/latest/download/Phytograph-arm64.dmg) |
| macOS (Intel) | [`Phytograph-x64.dmg`](https://github.com/PlantSimulationLab/Phytograph/releases/latest/download/Phytograph-x64.dmg) |
| Windows 10/11 | [`Phytograph-Setup.exe`](https://github.com/PlantSimulationLab/Phytograph/releases/latest/download/Phytograph-Setup.exe) |
| Linux (most distros) | [`Phytograph-x86_64.AppImage`](https://github.com/PlantSimulationLab/Phytograph/releases/latest/download/Phytograph-x86_64.AppImage) |

- **macOS** — open the `.dmg`, drag **Phytograph** into **Applications**, and
  launch it. The build is signed and notarized by Apple, so it opens with a
  normal double-click.
- **Windows** — run the installer. If SmartScreen warns you, choose
  **More info → Run anyway**.
- **Linux** — `chmod +x Phytograph-x86_64.AppImage` and run it. (Needs FUSE;
  on a minimal install use `--appimage-extract-and-run`.)

The first launch takes about 30 seconds while the bundled Python environment
unpacks itself; subsequent launches are instant.

Full step-by-step install instructions (including first-launch notes for each
OS) are in the **[Install guide](https://plantsimulationlab.github.io/phytograph/guide/install/)**.

### Updates

Phytograph checks for updates on launch and can also be updated on demand via
**Help → Check for Updates…**. When a newer release is available it downloads
and installs in place — no need to return here to re-download.

---

## What it does

- **Import LiDAR scans** — drag and drop `.las`, `.laz`, `.xyz`, `.ply`, `.e57`,
  or `.csv` point clouds into a 3D viewer that handles tens of millions of points.
- **Reconstruct meshes** — triangulate point clouds with Delaunay, Ball Pivot,
  or Poisson, or run multi-scan Helios triangulation for branch surfaces from
  terrestrial LiDAR.
- **Extract skeletons** — pull topological skeletons out of woody scans, with
  branch order colored by Strahler number.
- **Build QSMs** — reconstruct dormant trees as connected cylinders with fitted
  radii, segment continuous shoots, and classify them by shoot rank, with woody
  volume, trunk diameter, and per-rank metrics.
- **Segment** ground, leaf/wood, and individual trees.
- **Estimate leaf area density** from single- or multi-return scans.
- **Generate procedural plants** — grow Helios plant models (trees, vines,
  cereals, vegetables) to a target age, then morph their parameters interactively.
- **Register and compare** — cloud-to-cloud, mesh-to-mesh, and cloud-to-mesh
  ICP with RMSE and distance heatmaps.
- **Simulate a scan** — place virtual scanners (static or moving-platform) around
  a plant and synthesize the point cloud they would produce.

See the **[User Guide](https://plantsimulationlab.github.io/phytograph/guide/)**
and **[Workflows](https://plantsimulationlab.github.io/phytograph/workflows/)**
for task-by-task walkthroughs.

---

## Building from source / contributing

The instructions above are for **using** Phytograph. If you want to build it
from source, run a development instance, or contribute, see the
**[Developer documentation](https://plantsimulationlab.github.io/phytograph/developers/)**,
which covers the [setup and dev loop](https://plantsimulationlab.github.io/phytograph/developers/getting-started/installation/),
the [architecture](https://plantsimulationlab.github.io/phytograph/developers/architecture/),
and the release process.

---

Phytograph is developed at the [Bailey Lab](https://baileylab.ucdavis.edu/) at
UC Davis. Its procedural plant generation and scan-simulation features are
powered by the [Helios](https://baileylab.ucdavis.edu/software/helios/)
plant-modeling framework.
