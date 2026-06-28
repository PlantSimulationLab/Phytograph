# Generate a DEM

A **Digital Elevation Model (DEM)** is a bare-earth terrain surface — a regular
grid of ground elevations. Phytograph builds one from a cloud's **ground
points**, interpolating their elevation onto a grid and reconstructing a
heightmap surface. It's the natural follow-on to
[ground segmentation](segment-ground.md): segment the ground first, and the DEM
is built from the classified ground returns rather than the whole cloud.

## Generate

1. Select a single point cloud.
2. (Recommended) Run [**Segment Ground**](segment-ground.md) first. The DEM tool
   is **ground-class aware**: if the cloud carries a ground classification, only
   the ground points are gridded, giving a true bare-earth model. If it doesn't,
   the panel shows a notice and the DEM **auto-detects ground** with the Cloth
   Simulation Filter (its cloth settings are scaled to the cloud's size, so a
   field- or ALS-scale tile is handled as efficiently as a close-range scan).
   Running Segment Ground first just gives you control over that step (and lets
   you reuse the classification elsewhere).
3. Click **Generate DEM** (the mountain icon in the tool column), or open the
   command palette and choose **Generate DEM**.
4. Adjust the parameters if needed (hover the **?** beside any for a quick
   explanation):
    - **Cell size (m)** — the horizontal resolution of the DEM grid. Smaller
      resolves finer terrain but runs slower and leaves more gaps where the
      ground is sparsely sampled; larger is coarser and smoother. It's seeded
      from the cloud's extent each time the panel opens — a few centimetres for a
      close-range scan, larger for a field-scale tile.
    - **Interpolation** — how elevation is filled between ground points. **TIN
      (linear)** builds a triangulated surface through the ground returns; it's
      the most faithful and the default. **IDW** smooths across neighbours.
      **Nearest** snaps each cell to the closest ground point (blocky but
      gap-free).
    - **Fill data gaps** — off by default, so cells with no nearby ground (e.g.
      outside the data footprint) stay empty and the DEM never invents terrain it
      didn't measure. Turn it on to extrapolate those gaps from the nearest
      measured value.
    - **Compute height above ground** — also subtract the DEM from each point to
      add a `height_above_ground` scalar to the cloud (a canopy-height-model
      precursor). Off by default.
5. Click **Generate DEM**. While it runs, the button shows a spinner (with the
   gridding progress) and a **Cancel** button appears beside it — click Cancel to
   stop a long or stuck run immediately (the computation is killed and nothing is
   added).

For robustness against residual non-ground points (low vegetation that slipped
into the ground class, stray low noise), each grid cell is represented by a
low percentile of the ground heights that fall in it before the surface is
interpolated, so a few high outliers can't tent the terrain.

## Inspect and use the result

The DEM appears as a new **surface mesh** in the scene, named `… DEM` and
coloured by **elevation** by default. Like any mesh you can change its colour
mode, opacity, and transform from the **Meshes** panel, and hide or delete it.

If you ticked **Compute height above ground**, the source cloud gains a
continuous `height_above_ground` attribute and recolours by it (a gradient with
a numeric colorbar). Switch back to it any time from the **Color by** picker.

A DEM also drives **terrain following** for leaf-area density: expand a voxel
grid's row in the Meshes panel and click **Snap to ground** to displace the grid
so it rides this surface — each column then measures the same height above sloping
ground, and the LAD inversion uses the displaced grid you see. See
[Terrain following](estimate-leaf-area-density.md#terrain-following-snap-the-grid-to-the-ground).

### Export

- **GIS raster** — expand the DEM in the **Meshes** panel and use the **Export
  raster** buttons: **GeoTIFF (`.tif`)** or **ESRI ASCII grid (`.asc`)**, written
  from the underlying elevation grid for use in QGIS / ArcGIS. (Note: `.asc` here
  is a *raster* grid, distinct from the `.asc` *point-cloud* import format.) The
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
