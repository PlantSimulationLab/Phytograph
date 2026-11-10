# Leaf area density (`be.lad`)

Part of the `phytograph` skill. `help(pg.Backend.lad)` gives every parameter.

- It needs the misses (beams that hit nothing), and the API cannot backfill them (the app can).
  Import formats that keep them: E57, structured PLY, ASCII with an `is_miss` column, or
  `from_numpy(columns={"is_miss": ...})`.
- First-echo-only data biases LAD high.
- GPS time must be float64.
- Scan geometry (`pg.Scan` origin, sample counts, sweep) must be the scanner's own.
- Crop only outside the grid.
- `lmax` is fixed at 0.1 m in the API; the app estimates it. Set it for the scene's point
  spacing.
- The leaf/wood split uses `wood_class` by default when the cloud has it. Pass
  `wood_split={"slug": None}` to turn it off, or name another column with `wood_values` and
  `leaf_values`.
- `NaN` in the result is unsolved, not zero. Voxels flagged `under_sampled` are biased high.
- Never invert on a leaf-only cloud: beams stopped by wood would read as transmitted.
