# Work with scalar fields

A **scalar field** is one number per point. Some arrive with the file —
intensity, reflectance, GPS time, a return index — and others are written by
Phytograph's own tools: `curvature` and `verticality` from
[Compute normals](compute-normals.md), `ground_class` from
[Segment ground](segment-ground.md), `height_above_ground` from
[Generate a DEM](generate-dem.md), `wood_class`, `tree_instance`, `noise_class`.

The **Scalar Fields** tool (Tools → Scalar Fields, or ++cmd+k++ → "Scalar
Fields") lets you inspect those numbers, derive new fields from them with a
formula, and tidy up the ones you no longer need.

A field you create here is an ordinary scalar field. It appears in the **Color
by** dropdown, in the [Filter](clean-point-cloud.md#filter) panel's field list,
and in the export column picker, exactly like one that came from the file.

## Work on several clouds at once

The panel has its own **cloud list** at the top. It starts out matching whatever
you have selected in the scene, but from then on it is the tool's own input:
checking and unchecking there changes what the tool measures and writes to,
without disturbing your selection in the viewer.

With more than one cloud checked:

- **Stats** pools them into **one** distribution — the clouds' points are
  measured together, not side by side.
- **Compute** runs your formula on each checked cloud in turn, so each ends up
  with its own copy of the new field.
- **Rename**, **duplicate** and **delete** likewise apply to every checked cloud.

The field list shows only the fields **every** checked cloud carries. If one
cloud has a field the others lack, it is not offered, and a note under the list
says how many fields were hidden and why — acting on a field only some clouds
have would half-apply and leave them out of step.

!!! warning "Coordinates are measured one cloud at a time"

    `x`, `y` and `z` cannot be pooled. Each cloud stores its coordinates in its
    own frame — a large global offset is subtracted when the cloud is imported,
    so two clouds imported at different offsets hold coordinate numbers that do
    not share an origin. A pooled mean or percentile over them would be
    arithmetic across two different frames, and the result looks like a perfectly
    ordinary number, so Phytograph declines it rather than warning about it. The
    rows stay visible, marked *per cloud only*. Check a single cloud to measure
    its coordinates.

If something fails on one cloud partway through, the others still finish, and
the panel names the clouds that failed rather than reporting one opaque error.

## Inspect a field

Check one or more clouds, open the tool, and go to the **Stats** tab. Pick a
field and Phytograph reports its distribution:

| | |
|---|---|
| **Points** | How many points the statistics cover |
| **Mean**, **Std dev** | Average and spread |
| **Min**, **Max** | The true extremes, outliers included |
| **Median**, **percentiles** | 5th, 25th, 75th and 95th |

Above the table is a histogram. Hover a bar to read its value range and point
count.

!!! note "What the numbers are measured over"

    Statistics cover the points that are **visible and are real returns** —
    hidden points and sky/miss points are excluded. That is the same population
    the colour scale uses, so the numbers always agree with the legend beside
    them. A sky/miss point is a laser pulse that hit nothing, recorded about a
    kilometre out along the beam; including those would make a mean or a
    histogram meaningless.

    The panel says so under the table whenever the two counts differ.

    With several clouds checked, each cloud's own hidden and sky/miss points are
    excluded **before** the clouds are pooled, and the caption says how many
    clouds the distribution covers.

!!! tip "Class columns pool differently from measurements"

    A pooled histogram of a class column (`wood_class`, `tree_instance`) is
    useful — it shows the class mix across the plot. A pooled *mean* or
    *percentile* over one is not: class ids are labels, and `tree_instance`
    numbers objects per cloud, so the same id means a different tree on each.
    The panel flags this beside the numbers; read the histogram instead.

The histogram is binned over the 1st–99th percentile rather than the full range,
so a single spike cannot squash every real value into the first bar. Points
outside that span are still counted, and the caption under the chart says how
many fall above or below.

## Derive a new field

Go to the **Compute** tab, type a formula, give the result a name, and click
**Compute Field**. Reuse the name of a field you derived earlier and the button
reads **Recompute Field** — editing a formula and running it again replaces the
field in place, so you do not have to delete it first. An imported or
tool-written column can never be replaced this way; those are measurements, and
overwriting one would invalidate anything already computed from it.

```
intensity * 2
sqrt(x**2 + y**2)
z - height_above_ground
degrees(acos(nz))
```

A formula may also be a bare constant (`0`, `pi * 2`), which fills every point
with the same value — useful for seeding a column you then edit by hand.

Refer to any field by its name. **Show available names** lists everything the
checked clouds offer, including `x`, `y` and `z`.

With several clouds checked the formula runs on each in turn, and the names you
may use are the ones **all** of them carry — otherwise the formula would work on
the first cloud and fail partway down the list. Coordinates stay available here
even when they are unavailable in **Stats**: each cloud is computed on its own,
so `z - height_above_ground` never mixes frames.

### Operators and functions

| | |
|---|---|
| Arithmetic | `+` `-` `*` `/` `//` `%` `**` |
| Comparison | `>` `<` `>=` `<=` `==` `!=`, and `and` / `or` / `not` |
| Maths | `sqrt` `abs` `exp` `log` `log10` `log2` `floor` `ceil` `round` `sign` |
| Trigonometry | `sin` `cos` `tan` `asin` `acos` `atan` `atan2` `degrees` `radians` |
| Pick a value | `min(a, b)` `max(a, b)` `clamp(v, lo, hi)` `ifelse(test, a, b)` |
| Constants | `pi` `e` `nan` `inf` |

A comparison produces 1 where it holds and 0 where it does not, so
`ifelse(curvature > 0.1, 1, 2)` builds a two-class column you can then colour
by or filter on.

### Whole-field values

`mean`, `std`, `median`, `sum`, `count` and `percentile` take a whole field and
give back one number, which you can use inside a larger formula:

```
(intensity - mean(intensity)) / std(intensity)
intensity / percentile(intensity, 95)
```

The first is a z-score — the field rescaled to mean 0 and standard deviation 1,
which makes two scans with different gain settings directly comparable.

These are measured over the same visible, real-return points the Stats tab
reports, so `mean(intensity)` is the mean you can see there.

### When a value cannot be computed

Dividing by zero or taking the log of a negative gives infinity or NaN rather
than failing the whole field. Phytograph counts them, says so in the toast, and
excludes them from the statistics. They are also excluded from the colour scale,
so those points render at the end of the ramp.

## Rename, duplicate and delete

The **Fields** tab lists every field on the cloud. Hover a row for its menu:

- **Rename** — the field keeps its values, and the viewer keeps colouring by it.
- **Duplicate** — an independent copy, useful before an edit you may want to undo.
- **Delete** — removes the column from the cloud.

Some fields are marked **locked** and have no menu. Other tools read those by
name — `is_miss` is what leaf area density uses to know which pulses returned
nothing, and the class columns are what the segmentation tools and the colour
palettes look for — so renaming or removing one would quietly break them.
`x`, `y`, `z` and `intensity` are marked **built-in**: you can use them in a
formula, but they are not columns to be renamed.

Rename and Duplicate open a small name box in the row; Delete asks for
confirmation there too.

!!! warning "Deleting a field cannot be undone"

    Point-cloud edits are not kept in the undo history (they are far too large),
    so a deleted column is gone. Duplicate it first if you are unsure.

## Export a derived field

Derived fields appear in the export column picker like any other. See
[Import & export](import-export.md).

- **LAS/LAZ** — written as an extra dimension under its own name.
- **CSV/TXT/XYZ/ASC** — written as a named column.
- **PLY** — written as `property float <name>`.

Field names are limited to letters, digits and underscores, and must start with
a letter or underscore, because the name has to survive as a LAS dimension name
and an ASCII column header. Phytograph also refuses a name that would collide
with one it recognises on import — `time`, `elevation` and similar — since a
field called `time` would be read back as the GPS time column.

## Large clouds

On a cloud over about 5 million points the new column is written immediately but
the display catches up in the background: the field is usable for export, for
another formula and for every other tool right away, while the recolouring
finishes shortly after.
