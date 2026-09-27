# Run a tree inventory

Turn a segmented forest plot into a **tree list**: one row per tree with
its stem position, **DBH**, stem curve, lean, height, crown base height,
crown size, crown volume and how crowded it is by its neighbours. Then
summarise the plot (**stems/ha, basal area, QMD, Lorey's height, canopy
cover, biomass**), and build a QSM for every tree in one run. Each DBH comes with the evidence behind it:
how well the circle fit and how much of the stem was actually seen. Browse
and sort the trees in the **Tree Table**, click a tree to fly to it, record
species and status, and export the list and the stem curves as CSV.

How every value is measured, and the published method it follows, is on
[Tree inventory measurements](../concepts/tree-inventory.md) and
[Stand metrics](../concepts/stand-metrics.md).

## Before you start

The inventory reads the labels the segmentation tools write, so run them
first, on the same cloud:

| Step | Writes | Why the inventory needs it |
|------|--------|----------------------------|
| [Segment ground points](segment-ground.md) | `ground_class` | Keeps ground out of the trees; the fallback ground source. |
| [Generate a DEM](generate-dem.md) with **Height above ground** ticked | `height_above_ground` | The terrain under each tree. Every height, and breast height itself, is measured from it. |
| [Segment individual trees](segment-trees.md) | `tree_instance` | One row per tree id. |

!!! warning "Without a DEM, heights are less reliable"
    Without the height-above-ground column, the ground is estimated from the
    ground-labelled points. Without those either, each tree's own lowest
    point is used, which is biased on slopes. Those trees are flagged
    `ground_from_tree_min`, and the panel says which ground source it will
    use before you run.

Sky/miss points and deleted points are never measured.

## Run it

1. Select the cloud, then open **Tools → Tree Inventory** (or press
   <kbd>Cmd/Ctrl</kbd>+<kbd>K</kbd> and search "inventory").
2. Check the settings:

    | Setting | Default | Meaning |
    |---------|---------|---------|
    | **Breast height** | 1.3 m | Where DBH is taken, above the uphill ground and along the stem. Or 4.5 ft (1.37 m), the US convention. |
    | **Circle search** | RANSAC | The robust search that finds the stem's points in a slice: RANSAC, or the randomized Hough transform. Both are refined by the same precise fit. |
    | **Crown voxel** | 0.10 m | Only affects crown volume: the number of cubes of this size that hold a point. Smaller cubes report less volume, larger ones approach the crown envelope. Use roughly 2–3× the crown's point spacing, and one value across trees you compare. |
    | **Min points / tree** | 50 | Trees with fewer points are skipped (and counted in a warning). |
    | **Competition** | 6 m | Search radius of each tree's competition index (the **CI** column). Every neighbour with a DBH within the radius adds its DBH ÷ this tree's DBH ÷ their distance, so bigger, closer neighbours count more. Trees closer than this to the plot edge are marked in the CSV's `edge` column, since their outside neighbours are missing. |

3. Click **Run inventory**. The bar shows which tree is being measured.
   **Cancel** stops it between trees.

The trees are measured one at a time, straight from the cloud's store, so a
large plot doesn't need to fit in memory at once.

## The Tree Table

Each row is one tree:

| Column | Meaning |
|--------|---------|
| **Tree** | The `tree_instance` id. A ⚠ marks a tree with a quality flag. Hover the row to read it. |
| **DBH cm** | Diameter at breast height. |
| **H m** | Height above the ground at the stem base. |
| **CBH m** | Crown base height. |
| **Crown ⌀ m** | Mean crown diameter. |
| **CPA m²** | Crown projected area. |
| **Lean °** | Stem lean from vertical. |
| **BA m²** | Basal area. |
| **H/D** | Slenderness. |
| **CI** | Hegyi's competition index: higher means larger, nearer neighbours. |
| **Overlap %** | Share of the crown projection covered by other crowns. |
| **QSM m³** | Woody volume of the tree's QSM (after **Build QSMs**). |
| **AGB kg** | Above-ground biomass by the Stand tab's method (when one is chosen). |
| **Species**, **Status**, **Label** | Your own entries. |

- **Sort** by clicking a column header. Click it again to reverse. Trees
  with no value in that column always sort last.
- **Click a row** to select the tree and frame it in the viewer. Its
  overlay turns pink.
- **Species**, **Status** (live, dead, damaged, uncertain) and **Label**
  are yours to fill in. They are exported with the tree list. When you
  re-run the inventory on the same cloud, an entry is kept only for the
  **same tree**: the same id, with its stem base within 0.5 m of where it
  was. Re-running Segment Trees renumbers trees, so an entry whose id now
  names a different stem is dropped rather than moved onto the wrong tree,
  and a warning says how many were dropped. Running the inventory on
  another cloud does not lose them: each cloud keeps its own entries and
  entered plot area for this session, and they come back when you re-run
  that cloud.
