# Viewer navigation

## Camera

| Action | Mouse | Trackpad |
|---|---|---|
| Orbit | Left-click drag | One-finger drag |
| Pan | Right-click drag, or ⌘/Ctrl + left drag | Two-finger drag |
| Zoom | Scroll wheel | Pinch |
| Frame an object | Double-click it | Same |
| Reset to origin | Click **Reset View** in toolbar | Same |

The camera orbits around a **focus point**. Double-clicking sets the
focus point to whatever you double-clicked, which is the fastest way
to start examining a region of a large scan.

## Snap to a canonical view

The compass cluster in the top-right snaps the camera to standard
orthographic and isometric views:

- **Front**, **Back**, **Left**, **Right** — looking along the X or Y axis
- **Top**, **Bottom** — looking along Z
- **Isometric** — 30° elevation, 45° azimuth

After snapping you can still orbit; the snap doesn't lock the camera.

## Show or hide the grid and axes

In the right-side properties panel, toggle:

- **Grid** — a 1m × 1m grid on the world XY plane. Helpful for sanity-
  checking units and scale.
- **Axes** — a small XYZ gizmo at the world origin (red = X, green = Y,
  blue = Z).

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
