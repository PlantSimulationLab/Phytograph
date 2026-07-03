# Viewer navigation

## Camera

| Action | Mouse | Trackpad |
|---|---|---|
| Orbit | Left-click drag | One-finger drag |
| Pan | Right-click drag, or ⌘/Ctrl + left drag | Two-finger drag |
| Zoom | Scroll wheel | Pinch |
| Set focus point | Double-click an object | Same |
| Zoom to selection | <kbd>F</kbd> (or the **Zoom to Selection** button) | Same |
| Fit everything | <kbd>⌘/Ctrl</kbd>+<kbd>0</kbd>, or **Reset View** | Same |

The camera orbits around a **focus point**. Double-clicking sets the
focus point to whatever you double-clicked, which is the fastest way
to start examining a region of a large scan.

### Zoom to Selection vs. Reset Camera

Two camera commands reframe the view, and they differ in *what* they
fit and whether they change your viewing angle:

- **Zoom to Selection** fits the **currently selected** cloud(s), mesh,
  skeleton, QSM, or scan to the viewport while **keeping your current orbit
  angle** — it only re-centers and re-zooms, so the scene doesn't rotate.
  This works for a scan even before it has data: a selected scanner marker
  or moving-platform trajectory is framed by its position (the whole
  trajectory path, for a moving scan).
  This is the fast way to focus on one object in a crowded scene.
  Available three ways: press <kbd>F</kbd>, click **Zoom to Selection**
  in the **Snap View** panel (top-left), or **View → Fit to Selection**
  (<kbd>⌘/Ctrl</kbd>+<kbd>9</kbd>) in the menu bar. The button is disabled
  when nothing is selected; the menu command falls back to fitting
  everything in that case.
- **Reset Camera (Fit All)** fits **all** content from the default
  **isometric** angle — it both reframes the whole scene and resets the
  orbit orientation, so use it to get un-lost. Available as the **Reset
  View** (home) button top-left, or **View → Reset Camera (Fit All)**
  (<kbd>⌘/Ctrl</kbd>+<kbd>0</kbd>).

## Snap to a canonical view

The **Snap View** panel in the top-left rotates the camera to standard
orthographic and isometric views:

- **Front**, **Back**, **Left**, **Right** — looking along the X or Y axis
- **Top**, **Bottom** — looking along Z
- **Isometric** — the default 3/4 angle

These buttons **only reorient** — they rotate the camera to look down the
requested axis while keeping your current orbit target and zoom level, so
the scene doesn't jump closer or farther. To reframe, use **Reset View**
(fit everything) or **Zoom to Selection**. After snapping you can still
orbit; the snap doesn't lock the camera.

The **orientation gizmo** in the bottom-left corner (the red/green/blue
X-Y-Z widget) does the same thing: click an axis head to look straight
down that world axis, preserving your current target and zoom.

## Show or hide the grid and axes

In the right-side properties panel, toggle:

- **Grid** — a 1m × 1m grid on the world XY plane. Helpful for sanity-
  checking units and scale.
- **Axes** — the bottom-left orientation gizmo. On by default; turn it off
  to clear the corner.

The **orientation gizmo** in the bottom-left corner (red = X, green = Y,
blue = Z) always tracks the current camera orientation; click its axis
heads to snap the view as described above.

## Isolate one object

Hide everything except one cloud or mesh by clicking its eye icon to
make it visible and clicking everything else's eye icon to hide them.
Or:

1. Right-click the entry you want to focus on.
2. Choose **Solo** (hides all others).
3. **Unsolo** restores the previous visibility state.

## Change color modes

Right-click any cloud entry, or use its inline **Color By** dropdown:

- **Height** (Z) — default; good for scans with vertical structure
- **X / Y** — useful for horizontal stripes
- **Intensity** — for LiDAR scans that carry intensity
- **RGB** — original per-point color from the file
- **Single Color** — flat color (the cloud's identifier color)
- **Scalar Field** — any custom scalar present in the file

See **[Color modes](../reference/color-modes.md)** for when each is most
useful.

## Adjust point size and colormap

The right panel has:

- **Point size slider** — small for large clouds, larger for sparse
  ones.
- **Colormap selector** — viridis (default), plasma, magma, inferno,
  turbo, grayscale. Applies when coloring by any scalar (height,
  intensity, scalar field).

## Command palette

Press <kbd>⌘</kbd>+<kbd>K</kbd> (macOS) or <kbd>Ctrl</kbd>+<kbd>K</kbd>
(Windows) to search across every feature by name. Faster than hunting
through toolbar buttons.
