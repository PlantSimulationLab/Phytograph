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
| <kbd>Ctrl</kbd>+<kbd>S</kbd> | Save |
| <kbd>Shift</kbd>+<kbd>Ctrl</kbd>+<kbd>E</kbd> | Export… |
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
| Label a point (while **Pick Point** is armed) | Left-click the point |

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

## Crop polygon (while drawing)

| Shortcut | Action |
|---|---|
| Left-click | Add a polygon vertex |
| Right-click | Remove the last vertex |
| <kbd>Backspace</kbd> | Remove the last vertex |
| <kbd>Enter</kbd> | Close the polygon |
| <kbd>Esc</kbd> | Cancel the polygon |

## Crop rect (while drawing)

| Shortcut | Action |
|---|---|
| Left-click-drag | Draw the rectangle (release to commit) |
| <kbd>Esc</kbd> | Cancel the rectangle |

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

## Point picker

| Shortcut | Action |
|---|---|
| <kbd>Esc</kbd> | Disarm the picker (placed labels stay) |

The view stays fully interactive while the picker is armed: a **click**
labels the point under the cursor, a **click-drag** orbits as usual. Clear
the labels from the panel's **Clear all**, or dismiss one with its **✕**.
See **[Inspect a point](../workflows/viewer-navigation.md#inspect-a-point)**.

## Transform gestures (Blender-style)

These fire on the current selection with **no tool open** — just make sure
focus isn't in a text field. The one exception is <kbd>T</kbd> on a *point
cloud*, which is ignored unless the Transform tool is already open (the panel
is what commits the move):

| Shortcut | Action |
|---|---|
| <kbd>T</kbd> | Translate |
| <kbd>S</kbd> | Scale (meshes only) |
| <kbd>R</kbd> | Rotate (meshes only) |
| <kbd>X</kbd> / <kbd>Y</kbd> / <kbd>Z</kbd> | Lock to axis |
| <kbd>Shift</kbd> + <kbd>X</kbd> / <kbd>Y</kbd> / <kbd>Z</kbd> | Lock to the perpendicular plane |
| Press the same axis again | Return to free movement |
| Type a number | Exact amount (degrees for rotate) — e.g. <kbd>R</kbd> <kbd>X</kbd> `45`. Accepts `-` and `.` |
| <kbd>Backspace</kbd> | Delete the last typed digit |
| <kbd>Enter</kbd> / click | Set the value |
| <kbd>Esc</kbd> / right-click | Cancel this entry |

The <kbd>T</kbd> translate gesture works on point clouds, skeletons, and
meshes; the <kbd>S</kbd>/<kbd>R</kbd> scale and rotate gestures apply to
the selected mesh. To **rotate a point cloud**, use the Transform panel's
Rotation fields or its rotation rings (see below).

For a **point cloud**, this gesture only sets the pending position in the
Transform panel — it does not apply the move. Click **OK** in the panel to
apply it (or **Cancel** to discard). See
[Clean a point cloud → Transform](../workflows/clean-point-cloud.md#transform-translate-and-rotate).

## Selection (Scene panel)

| Shortcut | Action |
|---|---|
| <kbd>Shift</kbd> + click | Range select |
| <kbd>Ctrl</kbd> + click | Add to / remove from selection |
