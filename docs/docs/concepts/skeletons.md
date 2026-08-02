# Skeletons

A **skeleton** is a graph that captures the branching topology of a
woody plant: a set of **nodes** (junctions and tips) connected by
**edges** (segments of branch). Skeletons compress thousands of points
on a branch surface into a few nodes along its centerline, making them
ideal for measuring lengths, counting branches, and computing
topological metrics.

## What gets reported

When you extract a skeleton, Phytograph reports:

- **Node count** — total number of vertices in the graph
- **Edge count** — total number of segments
- **Total length** — sum of edge lengths (the plant's total skeleton length)
- **Branch orders** — Strahler number per branch, colored from trunk
  (low order) to twig (high order)

## Extraction method

Phytograph uses a single **BFS graph** method: it builds a neighbourhood graph
over the cloud, roots it at the trunk base, and traces branches outward to
recover the centerline and its topology.

The main controls are a **Search Radius** (left at `0` it auto-picks one from
the cloud's density) and **Min Points/Block**, which sets how much support a
branch needs before it's kept — raise it to suppress spurs, lower it to keep
thin tips. An optional Laplace smoothing pass cleans up the result. See
[Extract a skeleton](../workflows/extract-skeleton.md) for the full panel.

See [Extract a skeleton](../workflows/extract-skeleton.md) for the full
walkthrough.

## What you can do with a skeleton

| Operation | How |
|---|---|
| Color by branch order | Right-click skeleton → Color By → Branch Order |
| Hide leaves / show only stem | Filter by branch order range |
| Export as a graph | Export → `.json` (preserves topology) |
| Export as line segments | Export → `.obj` (geometry only) |

## Skeletons vs meshes

Both can represent a plant's structure, but they answer different
questions:

| Question | Use |
|---|---|
| What's the total branch length? | Skeleton |
| What's the leaf area? | Mesh |
| How many primary branches? | Skeleton |
| How does it look in a render? | Mesh |
| How does branch topology change with age? | Skeleton |
| How well does ICP align two scans? | Mesh (denser, more constraints) |

A common workflow: triangulate to a mesh, then extract a skeleton from
the cloud (not the mesh) for analytical metrics, keeping both in the
scene.
