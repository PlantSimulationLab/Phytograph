# Export aerial data from RiPROCESS (with pulse origins)

This walkthrough is for users processing **RIEGL** airborne or UAV laser-scanning
data in **RiPROCESS** who need an export that **retains the per-pulse emission
origin** — where each return's beam came from along the flight path.

RIEGL's processing model — like most airborne LiDAR — does not store a ready-made
world-frame "beam origin" coordinate on every point. Instead, the origin is
recoverable from a **per-point timestamp** on the cloud plus the **platform
trajectory** (position + attitude over time): the timestamp says *when* each
return was recorded, and the trajectory says where the sensor was at that instant.

So the goal in RiPROCESS is to export **two things on a common clock**: the point
cloud **with GPS time**, and the **trajectory** as SBET.

!!! note "Why not a per-point origin column?"
    RiPROCESS's per-point RIEGL attributes are expressed in the **sensor
    coordinate system** (e.g. the beam vector in SOCS), not a world-frame origin
    you can export directly as three coordinate columns. Exporting the timestamped
    cloud plus the trajectory is therefore the correct way to retain pulse origins
    from RiPROCESS — it matches RIEGL's own data model.

## Before you start

Finish your normal RiPROCESS processing first — trajectory import/adjustment,
target extraction (SDCImport), and global registration (RiWorld / point-cloud
validation). The export below assumes a **finalized, georeferenced** project.

Pick **one geographic/projected coordinate reference system** (e.g. a UTM zone)
and use it for **both** exports. RiPROCESS's GeoSysManager can transform the
output into an EPSG or user-defined CRS on export. Keeping the cloud and the
trajectory in the same CRS lets them be joined later in one frame.

## Step 1 — Export the point cloud as LAS/LAZ with GPS time

In RiPROCESS's point-cloud export:

1. Choose **LAS** or **LAZ** as the output format (RiPROCESS supports LAS/LAZ 1.2
   and 1.4).
2. Use a **point format that carries GPS time** (LAS point formats 1, 3, 4, 5, or
   6+). This is the single most important setting — without a per-point timestamp
   there is nothing to tie the trajectory to.
3. Prefer **Adjusted Standard GPS time** (an absolute clock) over GPS *week* time
   if the option is available — see Step 3.
4. Set the target **CRS** in GeoSysManager to your chosen projected system.

RiPROCESS manages leap-second handling when it writes GPS/UTC timestamps, so the
exported times stay consistent with the trajectory exported from the same project
(Step 2).

Optionally include RIEGL echo attributes (amplitude, reflectance, deviation) via
LAS **Extra Bytes** (supported in recent RiPROCESS releases). These are not
required to retain pulse origins.

## Step 2 — Export the trajectory as SBET

From the project's trajectory export, write the trajectory in **SBET** format (the
standard Applanix Smoothed Best Estimate of Trajectory). If a precision/accuracy
companion (a `*-smrmsg`-style file) is offered, you can export it too — it carries
per-epoch position-RMS quality values.

SBET stores the platform's position (latitude/longitude/altitude) and attitude
(roll/pitch/heading) over time, which is what makes the per-pulse origin
recoverable.

## Step 3 — Keep the clocks matched

The timestamp on the point cloud and the time field in the trajectory must be on
the **same clock**. Because both come out of the same finalized RiPROCESS project,
they will be — provided you don't change the time base between the two exports.

Prefer **Adjusted Standard GPS time** (an absolute clock) for the cloud. GPS
*week* time carries no absolute epoch, so a cloud on week-time can't be aligned to
a trajectory on a different absolute clock without extra bookkeeping.

## Troubleshooting

- **No per-point time in the cloud** — you exported a LAS point format without GPS
  time. Re-export with point format 1/3/6+ and GPS time enabled.
- **Cloud and trajectory don't line up in space** — they were exported in
  different CRSs. Re-export both through GeoSysManager into the same projected CRS.
- **Ambiguous time base** — re-export the cloud with **Adjusted Standard GPS
  time** so it shares an absolute clock with the trajectory.