- The table always belongs to the **last run**. If you have since selected
  another cloud, the panel says whose inventory it is showing. If you have
  since changed that cloud (re-segmented it, edited it, or moved it), the
  panel says the result is out of date.

!!! note "Your entries live in this session"
    Species, status and labels are not saved with the cloud. Export the
    tree list to keep them.

### Quality flags

| Flag | Meaning | What to do |
|------|---------|------------|
| `partial_arc` | Less than half the stem's circumference was seen at breast height. | Usual for a single scan position. The DBH is less certain; scanning from more positions fixes it. |
| `few_points` | Fewer than 20 points on the DBH circle. | Check the stem in the viewer; the scan may be sparse there. |
| `high_residual` | The circle fit is noisy: branches, ivy, or buttresses at breast height. | Inspect the DBH circle overlay. |
| `no_stem` | No circle could be fitted at breast height (often an occluded stem). DBH, basal area and slenderness are blank. | Check the segmentation; the tree may be merged with a neighbour or cut off. |
| `ground_from_tree_min` | No ground data under this tree. | Run Segment Ground and Generate DEM. |

## Stand summary

The **Stand** tab summarises the plot from the tree list:

| Figure | Meaning |
|--------|---------|
| **Plot area** | The convex hull of the ground points (*measured*), or the area you enter. |
| **Trees** | Trees counted: DBH at or above **Min DBH** (default 5 cm), and not marked dead unless you untick **Exclude dead trees**. |
| **Stems / ha**, **Basal area** | Per hectare of plot area. |
| **QMD** | Quadratic mean diameter. |
| **Lorey's height** | Mean height weighted by basal area. |
| **Mean / max height** | Of the counted trees. |
| **Canopy cover** | Share of the plot under at least one crown. |

Below them are the **DBH** and **height class** histograms; set each class
width in the box beside it.

!!! tip "Enter the plot area for small plots"
    The measured boundary is the scanned ground's outline, which is rarely a
    surveyed plot's. For small plots, where the edge matters most, enter the
    surveyed area.

**Biomass** (optional): pick a method and it is estimated per tree
(the **AGB kg** column) and totalled for the stand, in Mg and Mg/ha.

| Method | Needs | For |
|--------|-------|-----|
| **Chave 2014** | DBH, height, wood density | Tropical trees. |
| **Jenkins 2003** | DBH, a species group | United States species groups. |
| **QSM volume × density** | a QSM per tree (**QSM** tab), wood density | Any tree whose woody structure is well scanned. |

One species group and one wood density apply to the whole stand. Trees a
method can't estimate are left out of the total, and the summary says how
many. [Stand metrics](../concepts/stand-metrics.md#biomass-optional) gives
each method's range and source.

**Stand summary CSV** writes the figures, the settings that produced them,
and the class tables.

## QSM per tree

The **QSM** tab builds a [QSM](build-qsm.md) for **every tree** in the
table in one run:

1. Set **Max points per tree** (default 60,000, at most 500,000). Larger trees are thinned
   evenly on a voxel grid.
2. Leave **Wood points only** ticked if the cloud has
   [leaf/wood labels](segment-wood.md): a QSM models the woody structure.
3. Click **Build QSMs**. Each tree's model is added to the scene, named
   after the tree. **Cancel** stops between stages.

Each tree's woody volume joins the table (**QSM m³**) and can feed the QSM
biomass method. A tree that can't be modelled (too few points, or a
skeleton that doesn't connect) is counted as failed without stopping the
others. **QSM metrics CSV** lists every tree, with the reason for each
failure.

## Overlays

With **DBH & stem overlays** ticked, the viewer draws, for every tree:

- the **DBH circle** at breast height, perpendicular to the stem;
- a **cross** at the stem base on the ground;
- a line from the stem base up the stem axis to breast height.

The overlays stay on screen after you close the panel. Untick the box to
hide them. They also hide while their cloud is hidden, and once the cloud
has changed since the run (re-segmented, a DEM or edit that rebuilt it, or
a transform in progress), because they would no longer sit on its stems.
Re-run the inventory to bring them back.

## Export

- **Tree list CSV** — one row per tree, with every measurement, its
  quality evidence and your entries.
- **Stem curve CSV** — one row per 0.5 m stem slice: position, diameter and
  fit quality.
- **Stand summary CSV** — on the Stand tab.
- **QSM metrics CSV** — on the QSM tab, one row per tree.

The columns are described in
[File formats](../reference/file-formats.md#tree-list-csv).
