# Keyboard shortcuts

On macOS use <kbd>⌘</kbd> where the table says <kbd>Ctrl</kbd>.

## Global

| Shortcut | Action |
|---|---|
| <kbd>Ctrl</kbd>+<kbd>N</kbd> | New — clear everything and reset to a fresh start |
| <kbd>Ctrl</kbd>+<kbd>K</kbd> | Open the command palette |
| <kbd>Ctrl</kbd>+<kbd>,</kbd> | Open Settings |
| <kbd>Ctrl</kbd>+<kbd>Z</kbd> | Undo |
| <kbd>Ctrl</kbd>+<kbd>Y</kbd> | Redo |

The command palette is the fastest way to reach any feature by name —
start typing, press <kbd>Enter</kbd> to run, <kbd>Esc</kbd> to close.

## Viewer (mouse)

| Action | Mouse |
|---|---|
| Orbit camera | Left-click drag |
| Pan camera | Right-click drag, or <kbd>Ctrl</kbd> + left-click drag |
| Zoom | Scroll wheel |
| Frame an object | Double-click an object |
| Select a mesh | Left-click the mesh (draws a highlight outline) |
| Add/remove a mesh from the selection | <kbd>⌘/Ctrl</kbd> + left-click the mesh |
| Clear the mesh selection | Left-click empty space |

## Tool modes

When a tool mode is active (Filter, Translate, Erase…):

| Shortcut | Action |
|---|---|
| <kbd>Enter</kbd> | Apply / confirm the current tool |
| <kbd>Esc</kbd> | Cancel the current tool |

The Crop tool is the exception — Enter inside its dimension/center
inputs only commits the typed value. Click the panel's **Apply** button
to actually run the crop, so you can't trigger one by accident while
typing a coordinate.

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

## Transform mode (Blender-style)

When the Translate tool is active:

| Shortcut | Action |
|---|---|
| <kbd>T</kbd> | Translate |
| <kbd>S</kbd> | Scale (meshes only) |
| <kbd>R</kbd> | Rotate (meshes only) |
| <kbd>X</kbd> / <kbd>Y</kbd> / <kbd>Z</kbd> | Lock to axis |
| <kbd>Shift</kbd> + <kbd>X</kbd> / <kbd>Y</kbd> / <kbd>Z</kbd> | Lock to the perpendicular plane |
| Type a number | Exact amount (degrees for rotate) — e.g. <kbd>R</kbd> <kbd>X</kbd> `45` |
| <kbd>Enter</kbd> / click | Commit |
| <kbd>Esc</kbd> / right-click | Cancel |

Translate works on point clouds, skeletons, and meshes; scale and rotate
apply to the selected mesh.

## Selection (Scene panel)

| Shortcut | Action |
|---|---|
| <kbd>Shift</kbd> + click | Range select |
| <kbd>Ctrl</kbd> + click | Add to / remove from selection |
