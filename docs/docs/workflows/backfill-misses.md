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
  **`row`/`column`** indices to rebuild the miss directions from, **and**
- it has a **known scanner position**.

If a scan already retains misses, there's nothing to do. If it has
neither a timestamp nor a row/column grid, misses **can't** be recovered —
re-import the scan in a format that keeps them (E57 / structured PLY).

!!! warning "The scanner position is required, not optional"

    Miss directions are measured **from the scanner**: each recovered ray is
    reconstructed as the direction from the scan origin to its return, and the
    misses are then projected outward from that same apex. Without the true
    position there is nothing to reconstruct against — the result isn't
    approximate, it's wrong, and it still *looks* like a complete miss cloud.

    So a scan with the right columns but no recorded position is listed as
    ineligible until you set one. Set the scan position (or import scan
    parameters / a Helios XML `<scan>`) first, then run Backfill Misses.

    A **moving-platform** scan is the exception: its per-beam emission origins
    come from the trajectory, so it doesn't depend on a single static apex.

!!! note "A `Timestamp` entry in Color-by doesn't always mean the data is there"

    `gps_time` is a standard LAS dimension, so it exists on every imported
    cloud whether or not the source ever recorded per-pulse time — on a plain
    `x y z r g b intensity` file it is present but entirely zero. Backfill
    Misses judges a scan by whether the column actually **varies**, not by
    whether it exists, so such a scan is correctly listed as ineligible even
    though the Color-by picker offers a "Timestamp" entry that renders as a
    flat, single-valued field.

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
- **No editing tool ever discards sky/miss points.** Crop, erase, filter,
  segment and split all act on hits alone: a miss sits about a kilometre out
  along its beam, so it falls outside any region you draw around the canopy,
  and deleting it on that basis would quietly destroy the transmission
  denominator LAD depends on. Splitting a cloud keeps the misses with the
  retained side, and extracting a sub-cloud copies them onto the new cloud, so
  either result can still be used for LAD.
- **A very fine scan grid can exceed the gap-fill memory budget.** The
  row/column reconstruction creates one sky point for every *empty* cell of the
  scan's angular grid, so the cost is set by the grid resolution — not by how
  many returns came back. A scan declared at a resolution far finer than its
  returns actually populate can ask for tens of GB, so Phytograph refuses up
  front with a message naming the grid size and the estimated memory rather than
  running the machine out of RAM part-way through. Lower the scan's
  **Ntheta/Nphi** to match the data and re-run.
- For [moving-platform scans](../concepts/scans.md#moving-platform-scans),
  each return's timestamp is joined to the platform **trajectory** to
  reconstruct a per-beam emission origin, so the recovered misses follow the
  flight path rather than fanning from a single static apex. (The row/column
  grid path doesn't apply to a moving sweep; a per-return timestamp is
  required.)
