---
hide:
  - navigation
  - toc
---

![Phytograph — from photograph to point cloud](assets/cover_image.png){ .no-frame .pg-cover }

# Phytograph

<p style="font-size: 1.15rem; max-width: 42rem;">
A desktop application for measuring, comparing, and modeling plant
architecture from LiDAR scans — built for plant scientists who work with
point clouds, meshes, and procedural plant models.
</p>

<div class="grid cards" markdown>

- :material-cube-scan: **Import LiDAR scans**

    Drag and drop `.las`, `.laz`, `.xyz`, `.ply`, or `.csv` point clouds into
    a 3D viewer that handles tens of millions of points.

- :material-vector-triangle: **Reconstruct meshes**

    Triangulate point clouds with Delaunay, Ball Pivot, or Poisson — or run
    multi-scan Helios triangulation for branch surfaces from terrestrial
    LiDAR.

- :material-tree: **Extract skeletons**

    Pull topological skeletons out of woody scans, with branch order
    colored by Strahler number and total length reported.

- :phytograph-qsm: **Build QSMs**

    Reconstruct dormant trees as connected cylinders with fitted radii,
    segment continuous shoots, and classify them by shoot rank — with
    woody volume, trunk diameter, and per-rank metrics.

- :material-sprout: **Generate procedural plants**

    Grow Helios plant models — trees, vines, cereals, vegetables — to a
    target age, then morph their parameters interactively.

- :material-compare: **Register and compare**

    Cloud-to-cloud, mesh-to-mesh, and cloud-to-mesh ICP with RMSE and
    distance heatmaps.

- :material-radar: **Simulate a scan**

    Place virtual scanners around a plant and synthesize the point cloud
    they would produce, with full control over beam geometry.

</div>

<p style="margin-top: 2rem;">
<a href="guide/" class="md-button md-button--primary">Start the User Guide →</a>
&nbsp;
<a href="workflows/" class="md-button">Browse workflows</a>
</p>

---

<p style="opacity: 0.7; font-size: 0.85rem;">
Phytograph is developed at the
<a href="https://baileylab.ucdavis.edu/">Bailey Lab</a> at UC Davis as the
desktop interface to the <a href="https://baileylab.ucdavis.edu/software/helios/">Helios</a>
plant-modeling framework. Source code at
<a href="https://github.com/PlantSimulationLab/phytograph">github.com/PlantSimulationLab/phytograph</a>.
</p>
