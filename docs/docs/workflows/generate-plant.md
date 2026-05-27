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

5. **Advanced → Random seed** — Phytograph uses a default seed for
   reproducibility. Toggle the override and set your own seed to
   produce a different but reproducible variant.

6. Click **Generate Plant**.

Generation takes anywhere from a couple of seconds (young vegetable) to
a minute (mature tree). When it finishes, the mesh appears in the
**Meshes** list and the **Plant** panel opens at the right for further
control.

## Live age scrubbing

Once a plant is in the scene, the **Plant** panel shows an **Age
slider**. Drag it to scrub through the plant's development; the mesh
regenerates as you go. This is dramatically faster than re-running
Generate at different ages.

When you find an age you want to keep, click **Render** in the Plant
panel to commit. The plant is now anchored at that age in the scene.

## Generate several plants at once

Repeat the **Generate Plant** workflow with different positions to
build a multi-plant scene. Each plant is its own mesh entry; you can
hide, color, and export them independently.

For studies that need a regular grid or row of plants, consider
scripting via the backend API directly — see the
[developer docs](../developers/api/endpoints.md).

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
