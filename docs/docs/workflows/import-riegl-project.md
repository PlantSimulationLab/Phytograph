# Import a RIEGL project (.riproject / .PROJ)

This walkthrough covers importing **raw RIEGL scanner data** — a project
directory straight off a V-Line instrument — without going through RiSCAN PRO
first.

Two on-instrument layouts are supported, and Phytograph tells them apart by
what is inside the folder rather than by its name:

| Layout | Written by | What it carries |
| --- | --- | --- |
| `.riproject` | Older instruments (e.g. VZ-1000) | Scan positions only; **no registration** |
| `.PROJ` | Newer instruments (e.g. VZ-2000i) | Scan positions **plus the instrument's own registration** |

The import path is otherwise identical: same menu item, same picker, same
decoding. The one behavioural difference is that a `.PROJ`'s scans can land
already aligned — see [Which frame the points land in](#which-frame-the-points-land-in).

If your data has already been through RiSCAN PRO or RiPROCESS, you don't need
this: export to LAS/LAZ or E57 and use the ordinary
[import path](import-export.md). This feature exists for the case where the
processing software isn't in the loop at all.

!!! warning "macOS only, and it needs Docker"
    RIEGL's **RiVLib** — the only library that can read `.rxp` — ships for
    Windows and Linux, not macOS. Phytograph therefore runs it inside a Linux
    container, which means **Docker Desktop must be installed and running**.

    On Windows and Linux this import is not offered in this release; export to
    LAS/E57 from RiSCAN PRO or RiPROCESS instead.

## Before you start: install RiVLib

RiVLib is proprietary. Its licence forbids redistribution, so Phytograph
**cannot ship it** — you download it yourself with your own RIEGL account, and
Phytograph reads it from wherever you put it. Nothing is copied into the app.

1. Sign in to RIEGL's members area and download **RiVLib Part 1** for
   **`x86_64-linux-gcc9`**.

    !!! note "Why the Linux build on a Mac?"
        The library runs inside a Linux container, so it is the Linux build
        that matters — not your Mac's architecture. The container is
        `linux/amd64` regardless of whether you have Apple silicon.

2. Extract it. You want the folder that contains `bin/`, `include/` and `lib/`
   — **not** `lib/` itself.

3. In Phytograph, open **Settings** (++cmd+comma++) and find
   **RIEGL RiVLib folder**. Click **Choose…** and select that folder.

4. The badge beside it should turn to **RIEGL ready**. If it doesn't, the
   checklist below the setting names the missing piece:

    | Checklist line | What to do |
    | --- | --- |
    | ✗ Docker running | Start Docker Desktop and reopen Settings |
    | ✗ RiVLib folder | Choose the extracted folder (the one with `bin/`, `include/`, `lib/`) |
    | ✗ Reader image up to date | Click **Build reader image** — a one-time step; the image is ~300 MB on disk once built |

    The image is always built locally from your own RiVLib copy; it is never
    downloaded pre-made, because publishing it would mean redistributing RiVLib.

    After a Phytograph update the badge may read **RIEGL update pending**. That
    is not something you need to act on: the reader inside the image travels
    with the app, so an update can leave the image a version behind, and your
    next import rebuilds it first — a second or two, since only the reader layer
    changes and Docker already has the rest cached. It works offline. If you
    would rather not wait mid-import, **Rebuild reader image** in Settings does
    it now.

## Import a project

Either:

- **File → Import → RIEGL Project (.riproject / .PROJ)…** and pick the project
  folder, or
- **drag the project folder** onto the viewer.

Phytograph reads the project's metadata and opens a picker listing every scan
position:

- **Point count** — approximate. A `.riproject` shows a lower bound (`≥`) from
  probing the start of each file; a `.PROJ` shows an estimate (`~`) from the
  file size, because it needs to decode nothing at all. The exact count appears
  after import.
- **Sweep** — the commanded field of view, e.g. `30–130° × 0–360°`.
- **Instrument** — e.g. `VZ-1000`, `VZ-2000i`.
- **Placement** — for a `.PROJ` being imported registered, how that position is
  placed: **registered**, **prior only**, or **no pose** (see below). For a
  `.riproject`, **GNSS ✓ / no GNSS** instead, since that is what decides where
  its points land.

A small plan view shows the layout — from the surveyed poses where the project
has them, and from the GNSS fixes otherwise — so an implausible layout is
visible before you commit to the import.

!!! note "A `.PROJ` opens much faster"
    A `.riproject` hides its GNSS inside the point stream, so previewing one
    means decoding the start of every position — under a second each, though
    the first read of a project that isn't in the operating system's file cache
    is slower. A `.PROJ` states everything in small JSON sidecars, so a
    24-position project lists in about a second.

Every readable position is selected already, so untick the ones you don't want
and click **Import**. The header checkbox toggles them all at once — it reads
**Deselect all** while everything is selected, and **Select all** otherwise.

Positions that couldn't be read are listed but not selectable, greyed out with
the reason shown inline.

!!! tip "Start small"
    Import takes tens of seconds per position, and point counts run to millions
    — a full-dome VZ-1000 position in our testing was ~13 M points and ~760 MB
    in memory, though this varies with the survey's field of view and angular
    resolution. Import one or two positions first to check the data is what you
    expect.

    You can cancel a running import from the progress dialog. Cancelling
    discards the whole import — including positions that had already finished —
    so nothing half-imported is left in the scene. An import that somehow runs
    past an hour is stopped automatically.

## What you get, and what you don't

### Which frame the points land in

#### A `.riproject` is never registered

Raw scanner data from an older instrument carries **no alignment** — that is
what RiSCAN PRO produces. Each position is recorded in its own frame, with the
scanner at its origin.

Where a position has a **GNSS fix**, Phytograph places it at that fix's offset
from the project centroid. This is a *starting point*, not a registration: the
instrument's built-in GNSS is metres-accurate, not survey-grade. Use it to seed
[ICP registration](register-compare.md), which refines the alignment properly.

The centroid is the whole project's, not just the positions you ticked, so a
position lands in the same place whether you import it on its own or alongside
the rest. That means you can import positions in separate batches and they will
still line up with each other.

Where a position has **no fix**, it imports at the origin — so several such
positions will sit on top of one another until you register them.

#### …but it can still be levelled

Even without registration, the scanner recorded **which way was down**. A
V-Line instrument writes its dual-axis inclinometer into the scan, and that
reading is genuinely precise: checked against RiSCAN PRO's own transforms on
two separate projects, it agrees to within a few hundredths of a degree.

The picker therefore offers **Level using the onboard inclination sensor**,
which is **on by default**. It rotates each position upright using its own tilt
reading — typically 1–3°, occasionally 4°, depending on how carefully the
tripod was levelled.

This matters more than it sounds. Ground segmentation, [DEM
generation](generate-dem.md) and any slope measurement all assume the cloud is
plumb. A 3° tilt displaces a point 50 m away by about 2.6 m vertically, which
is enough to bend a "ground" surface that should be flat.

!!! warning "Levelled is not aligned"

    Levelling fixes tilt and **nothing else**. It does not rotate scans to
    north and it does not align them to each other — you still need
    [ICP registration](register-compare.md) for that.

    The instrument does record a compass heading, and Phytograph deliberately
    **ignores it**. Measured against RiSCAN's transforms it was 10–14° wrong,
    and the scanner's own confidence figure did not predict the error — a
    reading claiming 0.22° accuracy was 14° out. A heading that wrong is worse
    than none, because it looks aligned.

Positions that recorded no usable tilt simply import unlevelled; the picker
says how many, and the rest are still levelled.

!!! note "What the Scans panel's **tilt** row means"

    It reports the tilt **the cloud has**, not the reading the inclinometer
    took — so it answers "is this cloud plumb?", which is the question the rest
    of your workflow depends on.

    | Imported | Panel shows | Because |
    |---|---|---|
    | **Levelled** | `roll 0° · pitch 0° (level)` | The tilt was rotated out of the points |
    | **Unlevelled** | the measured tilt, e.g. `roll 1.32° · pitch 2.97°` | The points kept it |

    The row is always shown, so `0° (level)` is a statement rather than a gap.
    Levelling does not discard the measurement — it is what produced the
    rotation, and it stays with the scan.

    If you want the angular model to describe the instrument as it physically
    sat on the tripod (which is what [LAD](../concepts/leaf-area-density.md)
    wants — see below), import unlevelled.

#### A `.PROJ` usually is, but only partly

A newer instrument registers on board as it goes, and stores the result per
position. Phytograph uses it by default: the scans land **already aligned**, in
a frame whose **+Z is true up and +Y is true north**, so the ground is level
and no ICP is needed between them.

Registration routinely **fails for some positions**, so the picker reports each
one:

| Badge | Meaning |
| --- | --- |
| **registered** | Placed by the project's own registration result — accurate to millimetres |
| **prior only** | Registration failed here. Placed from the scanner's inclinometer, compass and GNSS instead — accurate to about a metre. **Refine with ICP.** |
| **no pose** | No position information at all (an aborted acquisition). Imports at the origin |

The summary under the list says how many of each you are about to get, and the
toast after the import repeats it. In one 24-position orchard project we tested
against, 8 positions registered and 15 fell back to the prior — a normal
outcome, not a fault.

#### Keeping scanner-local coordinates instead

The picker offers **Keep scanner-local coordinates** for a `.PROJ`. Ticking it
imports every position unregistered, exactly as a `.riproject` behaves.

This exists for [Leaf Area Density](../concepts/leaf-area-density.md). LAD
models a scan as an origin plus a θ/φ sweep, with **no scanner tilt**. In the
scanner's own frame that description is exact. Once a scan is rotated into the
project frame, the instrument's real tilt off plumb — under 2° in our reference
project — is no longer represented, and the LAD raster carries that much error.

So: leave it unticked for a levelled, mutually-aligned scene, which is what
almost every workflow wants. Tick it when you are running LAD on a single
position and want the angular model to be exact.

### Sky/miss points are recovered exactly

An `.rxp` file stores only *returns* — a shot that hits nothing is absent
rather than flagged — so the miss rays have to be recovered separately.
Phytograph reads them from the scanner's own record of every laser shot, which
means each miss carries its **true beam direction** rather than one inferred
from the scan grid. On a typical scan they are a large fraction of the data
(about 46% of shots on our reference position).

They are placed 20 km along their beam, the same far-field shell every other
Phytograph importer uses, and flagged with `is_miss` — so they are hidden by
default, excluded from the bounding box, and available to
[Leaf Area Density](../concepts/leaf-area-density.md), which needs them for its
Beer's-law transmission term.

To see them, turn on **Show sky/miss points** for the scan.

### What does come through

| Field | Notes |
| --- | --- |
| Position (x, y, z) | Registered into the project frame, or scanner-local offset by the GNSS fix |
| Reflectance | dB relative to a white diffuse target; drives the default colouring |
| Amplitude | dB |
| Deviation | Pulse-shape distortion measure |
| Target index / count | Per-pulse return numbering, for multi-return analysis |
| Scan parameters | Sweep and resolution from the position's `.pat` (`.riproject`) or `.scn` (`.PROJ`) file |
| Scanner heading and tilt | `.PROJ` only, when imported registered: recovered from the pose |
| Instrument | Named by the file, and used for the scan's marker. The V-Line models have their own entries (VZ-400i, VZ-1000, VZ-2000i); another VZ is marked as **RIEGL VZ-series** rather than being labelled as a model it isn't |

Multi-return numbering is derived by grouping returns that share a pulse
timestamp. If that grouping ever disagrees with the scanner's own echo
classification, the toast shown when the import finishes says how many positions
were affected, and those two columns should not be trusted for multi-return work
on those scans — the points themselves are unaffected.

!!! tip "This is the right path for multi-return LAD"
    Importing the project directly preserves every echo. Going through a PTX
    export from RiSCAN PRO does not: PTX stores one point per grid cell, so each
    pulse is collapsed to a single echo and the per-pulse columns above are lost.
    That biases LAD **high** (Kent and Bailey,
    [2024](https://doi.org/10.1016/j.rse.2024.114229)) and does so silently — the
    re-imported scan is genuinely single-return, so nothing downstream can warn
    you. If you must go through an intermediate file, use a structured `.e57`.
    See [Single- vs multi-return scans](../concepts/leaf-area-density.md#single-vs-multi-return-scans).

That same toast says how the scans were placed — how many were registered, how
many came from a prior and still want ICP, or that they are unregistered
altogether.

Because the project records where the instrument stood at each position, an
import into an **empty** scene also places the [scene
origin](clean-point-cloud.md#setting-the-scene-origin) — the pivot the view
orbits about — at the **average of those scanner positions**, rather than at
the middle of the point cloud's bounding box. **Snap to scanner** in the Scene
Origin panel moves it onto any single position, and **Reset to scene center**
puts it back on the bounding box.

## Troubleshooting

**"RIEGL .rxp import is macOS-only in this release."**
: Expected on Windows and Linux. Export from RiSCAN PRO or RiPROCESS instead.

**"Docker is not running."**
: Start Docker Desktop. The badge re-checks on its own within a few seconds.

**"No `lib/libscanifc.so` under …"**
: The chosen folder isn't a RiVLib root. Pick the level containing `bin/`,
  `include/` and `lib/`.

**"Docker is not running" while Docker Desktop is clearly up.**
: Fixed in v0.68.0. Older builds probed Docker with a call that forked the
  backend process; with the LiDAR and PROJ libraries loaded, the forked child
  crashed before it could run `docker`, which the probe read as "Docker
  absent" (and macOS reported as *"Python quit unexpectedly"*). Update, or
  restart the app if you are on the current version.

**The import is slower than RiSCAN PRO.**
: Expected. RiVLib runs natively there; here it runs under x86 emulation inside
  a container, and Phytograph additionally builds a level-of-detail octree so
  large scans stay interactive.

**Dropping the folder does nothing / files are rejected one by one.**
: Make sure you are dropping the `.riproject` **folder**, not its contents. A
  folder of loose `.rxp` files is not a project.

**The picker opens but lists no scan positions.**
: Positions are found by looking for sub-directories named `ScanPos…`
  (`.riproject`) or `ScanPos….SCNPOS` (`.PROJ`) — the layouts RIEGL's V-Line
  instruments write. A project organised any other way isn't recognised. A
  position whose folder exists but holds no `.rxp` is skipped rather than
  listed as broken.

**"The RIEGL reader image is out of date and updating it automatically failed."**
: Phytograph normally rebuilds a stale reader image by itself at the start of an
  import, so you only see this if that rebuild failed — most often because
  Docker stopped between the check and the build. Start Docker Desktop and try
  the import again, or click **Rebuild reader image** in Settings to see the
  build's own error.

**A `.PROJ` imports, but the scans are not aligned.**
: Check the badges in the picker. If they say **prior only**, the instrument's
  own registration failed for those positions and they are placed to about a
  metre; run [ICP](register-compare.md) to refine them. Also check you did not
  leave **Keep scanner-local coordinates** ticked.

**A `.PROJ` holds `.rdbx` files — are those used?**
: No. Phytograph reads the `.rxp` beside them. The `.rdbx` is RIEGL's processed
  cloud and would need a second licensed library to open, and it does not
  contain the no-return shots that Leaf Area Density depends on.
