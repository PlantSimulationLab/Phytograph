# Generate a plant

Produce a procedural plant from species, age, and position. Useful for
method comparison, sensitivity analysis, and synthetic training data.
See [Plant models](../concepts/plant-models.md) for the conceptual
background.

## Run it

1. Click **Generate Plant** (sprout icon) in the toolbar. The popup opens.

2. **Species** — pick from the dropdown. Species are grouped:

    - **Trees** — almond, apple, walnut, pistachio, olive, citrus, …
    - **Vines** — grapevine
    - **Cereals** — wheat, rice, maize
    - **Vegetables** — tomato, lettuce, strawberry
    - **Weeds** — various

3. **Age** — target age in days. Younger plants are smaller and have
   fewer branches; the same species at 30, 365, and 1825 days looks
   very different.

4. **Position** — (X, Y, Z) of the plant base, in meters. Defaults to
   the world origin. Set this when generating multiple plants so they
   don't overlap.

5. **Generate as canopy** — toggle this to build a regularly spaced
   grid of plants instead of one. See
   [Generate a canopy](#generate-a-canopy) below.

6. **Advanced → Random seed** — Phytograph uses a default seed for
   reproducibility. Toggle the override and set your own seed to
   produce a different but reproducible variant.

7. Click **Generate Plant**.

Generation takes anywhere from a couple of seconds (young vegetable) to
a minute (mature tree). While it runs, the popup stays open and shows a
**progress bar** with the current phase ("Growing plants…", "Packing
geometry…") and a **Cancel** button if you want to abort a long build.
When it finishes, the mesh appears in the **Meshes** list and the
**Plant** panel opens at the right for further control.

## Live age scrubbing

Once a plant is in the scene, the **Plant** panel shows an **Age
slider**. Drag it to scrub through the plant's development; the mesh
regenerates as you go. This is dramatically faster than re-running
Generate at different ages.

When you find an age you want to keep, click **Render** in the Plant
panel to commit. The plant is now anchored at that age in the scene.

## Generate a canopy

To build a regularly spaced stand of plants in one step, toggle
**Generate as canopy** in the Generate Plant popup. The single-plant
**Position** becomes the **Canopy center**, and these controls appear:

- **Spacing (m)** — distance between neighboring plants in X and Y.
- **Count (plants)** — number of columns (X) and rows (Y). The popup
  shows the total (`columns × rows`).
- **Advanced → Germination rate** — probability (0–1) that each grid
  position is filled. `1.0` fills every position; lower values leave
  random gaps, simulating a realistic stand with missing plants.

All species share the chosen age. Click **Generate Canopy**. The whole
grid comes back as a **single merged mesh** — one row in the **Meshes**
list, named like `bean canopy 3×3 (30d)` — so you can hide, color, and
export the canopy as one object. Because a canopy can build many plants,
generation takes proportionally longer than a single plant — the popup's
progress bar tracks the build, and **Cancel** stops it.

!!! note "Canopies are fixed-age"
    Unlike single plants, a canopy has no live age slider — it is built
    at the chosen age. To change the age, regenerate the canopy.

## Generate several plants individually

If you need plants you can hide, color, and export independently, repeat
the **Generate Plant** workflow (canopy toggle off) with different
positions. Each plant is then its own mesh entry.

## Common follow-ups

- **[Simulate a LiDAR scan](simulate-scan.md)** of the plant — produce
  the cloud a real scanner would see, useful as ground-truth input.
- **[Morph a plant](morph-plant.md)** — change geometry parameters
  interactively.
- **[Register & compare](register-compare.md)** — compare a generated
  plant to a real scan.

## Common problems

**"Generation crashes or hangs."**
Most likely cause: the requested age is unrealistic for the species
(e.g., 10,000 days for an annual). Check the species' typical lifespan
and stay within it. The next most common cause is running out of
memory on a very dense species (mature trees with full foliage).
Reduce age or switch to a smaller species.

**"The plant looks wrong / unrealistic."**
The Helios species library is parameterized from published literature
but defaults may not match your specific cultivar. Use
[Morph a plant](morph-plant.md) to adjust. If you find consistently
better parameters, save them via Morph → Export JSON and reuse.
