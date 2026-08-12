# Label points by hand

The automatic classifiers — [ground](segment-ground.md),
[leaf/wood](segment-wood.md), [individual trees](segment-trees.md) — get most of
a cloud right, but not all of it. **Label Points** lets you assign classes by
hand: to correct what a classifier got wrong, or to build ground truth for
checking how well it did.

Classes are yours to define. Phytograph ships four starting sets, but you can
label anything you like.

## Label

1. Select a single point cloud.
2. Click **Label Points** (the brush icon in the **Tools** › Segmentation
   group), or open the command palette and choose **Label Points**.
3. Pick the class you want to paint by clicking it in the class list. The
   number keys `1`–`9` select the first nine classes.
4. Draw a **lasso** around the points to label: click to place each corner, then
   press `Enter` (or double-click) to close it. Everything inside the lasso
   takes the active class, and recolours straight away.
5. Repeat with different classes as needed. **Undo** removes the last stroke.
6. Click **Commit** to save the labels into the point cloud.

Each class row shows how many points currently carry it, so you can see the
counts move as you work.

!!! tip "Press `L` to look around"
    While the lasso is armed every viewport click places a corner, so you can't
    orbit. Press `L` — or click **Drawing — view frozen** — to disarm it, move
    the camera freely, then press `L` again to carry on. The panel stays open
    and your class selection is kept.

The panel states what the next stroke will do in words, e.g.
*"Painting **Leaf** over **any visible class**"*. Read that line if a stroke
does not do what you expect.

!!! warning "Commit before you close"
    Strokes are not saved until you press **Commit**. The panel shows a count of
    unsaved strokes, and **File › New** warns you before discarding them.
    Phytograph has no project file, so uncommitted labelling is lost when the app
    closes — commit, then [export](import-export.md) if you want it on disk.

## Class sets

Use **Preset** in the panel to switch between the built-in sets:

- **Wood / leaf** (the default) — matches what
  [Separate leaf and wood](segment-wood.md) writes, so you can correct its
  output in the same vocabulary.
- **Plant organs** — leaf, petiole, shoot, peduncle, fruit, petiolule. These are
  the same organ codes a [simulated scan](simulate-scan.md) carries, so
  hand-labelled and simulated data can be compared directly.
- **Ground / non-ground** — matches [Segment ground points](segment-ground.md).
- **ASPRS standard** — the LAS classification codes (Ground, Low/Medium/High
  Vegetation, Building, Water…), for data that has to line up with other LiDAR
  software.

Every set includes **Unclassified** (class 0), which is what points start as.

!!! note "A class set also names the column it reads"
    Each set describes a different **attribute** on the cloud, not just a list of
    names. Ground / non-ground reads what the ground-segmentation tool wrote;
    ASPRS reads an imported LAS classification byte; wood/leaf and organs read
    the hand-labelling column. So switching sets changes both the class names
    *and* which existing classification you are looking at — a cloud that has
    been ground-segmented shows its real counts under **Ground / non-ground**
    and zeros under the others until you paint something.

### Define your own classes

The presets are starting points, not the vocabulary. **Edit** in the panel opens
the class editor, where you can add classes, rename and recolour them, and save
the result as a palette of your own.

- **Add class** appends a new class in the 64–255 band, which LAS reserves for
  user-defined codes — so your classes never collide with the ASPRS standard
  ones. (Labels currently export as their own `manual_class` column rather than
  the LAS classification byte; keeping custom classes in 64–255 means the
  numbers stay valid when writing that byte becomes an option.)
- **Save palette** applies it, binds it to the cloud (so it is still there when
  you reopen the tool), and adds it to your saved palettes.
- **Export / Import** move palettes between projects or collaborators as a JSON
  file, so a labelling scheme agreed once can be reused by everyone.

Two rules the editor enforces, both to protect points you have already painted:

- **Unclassified (class 0) cannot be removed or renumbered.** Points from an
  unlabelled or merged cloud arrive as 0, so 0 has to mean "unclassified"
  everywhere.
- **A class that already has points keeps its value.** The class *number* is
  what gets stored in the file, so repointing a class that is in use would leave
  those points holding a number the palette no longer describes. Renaming and
  recolouring stay available — only the number is fixed.

## Only repaint certain classes

The class list has two distinct controls, and it is worth being clear about
which is which:

- **Clicking the row** picks the class a stroke **paints** (the highlighted row).
- **The dot in the `over` column** picks which classes a stroke is allowed to
  paint **over**.

Switch the dot on for one or more classes and a stroke only affects points
already in those classes — everything else inside the lasso is left alone. This
is what makes fast, rough lassos safe: to reclassify some leaf points as wood,
select **Wood** as the paint class, set the `over` dot on **Leaf**, and paint
freely. The ground and trunk points your lasso also covers are untouched.

With no dot set, a stroke repaints any visible class.

!!! warning "Painting a class over itself does nothing"
    Selecting **Wood** *and* setting the `over` dot on **Wood** means "paint wood
    only where it is already wood" — a no-op. The panel warns you when the two
    line up like this.

## Show and hide classes

The eye icon on each row hides that class from the viewer. Hidden classes are
also skipped when repainting, so hiding a class you have finished with protects
it while you work on the rest.

## What happens to the labels

Hand labels are stored on the cloud as a `manual_class` attribute (the
ground/non-ground and ASPRS sets edit their own existing columns instead — see
the note above). Once committed they behave like any other scalar:

- colour the cloud by them (they appear in the colour-by list with your class
  names and colours),
- [filter](clean-point-cloud.md) to particular classes,
- split the cloud into one cloud per class,
- [export](import-export.md) them to LAS/LAZ.

## Work in a cross-section

A lasso is drawn on screen, so on its own it selects every point inside it at
**every depth** — including the far side of the canopy you cannot see. A
**cross-section** is the fix, and it is how professional LiDAR classification is
normally done.

1. Open **Tools › Pre-processing › Cross-section** and click **Draw section**.
2. Click two points in the view to set the line the section runs along. As you
   move toward the second point, the slab you are about to create is drawn so
   you can see the volume before committing to it.
3. Set **Thickness** thin enough that nothing hides behind anything.
4. Open **Label Points** — the section stays active, and the panel says so.
   Paint normally; strokes only affect points inside the section.
5. Step through the cloud with **◀ ▶**. The default half-thickness step makes
   consecutive sections overlap, so no point is skipped, and the
   *"Section 7 of 42"* readout tells you when you have covered everything.

The section is drawn as a thin, vertical-walled box: bounded by your two clicks
along the line, half the thickness either side of it, and spanning the full
height of the cloud.

### Getting back to the whole cloud

The section is a **view**, not a mode: it stays in effect while you use other
tools, and both panels are visible at once. That also means closing the panel
does *not* remove it — otherwise opening the Label tool, which shares the same
panel slot, would silently switch off the section you set up to paint inside.

While a section is active a small indicator sits at the top of the viewport with
two ways out, so you never have to remember which tool put it there:

- **Show full cloud** — stop clipping temporarily. The section, its thickness
  and its place in the traverse are all kept, so you can look around and drop
  straight back into it.
- **Clear** — remove the section and return to a normal view.

Both are also in the Cross-section panel, and the Label panel's
*"Strokes are limited to the cross-section"* notice carries its own **Clear**.
**Redraw section** shows the whole cloud while you pick the new line, so you are
never aiming at points the old section is hiding.

!!! note "Without a section, a lasso still cuts through"
    If no section is active, orbit to an angle where the points you want are not
    in front of anything else, or hide the classes you have already finished.

    A depth-limited brush is planned as a further option.
