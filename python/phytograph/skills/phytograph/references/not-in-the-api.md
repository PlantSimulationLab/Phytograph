# Not in the API (the app only)

Part of the `phytograph` skill. These exist in the Phytograph desktop app but not in the Python
package. Do not try to reproduce them by calling private endpoints.

- Resampling and voxel thinning. Work around it with `to_numpy`, subsample, and `from_numpy`,
  which drops the scanner pose and the misses unless you pass `is_miss`.
- Erase brush and screen-space crops.
- CHM as a surface. Subtract two `dem()` calls on the same `cell_size` and `bbox`.
- Multi-scan loop closure, stitching, mesh ICP, and cloud-to-mesh distance.
- Backfilling misses.
- Simulated scans. Build the cloud with PyHelios and pass it to `be.from_numpy` with `is_miss`
  and `timestamp`.
- Refining a tree segmentation by merging or splitting.
- Stand-level biomass.
