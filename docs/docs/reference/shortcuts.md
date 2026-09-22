# Keyboard shortcuts

On macOS use <kbd>⌘</kbd> where the table says <kbd>Ctrl</kbd>.

## Global

| Shortcut | Action |
|---|---|
| <kbd>Ctrl</kbd>+<kbd>N</kbd> | New — clear everything and reset to a fresh start |
| <kbd>Ctrl</kbd>+<kbd>K</kbd> | Open the command palette |
| <kbd>Ctrl</kbd>+<kbd>,</kbd> | Open Settings |
| <kbd>Ctrl</kbd>+<kbd>Z</kbd> | Undo |
| <kbd>Ctrl</kbd>+<kbd>Y</kbd> or <kbd>Shift</kbd>+<kbd>Ctrl</kbd>+<kbd>Z</kbd> | Redo (the macOS menu advertises <kbd>Shift</kbd>+<kbd>⌘</kbd>+<kbd>Z</kbd>) |
| <kbd>Ctrl</kbd>+<kbd>S</kbd> | Export… |
| <kbd>Ctrl</kbd>+<kbd>A</kbd> | Select All |
| <kbd>Shift</kbd>+<kbd>Ctrl</kbd>+<kbd>A</kbd> | Deselect All |
| <kbd>Ctrl</kbd>+<kbd>0</kbd> | Reset camera (fit all) |
| <kbd>Ctrl</kbd>+<kbd>9</kbd> | Fit to selection |

The command palette is the fastest way to reach any feature by name —
start typing, use <kbd>↑</kbd>/<kbd>↓</kbd> to move through the results,
<kbd>Enter</kbd> to run, <kbd>Esc</kbd> to close.

## Viewer (mouse)

| Action | Mouse |
|---|---|
| Orbit camera | Left-click drag |
| Pan camera | Right-click drag, middle-click drag, or <kbd>Shift</kbd>/<kbd>Ctrl</kbd>/<kbd>⌘</kbd> + left-click drag |
| Zoom | Scroll wheel (flies toward the cursor) |
| Frame the selection | <kbd>F</kbd>, or the **Zoom to Selection** button |
| Select a mesh | Left-click the mesh (draws a highlight outline) |
| Add/remove a mesh from the selection | <kbd>⌘/Ctrl</kbd> + left-click the mesh |
| Clear the mesh selection | Left-click empty space |
| Select a scan | Left-click its scanner marker (same as clicking its row in the **Scans** panel) |
| Add/remove a scan from the selection | <kbd>⌘/Ctrl</kbd> + left-click its scanner marker |
| Label a point (while **Pick & Measure** is armed, in Inspect mode) | Left-click the point |
| Place a measurement vertex (while in a measurement mode) | Left-click the point |
| Finish a **Path** measurement | <kbd>Enter</kbd> |
| Remove the last measurement vertex | <kbd>Backspace</kbd> |
| Abandon the measurement in progress (leaves the tool armed) | <kbd>Esc</kbd> |
| Disarm **Pick & Measure** (with nothing in progress) | <kbd>Esc</kbd> |

A voxel **grid** box is deliberately "click-through": because it usually
encloses the very geometry it measures, clicking it selects whatever is
inside or behind it instead. The grid itself is selected by clicking a part
of the box with nothing behind it, or from its row in the **Meshes** panel.

## Tool modes

When an edit tool is active (Transform, Crop, Erase, Rotate):

| Shortcut | Action |
|---|---|
| <kbd>Enter</kbd> | Exit the tool |
| <kbd>Esc</kbd> | Exit the tool (and cancel a polygon in progress) |

Neither key *applies* anything — running an operation is always an explicit
click on the panel's run button, so you can't trigger one by accident while
typing a coordinate. In Crop, <kbd>Enter</kbd> inside a dimension/center input
just commits the typed value.

(Filter and Resample are panels rather than edit tools, so these keys don't
apply to them.)

## Label Points

| Shortcut | Action |
|---|---|
| <kbd>1</kbd>–<kbd>9</kbd> | Select the first nine classes as the paint class |
| Left-click | Place a lasso corner |
| <kbd>Enter</kbd> or double-click | Close the lasso and paint the enclosed points |
| Right-click | Remove the last lasso corner |
| <kbd>Esc</kbd> | Cancel the lasso in progress |
| <kbd>Ctrl</kbd>+<kbd>Z</kbd> | Undo the last stroke |

## Crop polygon

The view is locked for as long as a closed polygon is set, so the outline
stays over the points it selected. Redraw or <kbd>Esc</kbd> releases it.

| Shortcut | Action |
|---|---|
| Left-click | Add a polygon vertex |
| Right-click | Remove the last vertex |
| <kbd>Backspace</kbd> | Remove the last vertex |
| Double-click | Close the polygon |
| <kbd>Enter</kbd> | Close the polygon |
| <kbd>Esc</kbd> | Discard the vertices placed so far |
| <kbd>Esc</kbd> | Clear a closed polygon, leaving Polygon ready for another |
| <kbd>Esc</kbd> | Exit Crop (with nothing drawn) |

## Crop rect

The view is locked for as long as a rectangle is set, so the outline stays
over the points it selected. Redraw or <kbd>Esc</kbd> releases it.

| Shortcut | Action |
|---|---|
| Left-click-drag | Draw the rectangle (release to commit) |
| <kbd>Esc</kbd> | Clear the rectangle, leaving Rect ready for another |
| <kbd>Esc</kbd> | Exit Crop (with no rectangle set and no drag under way) |

## Crop box draw (while placing corners)

| Shortcut | Action |
|---|---|
| Left-click | Place a corner on the ground plane (two clicks) |
| <kbd>Esc</kbd> | Cancel the draw |

## Erase brush

