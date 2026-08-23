# Workflows

Step-by-step recipes for the common tasks. Each workflow is
self-contained — start at the top, follow along, end with a result.

Every operation is reachable from the always-visible toolbar (left of the
viewer) and from the menu bar. Tools are spread across three menus: **Create**
(build the scene — geometry and scanner placement), **Simulate** (synthesize
scans), and **Tools** (analysis operations on existing data — pre-processing,
segmentation, reconstruction & analysis, registration). The **left toolbar**
shows two of these as blocks — **Create** and **Tools**; the Simulate action
(Run Synthetic Scan) lives in the Simulate menu and on the Scans panel. These workflows are grouped
by the four stages of a typical processing pipeline.

## Getting around

<div class="grid cards" markdown>

- :material-file-import: **[Import & export](import-export.md)** — getting data in and out of Phytograph.

- :material-rotate-3d-variant: **[Viewer navigation](viewer-navigation.md)** — moving the camera, switching color modes, isolating an object.

- :material-export: **[Export from RiPROCESS](export-from-riprocess.md)** — get RIEGL scans out with the fields Phytograph needs.

- :material-scanner: **[Import a RIEGL project](import-riegl-project.md)** — read `.riproject` / `.PROJ` scans directly, no RiSCAN PRO round trip.

</div>

## 1. Pre-processing

<div class="grid cards" markdown>

- :material-broom: **[Clean a point cloud](clean-point-cloud.md)** — the whole cleaning pass, in the order to do it.

- :phytograph-transform: **[Transform](clean-point-cloud.md#transform-translate-and-rotate)** — move and rotate a cloud, and set the scene origin.

- :phytograph-crop: **[Crop](clean-point-cloud.md#crop)** — keep or discard a region with a box, rectangle, or freeform polygon.

- :phytograph-erase: **[Erase](clean-point-cloud.md#erase)** — paint away stray points with a brush.

- :phytograph-filter: **[Filter](clean-point-cloud.md#filter)** — keep points by scalar range or by class.

- :phytograph-resample: **[Resample](clean-point-cloud.md#resample)** — thin a dense cloud to a fraction of its points.

- :phytograph-cross-section: **[Cross-section](clean-point-cloud.md)** — clip the view to a slab and traverse it.

- :phytograph-backfill: **[Backfill misses](backfill-misses.md)** — recover the sky/miss rays that LAD needs from a scan that dropped them.

- :phytograph-auto-register: **[Auto-register clouds](register-compare.md#auto-register-when-clouds-start-far-apart)** — align scans that start far apart, validated by loop closure.

- :phytograph-align-icp: **[Align with ICP](register-compare.md#cloud-to-cloud-icp)** — refine cloud-to-cloud, mesh-to-mesh, and cloud-to-mesh alignment.

- :phytograph-stitch: **[Stitch clouds](register-compare.md#stitch)** — merge overlapping scans into one cloud.

- :material-ruler: **[Cloud-to-mesh distance](register-compare.md#cloud-to-mesh-distance)** — measure how far a cloud sits from a reference surface.

</div>

## 2. Segmentation

<div class="grid cards" markdown>

- :phytograph-segment-ground: **[Segment ground points](segment-ground.md)** — classify and remove the ground with the Cloth Simulation Filter.

- :phytograph-segment-wood: **[Separate leaf and wood](segment-wood.md)** — split a scan into woody and foliage points by local geometry.

- :phytograph-segment-trees: **[Segment individual trees](segment-trees.md)** — separate a multi-tree cloud into per-tree instances.

- :phytograph-label-points: **[Label points by hand](label-points.md)** — assign your own classes with a lasso, to correct a classifier or build ground truth.

</div>

## 3. Reconstruction & analysis

<div class="grid cards" markdown>

- :phytograph-triangulate: **[Triangulate a mesh](triangulate.md)** — fit leaf surfaces to measure the leaf-angle distribution and *G(θ)*, or reconstruct a surface with Ball Pivot, Poisson, Alpha Shape, or Delaunay.

- :phytograph-fit-crown: **[Fit a crown & metrics](fit-crown.md)** — wrap the canopy in a fitted shape and read off height, volume, and width.

- :phytograph-dem: **[Generate a DEM](generate-dem.md)** — build a bare-earth DTM, a top-of-canopy DSM, or a canopy height model.

- :phytograph-skeleton: **[Extract a skeleton](extract-skeleton.md)** — pull branch topology out of a woody scan.

- :phytograph-qsm: **[Build a QSM](build-qsm.md)** — reconstruct a dormant tree as connected cylinders with radii, continuous shoots, and shoot rank.

- :material-flower: **[Add leaves to a QSM](add-leaves.md)** — place leaves on terminal shoots using phyllotaxis, then [match them to a measured leaf-angle distribution](adjust-leaf-angles.md).

- :phytograph-lad: **[Estimate leaf area density](estimate-leaf-area-density.md)** — invert overlapping scans against a voxel grid into an LAD grid (m²/m³).

</div>

## 4. Scan simulation

<div class="grid cards" markdown>

- :phytograph-generate-plant: **[Generate a plant](generate-plant.md)** — produce a procedural plant from species, age, and position.

- :material-dna: **[Tune plant parameters](morph-plant.md)** — adjust a generated plant's growth parameters — internode length, insertion angle, girth, curvature, tortuosity — and rebuild it at the same age.

- :phytograph-simulate-scan: **[Simulate a LiDAR scan](simulate-scan.md)** — place a virtual scanner, set its field of view, resolution and beam optics, and synthesize the point cloud it would produce — from a fixed position or along a drone, robot, or tractor trajectory.

</div>
