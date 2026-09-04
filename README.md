# Phytograph

A desktop application for measuring, comparing, and modeling plant
architecture from LiDAR scans — built for plant scientists who work with
point clouds, meshes, and procedural plant models.

📖 **Full documentation & user guide**: <https://plantsimulationlab.github.io/Phytograph/>

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
OS) are in the **[Install guide](https://plantsimulationlab.github.io/Phytograph/guide/install/)**.

### Updates

Phytograph checks for updates on launch and can also be updated on demand via
**Check for Updates…** — in the **Phytograph** app menu on macOS, or under
**Help** on Windows and Linux. When a newer release is available it downloads
and installs in place — no need to return here to re-download.

---

## What it does

- **Import LiDAR scans** — drag and drop `.las`, `.laz`, `.e57`, `.ptx`, `.ply`,
  `.pcd`, or ASCII (`.xyz`, `.txt`, `.csv`, `.pts`, `.asc`) point clouds into a
  3D viewer that handles tens of millions of points. RIEGL `.riproject` and
  `.PROJ` scanner projects import directly.
- **Clean and prepare** — transform, crop, erase, filter, resample, and
  cross-section a cloud, then backfill the sky/miss rays that leaf area density
  depends on.
- **Register and compare** — auto-register rotated scans, refine with ICP, and
  stitch overlaps into one cloud, with cloud-to-mesh distance statistics (mean,
  median, percentiles, and coverage at fractions of the bounding-box diagonal).
- **Segment scans** — classify ground with a cloth simulation filter, separate
  wood from leaf, and split a plot into individual trees, then carry the labels
  through the rest of the pipeline.
- **Label points by hand** — paint your own classes with a lasso or brush to
  correct a classifier or build ground truth, with per-class counts and undo.
- **Measure leaf angles** — triangulate a leaf-on scan into leaf surfaces and
  read their orientations: inclination and azimuth distributions, canonical
  de Wit fits, and the *G(θ)* that leaf area density depends on. The same
  triangulation also reconstructs branch and canopy surfaces.
- **Extract skeletons** — pull topological skeletons out of woody scans, with
  branch order colored by Strahler number and total length reported.
- **Build QSMs** — reconstruct dormant trees as connected cylinders with fitted
  radii, segment continuous shoots, and classify them by shoot rank, with woody
  volume, trunk diameter, and per-rank metrics. Add leaves by phyllotaxis and
  match a measured leaf-angle distribution.
- **Measure canopy structure** — invert overlapping scans into a voxel grid of
  leaf area density (m²/m³), and fit crown shapes (ellipsoid, prism, cone,
  alpha shape) for height and volume.
- **Model the terrain** — grid classified ground returns into a bare-earth
  DEM/DTM, with hillshade, slope, and aspect layers, plus the top-of-canopy DSM
  and the canopy height model that comes from subtracting them.
- **Generate procedural plants** — grow Helios plant models (trees, vines,
  cereals, vegetables, weeds) to a target age, then morph their parameters
  interactively.
- **Simulate a scan** — place virtual scanners (static or moving-platform)
  around a plant and synthesize the point cloud they would produce, with full
  control over beam geometry.

See the **[User Guide](https://plantsimulationlab.github.io/Phytograph/guide/)**
and **[Workflows](https://plantsimulationlab.github.io/Phytograph/workflows/)**
for task-by-task walkthroughs.

---

## Building from source / contributing

The instructions above are for **using** Phytograph. If you want to build it
from source, run a development instance, or contribute, see the
**[Developer documentation](https://plantsimulationlab.github.io/Phytograph/developers/)**,
which covers the [setup and dev loop](https://plantsimulationlab.github.io/Phytograph/developers/getting-started/installation/),
the [architecture](https://plantsimulationlab.github.io/Phytograph/developers/architecture/),
and the release process.

---

Phytograph is developed at the [Bailey Lab](https://baileylab.ucdavis.edu/) at
UC Davis. Its procedural plant generation and scan-simulation features are
powered by the [Helios](https://baileylab.ucdavis.edu/software/helios/)
plant-modeling framework.
