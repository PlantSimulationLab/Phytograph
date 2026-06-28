# Segment ground points

Terrestrial scans of plants capture the soil surface alongside the plant.
Those ground points contaminate downstream steps — triangulation,
skeleton extraction, cloud-to-mesh distance — so it helps to separate
**ground** from **plant** first. Phytograph does this with the **Cloth
Simulation Filter (CSF)**: it drapes an inverted cloth over the cloud and
labels the points the cloth settles onto as ground.

## Segment

1. Select a single point cloud.
2. Click **Segment Ground** (the layers icon in the tool column), or open
   the command palette and choose **Segment Ground**.
3. Adjust the parameters if needed (hover the **?** beside any parameter for
   a quick explanation). The parameters are seeded automatically from the
   cloud's size **and shape** each time you open the panel — a few centimetres
   of cloth resolution for a pot/plot-scale scan, scaling up to tens of
   centimetres for a field- or orchard-scale scan. The seed also reads the
   cloud's **vertical relief**: a large *flat* field gets a coarse, stiff
   cloth, but a large *sloped* tile (e.g. an aerial scan of a hillside forest)
   gets a **finer cloth, low rigidness, and slope smoothing on** so the cloth
   can bend to follow the slope instead of draping flat and catching only the
   valley floor.
   (CSF's parameters are absolute distances, so a fixed default that suits a
   1 m plant scan would label nearly everything as non-ground on a 50 m
   field — and a coarse, stiff cloth tuned for a flat field bridges over a
   steep tile, labelling the whole uphill slope non-ground. The seeded values
   are a starting point — override them freely.)
    - **Cloth resolution (m)** — the cloth grid cell size. Smaller follows
      finer ground relief but is slower; for pot/plot-scale scans a few
      centimetres works well.
    - **Ground tolerance (m)** — how far a point can sit *above* the draped
      cloth and still count as ground. Raise it to pull low plant material —
      weeds, ground cover, inter-row vegetation — into the ground class;
      lower it to keep more of the plant base separate. Because it's an
      absolute height above the cloth, field- or orchard-scale scans need
      larger values than pot-scale ones: e.g. on a 50 m orchard tile a
      tolerance around **2 m** absorbs the inter-row weeds while leaving the
      tree canopy as non-ground, whereas the seeded ~0.5 m keeps them
      separate. Nudge it up until the weeds flip to ground without the trees
      following.
    - **Rigidness (1–3)** — cloth stiffness. Use **3** for flat ground,
      lower (down to **1**) for undulating or sloped terrain so the cloth can
      bend to follow the slope instead of bridging over it.
    - **Slope smoothing** — enables CSF's slope-handling pass. Leave it off for
      flat ground; turn it on (together with a low rigidness) for undulating or
      steep terrain. It's auto-enabled when the cloud's vertical relief is
      large relative to its footprint.
4. (Optional) Tick **Split into ground + plant clouds** to also produce two
   new clouds — ground and non-ground — alongside the classified original.
5. Click **Segment Ground**. While it runs, the button shows a spinner and a
   **Cancel** button appears beside it — click Cancel to stop a long or stuck run
   immediately (the computation is killed and the cloud is left unchanged).

When it finishes, the cloud is recoloured by a new **Ground Class**
attribute, with a legend in the corner showing which colour is which. The
original points are never deleted.

!!! note "Ground vs *non-ground*, not ground vs plant"
    CSF only separates the ground from everything above it. The above-ground
    class is labelled **Non-ground** because the filter can't tell a plant
    from any other object sitting on the ground — a person, a building, a
    tripod. In a clean plant scan the non-ground class *is* the plant, but if
    the scene contains other above-ground objects they'll land in the same
    class. Crop them out first (see [Clean a point
    cloud](clean-point-cloud.md#crop)) if you need a plant-only result.

## Inspect and use the result

The classification is stored as a scalar attribute named **Ground Class**.
You can switch back to it any time from the **Color by** picker in the
Display panel — it shows discrete colours (brown for ground, green for
non-ground), not a continuous gradient.

If you ticked **Split**, two extra clouds appear in the scan list —
`… (ground)` and `… (non-ground)`. Hide or delete the ground cloud, or run
skeleton extraction / triangulation on the non-ground cloud alone.

!!! note "Large clouds"
    Clouds imported from XYZ files stream from disk as an octree. Ground
    segmentation re-reads the original file at full resolution, so the
    classification covers every point — not a downsampled subset.
