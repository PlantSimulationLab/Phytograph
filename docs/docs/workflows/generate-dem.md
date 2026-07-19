# Generate a DEM / DSM / CHM

A **Digital Elevation Model (DEM)** is a bare-earth terrain surface — a regular
grid of ground elevations. Phytograph builds one from a cloud's **ground
points**, interpolating their elevation onto a grid and reconstructing a
heightmap surface. It's the natural follow-on to
[ground segmentation](segment-ground.md): segment the ground first, and the DEM
is built from the classified ground returns rather than the whole cloud.

The same tool also builds two related **surface products**. Tick any combination
in the **Surfaces** list at the top of the panel — **one run generates every
checked product**, each as its own mesh (so you can produce a DTM, DSM and CHM in
a single click):

- **Terrain (DTM)** — the bare-earth ground surface (the classic DEM; the
  default).
- **Surface (DSM)** — the *first-return / top-of-canopy* surface: the highest
  return in each cell. It does **not** need ground classification.
- **Canopy height (CHM)** — the **canopy height model**, `DSM − DTM`: vegetation
  height above the bare earth. Phytograph grids the ground (DTM) and the
  first-return surface (DSM) on one aligned grid and subtracts them, so every
  cell reads the height of the canopy above the ground beneath it (never
  negative). See [Terrain surfaces: DTM, DSM, CHM](../concepts/meshes.md#terrain-surfaces-dtm-dsm-chm)
  for the concepts.

### Terrain layers (density, intensity, hillshade, slope, aspect)

A generated **Terrain (DTM)** doesn't just carry elevation — it comes with a set of
**scalar layers** you colour the same surface by and export individually. No
checkboxes and no extra runs: the layers are computed automatically with the DTM.
Expand the DTM in the **Meshes** panel and pick a band from **Color by**:

- **Elevation** — the ground height (the default).
- **Point density** — number of points per cell (a coverage/density map).
- **Return density** — number of laser pulses (first returns) per cell.
- **Intensity** — mean return intensity per cell (present when the cloud carries an
  intensity field).
- **Hillshade / Slope / Aspect** — shaded relief (fixed sun, 315°/45°), steepness,
  and facing direction, derived from the elevation grid (GIS-standard).

The colorbar re-captions to the selected band, and **Export raster** (below) lets
you write any subset of these layers to `.asc` / GeoTIFF.

## Generate

1. Select a single point cloud.
2. Tick the **Surfaces** you want (Terrain / Surface / Canopy height) — any
   combination, generated together in one run. DTM and CHM use the ground
   classification; DSM does not.
3. (Recommended, for DTM/CHM) Run [**Segment Ground**](segment-ground.md) first.
   The DEM tool is **ground-class aware**: if the cloud carries a ground
   classification, only the ground points are gridded, giving a true bare-earth
   model. If it doesn't, the panel shows a notice and the ground is
   **auto-detected** with the Cloth Simulation Filter (its cloth settings are
   scaled to the cloud's size, so a field- or ALS-scale tile is handled as
   efficiently as a close-range scan). Running Segment Ground first just gives you
   control over that step (and lets you reuse the classification elsewhere).
4. Click **Generate DEM** (the mountain icon in the tool column), or open the
   command palette and choose **Generate DEM** (searching "DSM" or "CHM" also
   finds it).
5. Adjust the parameters if needed (hover the **?** beside any for a quick
   explanation):
    - **Cell size (m)** — the horizontal resolution of the grid. Smaller
      resolves finer terrain but runs slower and leaves more gaps where the
      ground is sparsely sampled; larger is coarser and smoother. It's seeded
      from the cloud's extent each time the panel opens — a few centimetres for a
      close-range scan, larger for a field-scale tile.
    - **Interpolation** — how elevation is filled between ground points. **TIN
      (linear)** builds a triangulated surface through the ground returns; it's
      the most faithful and the default. **IDW** smooths across neighbours.
      **Nearest** snaps each cell to the closest ground point (blocky but
      gap-free).
    - **Fill data gaps** — off by default, so cells with no ground return stay
      empty (an honest DTM of only what was measured). Turn it on to fill any cell
      that has returns but no ground — e.g. under **dense canopy**, where few pulses
      reach the ground and the bare-earth model would otherwise be full of holes —
      with the nearest measured ground elevation, so the DTM covers the whole
      **scanned footprint**. Either way the surface is clipped to that footprint: it
      never extrapolates past the scanned area (no fabricated corners beyond a
      rotated survey tile).
    - **Compute height above ground** (Terrain/DTM only) — also subtract the DEM
      from each point to add a `height_above_ground` scalar to the cloud (a
      per-point canopy-height precursor). Off by default. For a *rasterised*
      canopy height model, use the **Canopy height (CHM)** surface instead.
6. Click **Generate DEM** (or **Generate DSM / CHM**). While it runs, the button
   shows a spinner (with the gridding progress) and a **Cancel** button appears
   beside it — click Cancel to stop a long or stuck run immediately (the
   computation is killed and nothing is added).

For a **DTM**, robustness against residual non-ground points (low vegetation that
slipped into the ground class, stray low noise) comes from representing each grid
cell by a *low* percentile of the heights that fall in it before interpolation,
so a few high outliers can't tent the terrain. A **DSM** does the opposite — a
*high* per-cell percentile — so each cell tracks the top of the canopy rather
than a low outlier. A **CHM** subtracts the two on an aligned grid and applies a
first-pass pit-fill so isolated within-canopy dips don't read as holes.

## Inspect and use the result

The surface appears as a new **surface mesh** in the scene, named `… DEM`,
`… DSM`, or `… CHM`, coloured by **elevation** (for a CHM, that gradient reads as
canopy height). Like any mesh you can change its colour mode, opacity, and
transform from the **Meshes** panel, and hide or delete it. A **DTM** additionally
lets you switch its **Color by** dropdown between the terrain
[layers](#terrain-layers-density-intensity-hillshade-slope-aspect) — the same
mesh recolours by density, intensity, hillshade, and so on.

If you built a DTM with **Compute height above ground** ticked, the source cloud
gains a continuous `height_above_ground` attribute and recolours by it (a
gradient with a numeric colorbar). Switch back to it any time from the **Color
by** picker.

A DEM also drives **terrain following** for leaf-area density: expand a voxel
grid's row in the Meshes panel and click **Snap to ground** to displace the grid
so it rides this surface — each column then measures the same height above sloping
ground, and the LAD inversion uses the displaced grid you see. See
[Terrain following](estimate-leaf-area-density.md#terrain-following-snap-the-grid-to-the-ground).

### Export

- **GIS raster** — expand the surface (DEM/DSM/CHM) in the **Meshes** panel and use
  **Export raster**: **GeoTIFF (`.tif`)** or **ESRI ASCII grid (`.asc`)**, for use
  in QGIS / ArcGIS. (Note: `.asc` here is a *raster* grid, distinct from the `.asc`
  *point-cloud* import format.) For a **DTM**, tick which
  [layers](#terrain-layers-density-intensity-hillshade-slope-aspect) to write
  (elevation / density / intensity / hillshade / slope / aspect) — the band you're
  currently viewing is pre-checked; picking several writes one file per band into a
  chosen folder (`<cloud>_<layer>.tif`). DSM/CHM export their single grid. The
  GeoTIFF is georeferenced when the source cloud's CRS is known (e.g. a UTM LAS).
- **Mesh** — to export the surface geometry itself, select the DEM and open
  **Export** (File → Export) for OBJ / PLY / STL, like any mesh.

!!! note "Georeferencing"
    The raster is written in the cloud's own coordinates. For a cloud imported in
    a projected CRS (e.g. UTM easting/northing), the GeoTIFF carries the correct
    pixel size and origin so it lines up in GIS; assign the CRS on load if it
    isn't embedded.

!!! note "Large clouds"
    Clouds imported from disk stream as an octree. DEM generation reads the
    in-memory session at full resolution and the per-cell pre-binning bounds the
    work to the grid size, so it stays fast even on multi-million-point tiles.
