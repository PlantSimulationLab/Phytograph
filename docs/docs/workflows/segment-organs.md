# Segment plant organs

For herbaceous plants (tomato, soybean, bean, sugar beet, pepper, and the
like), Phytograph can label every point of a scan as **soil**, **stem** or
**leaf**, and give every **leaflet** its own number. That is the input
plant-architecture fitting needs: which points are stem, and which leaf points
belong to the same leaflet.

It runs a PointNeXt network trained mostly on Helios synthetic scans of eight
dicot species, potted and in field rows, plus a small share of hand-labeled
real plants (tomato, soybean and sugar beet). It uses an NVIDIA GPU
(Windows/Linux) or an Apple-silicon GPU when one is available, and otherwise
runs on the CPU. A potted plant of 100,000 points takes a few seconds.

**What it is for:** a single herbaceous plant, in a pot or in a row, scanned at
about **3 mm point spacing or finer**. Leave the soil or pot in; soil is one of
the classes. Stems include the **petioles** and the small stalks of the
leaflets.

**What it is not for:** trees and woody shrubs (use
[Separate leaf and wood](segment-wood.md)), grasses and cereals (maize, wheat),
and clouds sparser than about 3 mm, where it still separates soil, stem and
leaf but merges small leaflets.

## Segment

1. Select the point cloud holding the plant. To do several plants in one go,
   select all their clouds (**Cmd**/**Ctrl**-click); each is segmented on its
   own, one after another, so each cloud should hold one plant.
2. Click **Segment Plant Organs** (the clover icon in the **Tools** ›
   Segmentation group), or open the command palette and choose
   **Segment Plant Organs**.
3. Check the options:
    - **Units** — what the cloud's coordinates are in. The model works in
      meters, and an XYZ file does not say which unit it was written in.
      **Auto** (the default) reads it from the cloud's size: anything more than
      30 units across is taken as **millimeters**, anything smaller as
      **meters**. Pick **Meters**, **Centimeters** or **Millimeters** to
      override it, for example for a very small seedling scanned in
      millimeters.
    - **Color result by** — **Organ** (soil / stem / leaf) or **Leaflet**.
      Both are written either way; this only picks what the cloud is colored
      by when the run finishes.
    - A **GPU**/**CPU** pill shows where the model will run. When more than
      one plant-organ model is installed, a model picker appears above it.
4. Click **Segment Organs** (**Segment N Scans** with several selected). While
   it runs, a **Cancel** button appears beside it; canceling stops the
   computation and leaves the cloud being worked on unchanged. With several
   clouds, the button counts through them (**Segmenting 2 of 5…**), and
   canceling also skips the ones not yet started; clouds already finished keep
   their result.

When it finishes, a message reports the number of leaflets, the soil, stem and
leaf point counts, and **which units it read the cloud in**. With several
clouds it lists each one's leaflet count instead, and names each cloud's units
when **Auto** read them differently. If one cloud fails, the others are still
segmented; an error names the one that failed and the panel stays open. A
second message appears when the units deserve a look:

- the cloud is not plant-sized in the units used (under 2 cm or over 5 m
  across): pick the real units and run it again;
- **Auto** read it as millimeters and it is 30 to 300 units across. That is a
  3-30 cm plant in millimeters, but also a 30-300 cm plant in centimeters, and
  the size cannot tell them apart. The message says which reading was taken; if
  the cloud is in centimeters, pick **Centimeters** and run it again.

## The result

Two attributes are added to every point, and both are kept with the cloud:

| Attribute | Values |
|---|---|
| **Plant organ** | 1 Soil, 2 Stem, 3 Leaf |
| **Leaflet** | 1, 2, 3 … one number per leaflet; 0 for soil, stem, and leaf points in no leaflet |

A leaf point is in no leaflet (0) when it belongs to a patch too small to count
as one (under about 1 cm²). Leaflets are numbered by **height, lowest first**. On a single scan there is no
leaf age, and height is the usual stand-in for it on an upright plant (lower
leaves are older), so software that reads increasing leaflet numbers as
increasing age gets a sensible order. It is only a stand-in: a drooping old
leaf can sit below a younger one.

Switch between the two colorings at any time in **Display** › color mode
(**Plant organ** or **Leaflet**). The organ coloring shows a legend; the
leaflet coloring does not (a tomato can have more than a hundred leaflets),
but every leaflet gets its own color.

To keep only some organs, use [Filter Points](clean-point-cloud.md) on the
**Plant organ** attribute (for example, keep Stem and Leaf to drop the soil).
To take the result to other software, [export](import-export.md) the cloud as
ASCII or LAS with its attributes: `x y z plant_organ leaflet_id`.

## How accurate is it?

Measured on plants held out of training:

| Plant | Soil / stem / leaf | Leaflets found |
|---|---|---|
| Tomato (Pheno4D, real, mixed ages) | 0.88 mIoU | 0.78 F1 |
| Soybean (Demeter, real) | 0.85 mIoU | 0.79 F1 |
| Sugar beet (Sugar4D, real) | — | 0.92 F1 (whole leaves) |

The weakest part is **small leaflets on large compound leaves**: tomato
leaflets under about 3 cm are sometimes merged with a neighbor. Stems are
harder than leaves (a petiole is a few millimeters across), so expect some
stem points at leaflet bases to be called leaf and the other way round.

!!! note "Species it has not seen"
    The model was trained on eight dicot species, almost all of it synthetic.
    It holds up on dicots outside its real training data: trained the same
    way but with every real tomato left out, it still found tomato's leaflets
    with an F1 of 0.74 (against 0.45 for a model trained on the other real
    plants alone). It has never seen a grass, and will not separate a grass
    leaf from its sheath.
