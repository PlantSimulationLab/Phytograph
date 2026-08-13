# Import a RIEGL raw project (.riproject)

This walkthrough covers importing **raw RIEGL scanner data** — a `.riproject`
directory straight off a V-Line instrument — without going through RiSCAN PRO
first.

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
    | ✗ Reader image built | Click **Build reader image** — a one-time step; the image is ~300 MB on disk once built |

    The image is always built locally from your own RiVLib copy; it is never
    downloaded pre-made, because publishing it would mean redistributing RiVLib.

## Import a project

Either:

- **File → Import → RIEGL Project…** and pick the `.riproject` folder, or
- **drag the `.riproject` folder** onto the viewer.

Phytograph reads the project's metadata (a few seconds) and opens a picker
listing every scan position:

- **Point count** — a lower bound (`≥`). The picker only probes the start of
  each file rather than decoding it; the exact count appears after import.
- **Sweep** — the commanded field of view, e.g. `30–130° × 0–360°`.
- **Instrument** — e.g. `VZ-1000`.
- **GNSS ✓ / no GNSS** — whether that position recorded a satellite fix. This
  decides where its points land (see below).

A small plan view shows the positions laid out by their GNSS fixes, so an
implausible layout is visible before you commit to the import.

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

### The scans are not registered

Raw scanner data carries **no alignment** — that is what RiSCAN PRO produces.
Each position is recorded in its own frame, with the scanner at its origin.

Where a position has a **GNSS fix**, Phytograph places it at that fix's offset
from the project centroid. This is a *starting point*, not a registration: the
instrument's built-in GNSS is metres-accurate, not survey-grade. Use it to seed
[ICP registration](register-compare.md), which refines the alignment properly.

Where a position has **no fix**, it imports at the origin — so several such
positions will sit on top of one another until you register them.

### Sky/miss points are not recovered

An `.rxp` file records only *returns*. Shots that hit nothing are simply absent
rather than flagged, so an imported RIEGL scan has no sky/miss points.

The practical consequence: **[Leaf Area Density](../concepts/leaf-area-density.md)
will refuse to compute** for these scans, because LAD needs the miss rays for
its Beer's-law transmission term.

[Backfill Misses](backfill-misses.md) is not offered for them either — the
button simply doesn't appear. Reconstructing misses needs either a per-point
`timestamp` or both grid indices, and a `.riproject` import carries neither, so
LAD lists these scans as unable to recover misses and points you at re-importing
a format that retains them (E57 or structured PLY). Exporting to `.e57` from
RiSCAN PRO is the practical route for RIEGL data.

Every other tool works normally.

### What does come through

| Field | Notes |
| --- | --- |
| Position (x, y, z) | Scanner-local, offset by the GNSS fix where present |
| Reflectance | dB relative to a white diffuse target; drives the default colouring |
| Amplitude | dB |
| Deviation | Pulse-shape distortion measure |
| Target index / count | Per-pulse return numbering, for multi-return analysis |
| Scan parameters | Sweep and resolution from the position's `.pat` file |
| Instrument | Recognised models get their marker and beam defaults |

Multi-return numbering is derived by grouping returns that share a pulse
timestamp. If that grouping ever disagrees with the scanner's own echo
classification, the toast shown when the import finishes says how many positions
were affected, and those two columns should not be trusted for multi-return work
on those scans — the points themselves are unaffected.

That same toast always reminds you the scans are unregistered.

## Troubleshooting

**"RIEGL .rxp import is macOS-only in this release."**
: Expected on Windows and Linux. Export from RiSCAN PRO or RiPROCESS instead.

**"Docker is not running."**
: Start Docker Desktop. The badge re-checks on its own within a few seconds.

**"No `lib/libscanifc.so` under …"**
: The chosen folder isn't a RiVLib root. Pick the level containing `bin/`,
  `include/` and `lib/`.

**The import is slower than RiSCAN PRO.**
: Expected. RiVLib runs natively there; here it runs under x86 emulation inside
  a container, and Phytograph additionally builds a level-of-detail octree so
  large scans stay interactive.

**Dropping the folder does nothing / files are rejected one by one.**
: Make sure you are dropping the `.riproject` **folder**, not its contents. A
  folder of loose `.rxp` files is not a project.

**The picker opens but lists no scan positions.**
: Positions are found by looking for sub-directories named `ScanPos…` — the
  layout RIEGL's V-Line instruments write. A project organised any other way
  isn't recognised.
