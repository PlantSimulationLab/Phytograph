# Morph a plant

Edit a generated plant's growth parameters and watch the geometry update.
Use morphing to fit a model to a specific cultivar, run sensitivity
studies, or build a library of parameter presets.

## Prerequisite

You need a generated plant already in the scene. See
[Generate a plant](generate-plant.md).

## Open the morph panel

1. Select the plant's mesh in the Scene panel.
2. Open the command palette (<kbd>Cmd</kbd>/<kbd>Ctrl</kbd>+<kbd>K</kbd>) and
   run **Morph Plant**. The Morph popup opens.

## What you can change

The popup header reads `Morph: {Species} ({age}d)`. Parameters are scoped
**per shoot type**, so the popup has a tab row across the top — edits apply to
the selected shoot type only.

### Geometry parameters

Five editable parameters drive growth (the same five for every species):

- **Internode Length** — segment length between leaves
- **Insertion Angle** — angle at which a side branch leaves its parent
- **Girth Factor** — taper rate from trunk to twig
- **Curvature** — gravitropic curvature of the shoot
- **Tortuosity** — how much the shoot wanders as it grows

Each row shows the parameter's **distribution** as a read-only pill
(`constant`, `uniform`, `normal`, …). This is informational — you can't switch
a parameter to a different distribution. What you can edit depends on it:

- **constant** — a slider plus a value box.
- **uniform** / **normal** — two number boxes joined by a `-`, for the
  distribution's own bounds.

Anything the backend exposes outside these five is shown read-only under
**Growth & Structural (read-only)**.

### Geometry Scale

Multiplicative scales applied after generation:

- **Leaf scale** — multiplier on leaf size
- **Petiole Length** / **Petiole Radius** — petiole dimensions
- **Internode radius** — branch thickness

Useful when the structure is right but the absolute dimensions need
tuning to match a specific cultivar.

### Read-only parameters

Some parameters (growth rates, bud break thresholds, dormancy timing)
are exposed for reference but not editable — they're tied to the
species' phenology model. To change them you'd need to extend the
underlying Helios model.

## Apply changes

After editing, click **Regrow**. Phytograph rebuilds the plant at its
current age using the new parameters. The mesh updates in place.

If you don't like the result, **Reset** restores the species defaults.

!!! warning "Morphing is not undoable"
    Regrowing replaces the mesh geometry and recreates the backend plant
    session, so it **clears the undo history** for that plant.
    <kbd>⌘/Ctrl</kbd>+<kbd>Z</kbd> will not bring back the previous parameter
    set — export your parameters first if you want to return to them.

Modified parameters are marked with an amber accent and an `x` scale factor
relative to the default (e.g. `1.25x`), so you can see at a glance what you've
changed.

## Save and reuse presets

- **Export parameters** (download icon) — save the current parameter set to a
  file.
- **Import parameters** (upload icon) — load a previously saved set.

Both are icon-only buttons in the popup header; hover to see the tooltip.

This is the easiest way to build up a per-cultivar library. Name files
descriptively (e.g., `apple_fuji_high-density.json`) and check them
into version control alongside your analysis code.

## Workflow: fit to a scan

A common loop when you have a real plant scan and want a matching
procedural model:

1. **Generate** at the right species and age.
2. **Align** the generated mesh to the scan via
   [Register & compare](register-compare.md#cloud-to-mesh-distance).
3. **Morph** to reduce the RMSE — try girth and insertion angle first;
   these have the biggest visual effect.
4. Repeat alignment + morph until the fit is satisfactory.
5. **Export parameters** to lock in the cultivar parameters.

For a rigorous fit, scriptable parameter sweeps via the backend API
will be more efficient than manual iteration. See the
[developer docs](../developers/api/endpoints.md).
