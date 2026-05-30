# Plant models

A **plant model** is a procedurally generated plant produced by the
[Helios](https://baileylab.ucdavis.edu/software/helios/) plant-modeling
engine. Unlike a scanned plant — which is a static snapshot of one
individual — a plant model is parametric: you can change its age,
species, position, growth parameters, and regenerate the geometry.

## When you'd use one

- **Method comparison** — generate a "ground truth" plant with known
  geometry, simulate a scan of it, then test how well your reconstruction
  recovers the truth.
- **Growth studies** — render the same plant at multiple ages without
  collecting multi-temporal scans.
- **Sensitivity analysis** — morph one parameter (insertion angle,
  internode length) and observe the effect on derived metrics.
- **Synthetic data generation** — produce many labeled plants for
  training ML models.

## Available species

Phytograph exposes the species library that ships with Helios, grouped
into:

- **Trees** — almond, apple, walnut, pistachio, olive, citrus, and others
- **Vines** — grapevine
- **Cereals** — wheat, rice, maize
- **Vegetables** — tomato, lettuce, strawberry
- **Weeds** — various

The exact list updates with the bundled Helios version. Pick from the
species dropdown in the **Generate Plant** popup.

## How generation works

When you click **Generate Plant**, Phytograph:

1. Initializes the model at age 0.
2. Advances it day by day to the target age.
3. Returns the final mesh — stems, branches, leaves, optionally fruit.

Leaves and bark are rendered with the species' textures from the Helios plant
library, with leaf silhouettes cut out by the image's transparency; untextured
organs use their organ colors. See [Meshes: Textures](meshes.md#textures).

The same growth machinery is exposed live via the **Age slider** in the
Plant panel, so you can scrub through development after generation.

## Morphing a generated plant

Every plant exposes a set of **morphable parameters**:

- Geometry parameters (internode length, insertion angle, girth factor, …)
- Geometry scale (leaf scale, petiole length and radius, internode radius)
- Distribution parameters (some values are distributions, not scalars —
  uniform, normal, or constant)

Editing these and clicking **Regrow** rebuilds the plant with the new
parameters at the current age. See [Morph a plant](../workflows/morph-plant.md).

## What you can do with a plant model

| Operation | Where |
|---|---|
| Change the age | Plant panel → Age slider |
| Change a parameter | Morph popup |
| Simulate a scan of it | Add a [Scan location](scans.md), then run **Simulate Scan** |
| Save a parameter preset | Morph popup → Export JSON |
| Load a parameter preset | Morph popup → Import JSON |
| Export the mesh | Standard mesh export |
