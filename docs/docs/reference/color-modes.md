# Color modes

Point-cloud color mode is **global** — it applies to every loaded cloud
at once. Change it from the **Color by** dropdown in the Display panel
(lower-right corner of the viewer).

## Per-cloud color modes

| Mode | What it shows | When to use |
|---|---|---|
| **Per-scan color** | Each cloud drawn flat in its identifier swatch color | Default. Best at-a-glance read of which points came from which scanner. |
| **Height** (Z) | Color by Z-axis position via colormap | Good for any vertical structure — plant scans, terrain. |
| **X** | Color by X position | Inspecting horizontal stripes or registration along X. |
| **Y** | Color by Y position | Same, for Y. |
| **Intensity** | Color by LiDAR intensity scalar | Distinguishing reflective leaves from less reflective wood (species-dependent). |
| **RGB** | Original per-point color from the file | Scans co-registered with photography. |
| **Solid Color** | A single flat color applied to every cloud | When you want the data out of the way to focus on a mesh or skeleton overlay. |
| **Scalar Field** | Color by any custom per-point scalar carried in the source file | Imported clouds with extra columns — reflectance, deviation, timestamp, target index, custom metrics. |

When a scalar mode is active, a colormap selector becomes available in
the right panel: viridis (default), plasma, magma, inferno, turbo,
grayscale.

### Scalar fields on imported clouds

Any extra numeric columns in an imported XYZ/TXT/CSV file — beyond the
X/Y/Z, RGB, and intensity that Phytograph maps to dedicated channels —
are carried through as **scalar fields** and listed under a *Scalar
fields* group in the **Color by** dropdown. This works for both small
clouds and large octree-streamed clouds (the columns travel into the
octree as extra attributes), so a terrestrial-scanner export with
`Reflectance[dB]`, `Deviation[]`, `Target Index[]`, etc. exposes each as
a selectable, color-mappable field.

Field names come from the file's header row when present (so
`Reflectance[dB]` shows as **Reflectance [dB]**); files without a header
fall back to positional names. The selected field's value range drives
the colorbar, and the **Min/Max** inputs let you window it.

!!! note
    Clouds imported before this feature shipped (v0.3.4) won't show their
    extra columns until re-imported — cached octrees built earlier don't
    carry the extra attributes.

#### Categorical (classification) attributes

Some scalar attributes are **categorical** — integer class labels rather
than a continuous measurement. The **Ground Class** attribute produced by
[Segment ground points](../workflows/segment-ground.md)
(1 = ground, 2 = non-ground) is the first of these. These render with
**discrete per-class colours** and a small class legend (ground in brown,
non-ground in green) instead of a continuous colormap and colorbar, so each
class reads as a distinct category rather than a position along a ramp.

The **`tree_instance`** attribute produced by
[Segment individual trees](../workflows/segment-trees.md) (`0` = unassigned,
`1..N` = individual trees) is also categorical, but its class count isn't fixed:
each tree's colour is generated on the fly (a perceptually-spaced hue rotation)
and the legend lists Tree 1, Tree 2, …, with unassigned points in grey.

## Per-mesh color modes

| Mode | What it shows | When to use |
|---|---|---|
| **Single Color** | Flat color | Default. |
| **Height** | Color by vertex Z | Inspecting elevation in terrain meshes or plant verticality. |
| **Distance** | Color by per-vertex distance (set automatically after C2M / M2M) | Reading registration heatmaps. |
| **Vertex Color** | Per-vertex colors from the file | If the mesh has them. |
| **Branch Order** | Color by branch order (Helios-generated plants) | Comparing trunk vs. side branches in procedural plants. |
| **Inclination** | Per-triangle zenith of the face normal, folded to 0–90° | Reading surface tilt — flat vs. steep facets on a reconstruction. |
| **Azimuth** | Per-triangle compass bearing of the face normal, 0–360° | Seeing which way facets face. |
| **Triangle Area** | Per-triangle surface area | Spotting over-large bridging triangles or uneven tessellation. |
| **Source Scan** | Each triangle in the color of the scan it came from (Helios multi-scan meshes) | Seeing scan coverage / overlap on a Helios reconstruction. |

Inclination / Azimuth / Triangle Area are set from the **Color by**
control that expands from a triangulation-generated mesh's row in the
**Meshes** panel (click the row's chevron). They share the scalar
colormap selector and bottom-right colorbar. **Source Scan** is offered
there too for Helios meshes built from more than one scan; it uses each
scan's swatch color and shows a per-scan legend instead of a colorbar.

## Per-skeleton color modes

| Mode | What it shows | When to use |
|---|---|---|
| **Branch Order** | Strahler number — trunk in deep green, twigs in mustard | Default for woody plants. Best topological readout. |
| **Length** | Color edges by their length | Spotting unusually short or long segments. |
| **Single Color** | Flat color | When you want the skeleton out of the way visually. |

## Reading scalar colormaps

The default colormap (viridis) goes:

- **Deep purple / forest** — lowest value
- **Teal / blue-green** — mid-low
- **Lime / yellow-green** — mid-high
- **Bright yellow** — highest

Other colormaps preserve order but use different palettes. Viridis is
the project default because it's perceptually uniform and prints well
in greyscale — useful for figures.
