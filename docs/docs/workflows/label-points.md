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
   number keys `1`–`9` and `0` pick the first ten classes, in the order the
   panel numbers them.
4. Choose how you want to select points — **Lasso** or **Brush** (see
   [Lasso, rectangle or brush?](#lasso-rectangle-or-brush) below).
5. Paint. With the lasso, click to place each corner of an outline, then press
   `Enter` (or double-click) to close it. With the brush, just drag. Points
   selected take the active class and recolor straight away.
6. Repeat with different classes as needed. **Undo** (or `Cmd+Z`) removes
   the last stroke, and `Shift+Cmd+Z` puts it back.
7. Close the panel when you are done.

The labels are on the point cloud from the moment you paint them: export and
every other tool read them straight away. What catches up in the background is
the cloud's display index, which is rebuilt when you close the panel, and also
after two minutes without a stroke. There is nothing to press and nothing to
wait for; the labels stay on screen throughout.

**Undo** in the panel is the app's own Undo, so the two always agree. It is
available when the most recent edit is a stroke on the column in front of you;
if you cropped or moved something since, `Cmd+Z` undoes that first. Undo stops
where the display was last rebuilt: it steps back through the strokes painted
since, but not into the ones before it.

Each class row shows how many points currently carry it, so you can see the
counts move as you work.

!!! tip "Press `L` to look around"
    While the lasso is armed every viewport click places a corner, so you can't
    orbit. Press `L` — or click **Drawing — view frozen** — to disarm it, move
    the camera freely, then press `L` again to carry on. The panel stays open
    and your class selection is kept.

    The brush leaves orbiting alone — only dragging paints. Because the wheel
    sizes the brush while it is active, zoom moves to **Alt+scroll**.

The panel states what the next stroke will do in words, e.g.
*"Painting **Leaf** over **any visible class**"*. Read that line if a stroke
does not do what you expect.

!!! warning "Export to keep your labels"
    Phytograph has no project file: labels live on the point cloud while the app
    is open, and are lost when it closes unless you
    [export](import-export.md) the cloud. Until you do, the panel says *Labels
    changed since this cloud was last exported*, and closing the app or
    **File › New** names how many clouds have labels that would be lost. An
    export clears it for the label columns it wrote.

## Lasso, rectangle or brush?

All three are always available (`G`, `R` and `B` switch between them); they
answer different questions.

| | Lasso | Rectangle | Brush |
|---|---|---|---|
| How you paint | Click each corner, `Enter` to close | Drag a box | Drag |
| Best for | A precise outline around an irregular region | Sweeping a block quickly | Fast touch-up and correction |
| Depth | Selects at **every depth** inside the outline | Every depth, like the lasso | Stops at the surface you are pointing at |

`X` swaps the paint class with the class it paints **over** (when exactly one
`over` dot is set): after painting **Wood** over **Leaf**, one key sets up
painting **Leaf** over **Wood**. **Keyboard shortcuts**, at the bottom of the panel, lists them all.

The brush is a sphere that sits on the geometry under your cursor, so it does
not paint the trunk behind the leaf you aimed at. Set its size with the scroll
wheel or the `[` and `]` keys; the panel shows the current size in pixels. The
size is in screen pixels, so the circle stays the same on screen as you zoom,
and the sphere it corresponds to grows or shrinks in the cloud to match.

If the cursor is not over any geometry the brush shows nothing and paints
nothing, rather than guessing a depth and labeling points you cannot see.

### Pick a whole piece with one click

The **Pick** tool (`K`) labels a whole piece of the cloud per click — a leaf, a
stretch of branch, or a whole plant — instead of tracing it:

- **Pieces** cuts the cloud into compact pieces about **Size** across. A piece
  never jumps a gap, so a leaf stays separate from the leaf behind it.
- **Connected** takes everything joined up, bridging gaps up to **Gap**: a
  plant standing apart from its neighbors, or a fruit hanging clear.

Leave the size at `0` and the first click chooses one from the point spacing
and fills it in; change it to pick smaller or larger pieces. **Shift+click**
also takes the neighboring pieces facing the same way — a flat leaf blade, or
the ground around a stem — and stops at a fold. A drag still turns the view, so
you can look around between clicks.

The first click on a cloud takes a moment while it is cut into pieces; later
clicks at the same size are immediate. Each click is one stroke, undone and
redone like any other.

### How deep a stroke reaches

The panel's **Depth** row decides how far behind the outline a stroke paints:

- **Through** (the default) — the lasso and rectangle select every point inside
  the outline at every depth, as if the outline were pushed through the cloud.
- **Front** — the lasso and rectangle select only the surface you can see
  inside the outline, so outlining a leaf no longer paints the branch behind
  it. The surface is taken from the points drawn on screen when you close the
  outline. **Also keep** adds a little depth behind that surface, in cloud
  units, for a surface that is rough or thick; `0` allows only for the
  surface's own slope.
- **Box** — every stroke, including the brush and the line, selects only
  inside a limiting box. Click **Draw box**, then click two opposite corners in
  the view; the box spans the cloud's full height, and the **Z** fields trim
  it. Until a box is drawn, strokes are refused rather than painting
  everywhere.

The lasso remains the better tool for covering a large region in one go — and,
paired with a [cross-section](#work-in-a-cross-section), for classifying a cloud
systematically. Inside a section there is a fourth tool, the
[line](#paint-above-or-below-a-line) (`P`).

## Choose what you are labeling

The **Column** dropdown at the top of the panel picks which classification your
strokes write to. Every classification the cloud carries is listed, so a
classification that came out wrong can be fixed by hand rather than only
recomputed.

- **Labeling** — the hand-labeling column, where your own classes live. It is
  offered even on a cloud that has none yet; it is created the first time you
  paint.
- **Classifications** — the class columns the cloud already has: a
  `tree_instance` from [Separate trees](segment-trees.md), a `ground_class` from
  [Segment ground points](segment-ground.md), a classification byte carried in
  from a LAS file, or any column you marked **Label** in the import wizard.
- **Other columns** — continuous measurements. These are offered because
  Phytograph cannot always tell a class column from a measurement, but painting
  one **replaces the measured values**, so the panel warns before you do.
- **+ New classification…** — start your own column; see
  [Create a new classification](#create-a-new-classification).

When you open the tool on a cloud that carries exactly one classification, it
opens on that column with its real classes and counts already listed.

!!! example "Fixing a tree segmentation by hand"
    [Separate trees](segment-trees.md) sometimes merges two trees into one, or
    splits one across two ids. Select the cloud, open **Label Points**, and it
    opens on **Tree instance** showing the trees the segmentation actually
    found. Pick the tree you want a region to belong to, lasso the points that
    were assigned wrongly, and close the panel. To split a merged tree, use **Edit →
    Add class** first: on a classification the cloud already carries, a new
    class continues that column's own numbering (Tree 3 after Tree 2) rather
    than starting a separate custom range.

!!! warning "Re-running a tool replaces its column"
    Running a segmentation again (or recomputing a scalar field) rewrites its
    whole column, so your hand corrections on it are replaced by the new
    result, and **Undo** can no longer step back into them.
    [Export](import-export.md) first if you want to keep the corrected version.

!!! note "Class 0 is always available"
    Every column offers **Unclassified** (class 0), even when the data has no
    zeros in it — a tree segmentation numbers its trees from 1. It is how you
    take a classification *away* from points that should not have had one, and
    it reads 0 points until you use it.

!!! note "Strokes stay with their column and cloud"
    Strokes belong to the column and the cloud you painted them on. Switching column, or selecting another cloud, starts that
    one clean; switching back finds your strokes still pending, and **Undo**
    only ever undoes strokes on the column and cloud in front of you.

## Class sets

A class set is a vocabulary for the column you are painting. **Preset** in the
panel switches between the built-in sets that describe **that column** — it
never moves you to a different one. A column with no built-in vocabulary (a tree
segmentation's instance ids, or a classification of your own) has no presets,
and the button is grayed out; its classes come from the data itself.

The built-in sets are:

- **Wood / leaf** (the default) — matches what
  [Separate leaf and wood](segment-wood.md) writes, so you can correct its
  output in the same vocabulary.
- **Plant organs** — leaf, petiole, shoot, peduncle, fruit, petiolule. These are
  the same organ codes a [simulated scan](simulate-scan.md) carries, so
  hand-labeled and simulated data can be compared directly.
- **Ground / non-ground** — matches [Segment ground points](segment-ground.md).
- **ASPRS standard** — the LAS classification codes (Ground, Low/Medium/High
  Vegetation, Building, Water…), for data that has to line up with other LiDAR
  software.

Every set includes **Unclassified** (class 0), which is what points start as.

Each set belongs to a column: ground / non-ground describes what the
ground-segmentation tool writes, ASPRS describes an imported LAS classification
byte, and wood/leaf and organs describe the hand-labeling column. Pick the
column first, in the **Column** dropdown, and the presets that apply to it
follow.

### Define your own classes

The presets are starting points, not the vocabulary. **Edit** in the panel opens
the class editor, where you can add classes, rename and recolor them, and save
the result as a palette of your own.

- **Add class** appends a new class in the 64–255 band, which LAS reserves for
  user-defined codes — so your classes never collide with the ASPRS standard
  ones, and they fit the LAS classification byte they are exported into. On a
  classification the cloud already
  carries, a new class instead continues **that column's** numbering — Tree 3
  after Tree 2 — because those ids are data the segmentation wrote, not a
  vocabulary you chose. Each new class starts with a color that is distinct
  from every class already in the palette (never Unclassified's gray); click
  its swatch to change it.
- Class values run from 0 to 255, the range of the LAS classification byte.
  **Instance** columns, which number objects rather than classes (a
  `tree_instance` from [Separate trees](segment-trees.md), or any column whose
  name ends in `_instance`), take ids up to 16,777,216, so a plot with hundreds
  of trees can still be split and renumbered by hand.
- **Save palette** applies it, binds it to the cloud (so it is still there when
  you reopen the tool), and adds it to your saved palettes. Saving an edited
  built-in set, or a column's own classes, stores a copy of your own, so it
  never replaces a palette you saved for another project. A copy of a column's
  classes is named after its cloud and column.
- **Export / Import** move palettes between projects or collaborators as a JSON
  file, so a labeling scheme agreed once can be reused by everyone.

Two rules the editor enforces, both to protect points you have already painted:

- **Unclassified (class 0) cannot be removed or renumbered.** Points from an
  unlabeled or merged cloud arrive as 0, so 0 has to mean "unclassified"
  everywhere. You can rename it — a tree segmentation's class 0 reads
  "Unassigned" — because only the *number* is the contract.
- **A class that already has points keeps its value.** The class *number* is
  what gets stored in the file, so repointing a class that is in use would leave
  those points holding a number the palette no longer describes. Renaming and
  recoloring stay available — only the number is fixed.

#### Create a new classification

**+ New classification…** in the Column dropdown makes a column of your own,
alongside the ones the cloud already has, rather than mixing your classes into
the hand-labeling column. Give it a name — "Row QC" — and the editor shows the
name it will carry in the data (`row_qc`) beneath it.

A name is refused if it collides with a standard LAS dimension name or with a
column this cloud already has; **Create classification** stays disabled until it
is usable, so a name that could not be written is caught before you paint rather
than after.

Once you paint it, it is a real column like any other: it appears in
**Color by**, in the scalar filter, in split-by-class, and in an
[export](import-export.md).

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

## Show, hide and lock classes

The eye icon on each row hides that class's points from the viewer. Hidden
classes are also never repainted: a stroke skips them whatever the `over`
column says, so hiding a class you have finished with protects it while you
work on the rest, and "any visible class" means exactly that.

**Alt-click** a class row to show *only* that class, which is the quickest way
to check what a class really contains. Alt-click the same row again to show
every class.

The padlock on each row **locks** a class: no stroke changes its points, and
unlike hiding it stays on screen. **Protect labeled points**, under the class
list, locks every class except Unclassified, so strokes only ever label points
that have no label yet, which makes it safe to sweep a big lasso over a
half-finished cloud. Click it again to unlock everything.

## Find what is still unlabeled

**Find unlabeled points** (or `N`) shows only the Unclassified points and moves
the camera to where most of them are. Press `N` again for the next such area,
largest first, and `Shift+N` to go back; the panel says which area you are on
and how many unlabeled points are left. Each step re-reads the cloud, so areas
you label drop out as you go, and when nothing is left the panel says so.
Alt-click a class row to see the labeled points again.

## Instances: this tree, that leaf

A column whose name ends in `_instance` (`tree_instance` from a tree
segmentation, or one you create such as `leaf_instance`) numbers **objects**
rather than naming classes. Its class list is the list of instances, with
their point counts, and show, hide, isolate and lock work as for any class. An
**Instances** box in the panel adds what numbering objects needs, acting on
the instance selected in the list:

- **New instance** adds the next free id after the highest in use, named like
  its siblings (*Tree 18* after *Tree 17*), and makes it the paint class. Paint
  with it to split a wrongly merged instance — with the old instance as the
  only *over* class, so nothing else is touched.
- **Frame** moves the view to the instance.
- **Merge into…** gives every point of this instance another instance's id.
- **Delete** returns every point of this instance to *Unassigned*.
- **Also set** paints a class in another column with every stroke — say
  *Hand labels: Wood* while you paint *Tree 3* — so an instance and what it is
  are labeled together. Both columns change in one step, and one undo takes
  both back.

Merge and delete are strokes like any other: undo reverses them, and the id
stays in the list (with no points) so an undo has somewhere to put them back.

## Pre-label from another column

Rather than start a column from nothing, seed it from a result another tool
already wrote — ground segmentation's `ground_class`, wood/leaf segmentation's
`wood_class`, a tree segmentation's `tree_instance`, or any other class column
on the cloud. Choose it under **Pre-label from another column…**, check how
its classes map onto yours (classes with the same name are matched for you; the
rest you pick, or leave as they are), and click **Pre-label**. **Only points
still Unclassified** keeps what you have already painted. Instance ids copied
into another instance column are kept as they are.

It is one stroke: the result shows at once, undo takes it back, and you then
correct it by hand like any painting.

## Save and load strokes

**Save strokes…** writes every stroke the column has had since the cloud was
loaded to a small `.json` file. **Load strokes…** replays such a file onto the
column being edited, as one undoable step. The strokes are stored in the
cloud's own coordinates, so they land in the same place on a re-import of the
same scan — to carry work across a re-import, or to share it with a colleague
who has the same file. Classes are stored by number: load onto a column whose
class set uses the same numbers, and the panel says if the file uses classes
the set does not have.

## What happens to the labels

Labels are stored in whichever column you picked: the hand-labeling column
(`manual_class`) by default, the cloud's own classification when you chose one,
or a column you created. Either way they behave like any other scalar:

- color the cloud by them (they appear in the color-by list with your class
  names and colors),
- [filter](clean-point-cloud.md) to particular classes,
- split the cloud into one cloud per class,
- [export](import-export.md) them to LAS/LAZ, where they are written both as
  their own named column and into the standard LAS classification byte (classes
  0–255), so other LiDAR software sees them too. The file also carries the
  class **names and colors**: other programs read the names of the
  classification byte's classes, and a re-import into Phytograph brings back
  every labeled column's class set.

### LAS flags

LAS files mark points **withheld**, **synthetic** or as **key-points** with
flags in each point rather than with classes. The column list offers one
column for each (*LAS flag: Withheld*, and so on): paint *Withheld* onto the
points to flag, exactly as you would a class, and the LAS export sets the
flag. Re-importing the file brings the flag back as the same column.

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
5. Step through the cloud with **◀ ▶**, or from the keyboard with
   <kbd>,</kbd> / <kbd>←</kbd> (back) and <kbd>.</kbd> / <kbd>→</kbd>
   (forward) — the keys work with the Label panel open, so you can page and
   paint without reaching for the section panel. They step by the panel's
   **Step size**. The default half-thickness step makes
   consecutive sections overlap, so no point is skipped, and the
   *"Section 7 of 42"* readout tells you when you have covered everything.

The section is drawn as a thin, vertical-walled box: bounded by your two clicks
along the line, half the thickness either side of it, and spanning the full
height of the cloud.

A small **map** in the lower-left corner of the viewport shows the cloud from
above with the section as a blue band, so you can tell where you are while every
face-on slice looks alike. The band moves as you step.

### Paint above or below a line

With a section drawn, the Label panel's **Line** tool (`P`) cuts the section in
one stroke — a stem from its crown, or a trunk from the ground. Click along the
section to draw a line through the points, then `Enter` or double-click to
finish. Every point in the section on the chosen side is painted:

- **Above** or **Below** the line. Set **Within ±** to paint only a band that
  close to the line — the 20 cm of ground under a profile, say. `0` means the
  whole side.
- **Near** — within **±** of the line on either side. Left at `0`, the band is
  the section's own thickness.

Past either end the line keeps the height of its last point, so a line that
stops short of the section's edge still covers it. The line is drawn in the
section, so it needs a view facing the section; a view looking along the
section cannot place it. Like every stroke drawn in a section, it paints nothing
outside the slab.

### Getting back to the whole cloud

The section is a **view**, not a mode: it stays in effect while you use other
tools, and both panels are visible at once. That also means closing the panel
does *not* remove it — otherwise opening the Label tool, which shares the same
panel slot, would silently switch off the section you set up to paint inside.

While a section is active a small indicator sits at the top of the viewport with
two ways out, so you never have to remember which tool put it there:

- **Show full cloud** — stop clipping temporarily. The section keeps its
  colors and every point outside it is drawn **gray**, so you see the whole
  cloud and still see where the section sits. Its thickness and its place in
  the traverse are all kept, so you can look around and drop straight back
  into it.
- **Clear** — remove the section and return to a normal view.

Both are also in the Cross-section panel, and the Label panel's
*"Strokes are limited to the cross-section"* notice carries its own **Clear**.
**Redraw section** shows the whole cloud while you pick the new line, so you are
never aiming at points the old section is hiding.

!!! note "Without a section, a lasso still cuts through"
    If no section is active, switch to the **Brush**, which is depth-limited and
    needs no section. Otherwise orbit to an angle where the points you want are
    not in front of anything else, or hide the classes you have already
    finished.
