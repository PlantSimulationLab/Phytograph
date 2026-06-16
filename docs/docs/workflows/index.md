# Workflows

Step-by-step recipes for the common tasks. Each workflow is
self-contained — start at the top, follow along, end with a result.

Every operation is reachable from the always-visible toolbar (left of the
viewer) and from the menu bar. The **menu bar** has three menus: **Create**
(build the scene — geometry and scanner placement), **Simulate** (synthesize
scans), and **Tools** (analysis operations on existing data — pre-processing,
segmentation, reconstruction). The **left toolbar** shows two of these as
blocks — **Create** and **Tools**; the Simulate action (Run Synthetic Scan)
lives in the Simulate menu and on the Scans panel. These workflows are grouped
by the four stages of a typical processing pipeline.

## Getting around

<div class="grid cards" markdown>

- :material-file-import: **[Import & export](import-export.md)** — getting data in and out of Phytograph.

- :material-rotate-3d-variant: **[Viewer navigation](viewer-navigation.md)** — moving the camera, switching color modes, isolating an object.

</div>

## 1. Pre-processing

<div class="grid cards" markdown>

- :material-broom: **[Clean a point cloud](clean-point-cloud.md)** — translate, crop, erase, filter, resample. Get a scan ready for analysis.

- :material-compare: **[Register & compare](register-compare.md)** — align clouds with ICP and stitch overlapping scans into one.

</div>

## 2. Segmentation

<div class="grid cards" markdown>

- :material-terrain: **[Segment ground points](segment-ground.md)** — classify and remove the ground with the Cloth Simulation Filter.

- :material-leaf: **[Separate leaf and wood](segment-wood.md)** — split a scan into woody and foliage points by local geometry.

- :material-forest: **[Segment individual trees](segment-trees.md)** — separate a multi-tree cloud into per-tree instances.

</div>

## 3. Reconstruction & analysis

<div class="grid cards" markdown>

- :material-vector-triangle: **[Triangulate a mesh](triangulate.md)** — Delaunay, Ball Pivot, Poisson, and Helios multi-scan triangulation.

- :material-graph: **[Extract a skeleton](extract-skeleton.md)** — pull branch topology out of a woody scan or mesh.

- :phytograph-qsm: **[Build a QSM](build-qsm.md)** — reconstruct a dormant tree as connected cylinders with radii, continuous shoots, and shoot rank.

- :material-flower: **[Add leaves to a QSM](add-leaves.md)** — place leaves on terminal shoots using phyllotaxis.

- :material-angle-acute: **[Adjust leaf angles](adjust-leaf-angles.md)** — match a measured leaf-angle distribution on a foliated QSM.

- :material-grid: **[Estimate leaf area density](estimate-leaf-area-density.md)** — invert overlapping scans against a voxel grid into an LAD grid (m²/m³).

</div>

## 4. Scan simulation

<div class="grid cards" markdown>

- :material-sprout: **[Generate a plant](generate-plant.md)** — produce a procedural plant from species, age, and position.

- :material-dna: **[Morph a plant](morph-plant.md)** — edit geometry parameters interactively and regrow.

- :material-radar: **[Simulate a LiDAR scan](simulate-scan.md)** — place a virtual scanner and synthesize the point cloud it would produce.

</div>
