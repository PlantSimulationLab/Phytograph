# Morph a plant

Edit a generated plant's growth parameters and watch the geometry update.
Use morphing to fit a model to a specific cultivar, run sensitivity
studies, or build a library of parameter presets.

## Prerequisite

You need a generated plant already in the scene. See
[Generate a plant](generate-plant.md).

## Open the morph panel

1. Select the plant's mesh in the Scene panel.
2. Click **Morph** (DNA icon) in the toolbar. The Morph popup opens.

## What you can change

The popup is organized into sections. The exact parameters vary by
species, but generally:

### Geometry parameters

Per-organ scalar values that drive growth:

- **Internode length** — segment length between leaves
- **Insertion angle** — angle at which a side branch leaves its parent
- **Girth factor** — taper rate from trunk to twig
- … and species-specific parameters (leaf width, fruit position, …)

Each parameter shows:

- A slider for the current value
- The parameter's distribution type — **Constant**, **Uniform**, or
  **Normal**
- The distribution's own parameters (min/max for Uniform; mean/stddev
  for Normal)

Switching distribution type changes what the parameter draws from
during regrowth. Use **Normal** to introduce realistic variability;
use **Constant** to lock a parameter exactly.

### Geometry scale

Multiplicative scales applied after generation:

- **Leaf scale** — multiplier on leaf size
- **Petiole length / radius** — petiole dimensions
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
Undo (<kbd>⌘/Ctrl</kbd>+<kbd>Z</kbd>) restores the previous parameter
set.

Modified parameters are marked with a yellow accent and an "×" scale
factor relative to the default, so you can see at a glance what you've
changed.

## Save and reuse presets

- **Export JSON** — save the current parameter set to a file.
- **Import JSON** — load a previously saved set.

This is the easiest way to build up a per-cultivar library. Name files
descriptively (e.g., `apple_fuji_high-density.json`) and check them
into version control alongside your analysis code.

## Workflow: fit to a scan

A common loop when you have a real plant scan and want a matching
procedural model:

1. **Generate** at the right species and age.
2. **Align** the generated mesh to the scan via
   [Register & compare](register-compare.md#cloud-to-mesh).
3. **Morph** to reduce the RMSE — try girth and insertion angle first;
   these have the biggest visual effect.
4. Repeat alignment + morph until the fit is satisfactory.
5. **Export JSON** to lock in the cultivar parameters.

For a rigorous fit, scriptable parameter sweeps via the backend API
will be more efficient than manual iteration. See the
[developer docs](../developers/api/endpoints.md).
