# Segment individual trees

Separate a point cloud containing **many trees** into individual trees, giving
every point a per-tree **instance ID**. Phytograph uses **TreeIso** — a
classical cut-pursuit graph method that runs on the CPU (no GPU required).

---

## When to use this

- Your scan covers a forest plot, orchard row, or any scene with more than one
  tree, and you want to isolate each tree.
- You need per-tree point sets for downstream analysis (height, crown, skeleton)
  or to export each tree separately.

## Before you start

TreeIso isolates **above-ground tree structure**, so deal with the ground first
with [Segment ground points](segment-ground.md). You have two options:

- **Remove** the ground points, or
- **Label** them (run ground segmentation and keep the labelled cloud without
  deleting the ground). When the cloud carries a `ground_class` label,
  Segment Trees automatically excludes the ground points — TreeIso only sees the
  plant points, and the ground keeps tree ID `0` ("Unassigned").

If ground appears to still be present *and unlabelled* when you run the tool,
Phytograph warns you (but still runs).

## Steps

1. **Import** your scan (see [Import & export](import-export.md)) and, if needed,
   run [Segment ground points](segment-ground.md) — either keep the non-ground
   cloud or keep the labelled cloud (the ground is excluded automatically).
2. **Select** the cloud in the scan list.
3. Open the **Segment Trees** tool from the toolbar (the trees/forest icon in
   the **Tools** › Segmentation group) or the command palette
   (`Cmd/Ctrl-K` → "Segment Trees").
4. Adjust parameters if needed. The size-dependent settings (the internal
   decimation and the max-gap below) are seeded from the cloud's extent each time
   the panel opens — fine for a close-range scan, coarser for a field- or
   airborne-scale tile — so a large-area scan is handled as efficiently as a
   close-range one instead of stalling:
    - **3D reg. strength (λ₁)** — regularization for the initial 3D
      segmentation. Default `1.0`.
    - **2D reg. strength (λ₂)** — regularization for the intermediate 2D
      grouping; the most influential knob. Default `15`.
    - **Max intra-tree gap (m)** — the largest gap (from occlusion) still
      treated as belonging to one tree. Default `2.0` (seeded larger for very
      large tiles). Lower it when trees stand close together so neighbours aren't
      merged.
    - **Split into one cloud per tree** — when checked, also adds a separate
      cloud for each tree to the scan list.
5. Click **Segment Trees**. While it runs, the button shows a spinner and a
   **Cancel** button appears beside it — click Cancel to stop a long or stuck run
   immediately (the computation is killed and the cloud is left unchanged).

## Results

The cloud is recoloured by the `tree_instance` attribute: each tree gets a
distinct colour. Points TreeIso could not assign keep ID `0` ("Unassigned",
shown grey). (No legend is shown for tree instances — with one entry per tree it
would fill the viewport and the IDs are arbitrary anyway.) If you enabled
**Split**, one new cloud per tree (`… (tree N)`) is added to the list.

## Seeding trunks (optional)

For tricky scenes you can guide the result by marking trunks yourself:

1. In the panel, turn on **Seed trunks**.
2. Left-click each trunk in the viewer — a numbered marker drops at that spot.
   Right-click removes the last seed; **Clear seeds** removes all. (The camera is
   locked while seeding; turn the mode off to orbit.)
3. Click **Segment Trees**. Each seed yields exactly one tree, and ambiguous
   segments are assigned to their nearest seed.

## Refining the result

Once a cloud is segmented (flat clouds), a **Refine** section appears:

- **Merge** — combine two tree IDs into one (e.g. when one tree was split in
  two): enter the two IDs and click **Merge**.
- **Split** — separate a tree that actually contains two by spatial gaps: enter
  the tree ID and click **Split**; disconnected blobs become new trees.

## Tips

- Results are best on ground-removed, reasonably dense clouds.
- If neighbouring trees merge into one, lower **Max intra-tree gap** or add
  trunk **seeds**.
- If one tree is split into several, raise **2D reg. strength** or **Merge** the
  pieces afterward.
- Segmentation runs in the background, so the rest of the app stays responsive
  while it works; closing the panel cancels the run.

## See also

- [Segment ground points](segment-ground.md)
- [Concepts: Point clouds](../concepts/point-clouds.md)
- [Reference: Color modes](../reference/color-modes.md)
