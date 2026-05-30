# Test fixtures

- `bean_scan_small.xyz` — decimated Helios bean scan; col 4 = ground truth
  (1=ground, 2=plant). Used by `test_ground_segment.py`.

- `multi_tree_small.xyz` — small multi-tree TLS cloud for
  `test_segment_trees.py`. Columns: `x y z treeiso_label`. Derived by
  voxel-downsampling the **TreeIso** demo cloud `data/LPine1_demo.laz` from
  https://github.com/truebelief/artemis_treeiso (MIT, © Zhouxin Xi & Loïc
  Landrieu). The 4th column is TreeIso's own segmentation on the full-resolution
  cloud, kept only as a sanity reference — the tests assert on a re-run, not on
  this column. Redistribution of this derived excerpt is permitted under the
  upstream MIT license; see `backend-api/vendor/treeiso/UPSTREAM_LICENSE.txt`.