| Shortcut | Action |
|---|---|
| <kbd>E</kbd> | Toggle erase mode on/off (while the Erase tool is open) |

Open the Erase tool with the toolbar button — the view stays interactive
so you can frame your shot. <kbd>E</kbd> (or the panel's **Start Erasing**
button) then toggles erase mode: ON freezes the viewport and **click** /
**click-drag** stamps square erase regions (each cuts straight through the
cloud); OFF unfreezes the view so you can reorient without closing the
tool. Apply with the panel's **Apply Erase** button or discard with
**Clear Strokes**. <kbd>E</kbd> only acts while the Erase tool is open.

## Pick & Measure

| Shortcut | Action |
|---|---|
| <kbd>Esc</kbd> | Abandon the measurement in progress; if none, disarm the tool (placed labels and measurements stay) |
| <kbd>Enter</kbd> | Finish a **Path** measurement |
| <kbd>Backspace</kbd> | Remove the last measurement vertex |

The view stays fully interactive while the tool is armed: a **click** labels
the point under the cursor or places a measurement vertex (depending on the
mode), and a **click-drag** orbits as usual. Clear what is placed from the
panel's **Clear all**, or dismiss one with its **✕**.
See **[Inspect a point](../workflows/viewer-navigation.md#inspect-a-point)**
and **[Measure distances and angles](../workflows/viewer-navigation.md#measure-distances-and-angles)**.

## Transform gestures (Blender-style)

These fire on the current selection with **no tool open** — just make sure
focus isn't in a text field. The one exception is <kbd>T</kbd> on a *point
cloud*, which is ignored unless the Transform tool is already open (the panel
is what commits the move):

| Shortcut | Action |
|---|---|
| <kbd>T</kbd> | Translate |
| <kbd>S</kbd> | Scale (meshes only) |
| <kbd>R</kbd> | Rotate (meshes and scan positions) |
| <kbd>X</kbd> / <kbd>Y</kbd> / <kbd>Z</kbd> | Lock to axis |
| <kbd>Shift</kbd> + <kbd>X</kbd> / <kbd>Y</kbd> / <kbd>Z</kbd> | Lock to the perpendicular plane |
| Press the same axis again | Return to free movement |
| Type a number | Exact amount (degrees for rotate) — e.g. <kbd>R</kbd> <kbd>X</kbd> `45`. Accepts `-` and `.` |
| <kbd>Backspace</kbd> | Delete the last typed digit |
| <kbd>Enter</kbd> / click | Set the value |
| <kbd>Esc</kbd> / right-click | Cancel this entry |

The <kbd>T</kbd> translate gesture works on point clouds, skeletons, scan
positions, and meshes. <kbd>S</kbd> scales selected meshes only.
<kbd>R</kbd> rotates selected meshes or a scan position. To **rotate a point
cloud**, use the Transform panel's Rotation fields or its rotation rings
(see below).

All three gestures apply to **every** selected mesh (or skeleton), not just
one — select several from the Meshes panel (<kbd>Ctrl</kbd>/<kbd>Cmd</kbd>-click,
or **Select All**) and they move, turn, and scale together. Each object is
transformed by the same amount relative to its own starting position, so their
relative sizes and spacing are preserved. Undo covers the first object in the
selection.

The selection **survives** the gesture, including when you finish it by
clicking rather than pressing <kbd>Enter</kbd>. So you can translate, then
rotate, then scale the same group straight through, without re-picking the
objects in between. Click empty space when you are done to deselect.

For a **point cloud**, this gesture only sets the pending position in the
Transform panel — it does not apply the move. Click **OK** in the panel to
apply it (or **Cancel** to discard). See
[Clean a point cloud → Transform](../workflows/clean-point-cloud.md#transform-translate-and-rotate).

### Scan positions

Select a scanner — click its marker in the viewport, or its row in the
**Scans** panel — and the gesture moves the *instrument*, not the points.
Each key writes the field the **Scan Parameters** dialog shows, so the
result is the same as typing there:

| Gesture | Scan Parameters field |
|---|---|
| <kbd>T</kbd> <kbd>X</kbd> / <kbd>Y</kbd> / <kbd>Z</kbd> | Origin X / Y / Z |
| <kbd>R</kbd> <kbd>X</kbd> | Scanner tilt → Roll |
| <kbd>R</kbd> <kbd>Y</kbd> | Scanner tilt → Pitch |

So <kbd>T</kbd> <kbd>X</kbd> `5` moves the scanner 5 m along +X, and
<kbd>R</kbd> <kbd>Y</kbd> `10` leans it 10° in pitch. <kbd>S</kbd> does
nothing — a scanner has no size — and rotation is limited to tilt, so
<kbd>R</kbd> <kbd>Z</kbd> has no effect; set the scanner's heading in the
dialog's **Scanner heading** field.

Two cases where the gesture deliberately stands aside:

- **While the Transform tool is open on a point cloud**, <kbd>T</kbd> keeps its
  usual meaning of moving the selected cloud's points. Close the tool to
  move the scanner instead.
- **Moving-platform scans** (those carrying a trajectory) take their
  position and attitude from their per-pose path, which is why the dialog
  shows their origin read-only and hides the tilt fields. Edit individual
  poses in the trajectory editor, where <kbd>T</kbd> and <kbd>R</kbd> act on
  the selected pose.

The move applies as soon as you confirm it — there is no separate panel
**OK** step the way there is for a point cloud. <kbd>Esc</kbd> cancels and
puts the scanner back. Note that a scan transform is **not** covered by
Undo.

## Selection (Scene panel)

| Shortcut | Action |
|---|---|
| <kbd>Shift</kbd> + click | Range select |
| <kbd>Ctrl</kbd> + click | Add to / remove from selection |
