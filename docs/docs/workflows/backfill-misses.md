# Backfill misses

Recover the **sky/miss points** a scan needs for leaf area density —
laser pulses that were fired but returned nothing because they passed
through the canopy into open sky. See [Scans](../concepts/scans.md) for
what misses are and why they matter.

LAD inverts Beer's law on the beams crossing each voxel, and the misses
are the transmission denominator: without them there's no way to tell a
voxel that stopped every beam from one that let them all through. Some
formats record misses directly (E57, structured PLY); others drop them
but keep enough to **reconstruct** them. Backfill Misses does that
reconstruction once, up front, and stores the result on the scan so you
can see it and reuse it.

## When you need it

- A scan has **no sky/miss points** (the "Show misses" toggle is absent
  in the Scans panel), **and**
- it carries a per-return **`timestamp`** column and/or scan-grid
  **`row`/`column`** indices to rebuild the miss directions from.

If a scan already retains misses, there's nothing to do. If it has
neither a timestamp nor a row/column grid, misses **can't** be recovered —
re-import the scan in a format that keeps them (E57 / structured PLY).

## Steps

1. **Select the scan(s)** in the Scans panel.
2. Click **Backfill Misses** in the **Pre-processing** group of the
   toolbar (cloud icon). A setup dialog opens listing the eligible scans,
   pre-selected from your current selection — like the Triangulation and
   Leaf Area Density dialogs. Scans that already have misses or can't
   recover them are noted but excluded.
3. Leave **Show misses in the viewer after completion** on to reveal the
   recovered points when it finishes (it's disabled automatically when the
   selected scans have no scanner origin, since misses can't be drawn
   without one — see the note below).
4. Click **Backfill Misses**. A progress bar shows the per-scan stages
   (reading the scan, building the cloud, reconstructing misses, storing);
   it can be cancelled. A summary toast reports how many points were
   recovered.
5. When **Show misses** was on, the **"Show misses"** toggle on each
   backfilled scan row turns on automatically and the recovered sky points
   are drawn (in a distinct colour, projected onto the scan's bounding
   sphere and streamed as a level-of-detail octree, so a dense sky shell
   stays smooth). Toggle it off once you've confirmed them.

You can also trigger backfill from the **Leaf Area Density** dialog: when a
selected scan has no misses, Compute is disabled and a banner offers a
one-click **Backfill Misses** button. See
[Estimate leaf area density](estimate-leaf-area-density.md).

## Notes

- Backfilling **mutates the scan's session in place** — it is not an
  undoable edit. Re-running it simply recomputes the misses.
- The recovered misses are kept in a lightweight side buffer, separate
  from the scan's points, so a sparse scan that is mostly sky doesn't
  bloat memory. They aren't exported with the point cloud; they exist to
  drive (and let you verify) the LAD inversion.
- **Cropping a scan after backfilling marks the recovered misses stale.**
  They were reconstructed against the pre-crop hits, so their hit/miss ratio
  no longer matches the surviving points. Phytograph keeps them but warns you
  — at crop time and again in the LAD result — to **re-run Backfill Misses**
  on the cropped cloud before estimating leaf-area density. (A crop never
  deletes sky/miss points themselves; it only removes hits.)
- For [moving-platform scans](../concepts/scans.md#moving-platform-scans),
  misses are reconstructed from the per-return timestamps (the row/column
  path doesn't apply to a moving sweep).
