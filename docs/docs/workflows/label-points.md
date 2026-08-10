# Label points by hand

The automatic classifiers — [ground](segment-ground.md),
[leaf/wood](segment-wood.md), [individual trees](segment-trees.md) — get most of
a cloud right, but not all of it. **Label Points** lets you assign classes by
hand: to correct what a classifier got wrong, or to build ground truth for
checking how well it did.

Classes are yours to define. Phytograph ships three starting sets, but you can
label anything you like.

## Label

1. Select a single point cloud.
2. Click **Label Points** (the brush icon in the **Tools** › Segmentation
   group), or open the command palette and choose **Label Points**.
3. Pick the class you want to paint by clicking it in the class list. The
   number keys `1`–`9` select the first nine classes.
4. Draw a **lasso** around the points to label: click to place each corner, then
   press `Enter` (or double-click) to close it. Everything inside the lasso
   takes the active class.
5. Repeat with different classes as needed. **Undo** removes the last stroke.
6. Click **Commit** to save the labels into the point cloud.

Each class row shows how many points currently carry it, so you can see the
counts move as you work.

!!! warning "Commit before you close"
    Strokes are not saved until you press **Commit**. The panel shows a count of
    unsaved strokes, and **File › New** warns you before discarding them.
    Phytograph has no project file, so uncommitted labelling is lost when the app
    closes — commit, then [export](import-export.md) if you want it on disk.

## Class sets

Use **Classes** in the panel to switch between the built-in sets:

- **Wood / leaf** (the default) — matches what
  [Separate leaf and wood](segment-wood.md) writes, so you can correct its
  output in the same vocabulary.
- **Plant organs** — leaf, petiole, shoot, peduncle, fruit, petiolule. These are
  the same organ codes a [simulated scan](simulate-scan.md) carries, so
  hand-labelled and simulated data can be compared directly.
- **ASPRS standard** — the LAS classification codes (Ground, Low/Medium/High
  Vegetation, Building, Water…), for data that has to line up with other LiDAR
  software.

Every set includes **Unclassified** (class 0), which is what points start as.

## Only repaint certain classes

The small circle on each class row is a **repaint filter**. Switch it on for one
or more classes and a stroke will only affect points already in those classes —
everything else inside the lasso is left alone.

This is what makes fast, rough lassos safe. To reclassify some leaf points as
wood, filter to **Leaf** and paint freely: the ground and trunk points your
lasso also covers are untouched.

With no filter set, a stroke repaints any visible class.

## Show and hide classes

The eye icon on each row hides that class from the viewer. Hidden classes are
also skipped when repainting, so hiding a class you have finished with protects
it while you work on the rest.

## What happens to the labels

Labels are stored on the cloud as a `manual_class` attribute. Once committed
they behave like any other scalar:

- colour the cloud by them (they appear in the colour-by list with your class
  names and colours),
- [filter](clean-point-cloud.md) to particular classes,
- split the cloud into one cloud per class,
- [export](import-export.md) them to LAS/LAZ.

!!! note "Lasso selection cuts through the cloud"
    A lasso is drawn on screen, so it selects every point inside it at **every
    depth** — including points behind the ones you can see. On a dense canopy,
    orbit to an angle where the points you want are not in front of anything
    else, or hide the classes you have already finished.

    Depth-limited painting and a cross-section view are planned.
