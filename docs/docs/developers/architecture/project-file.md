# Project file (`.phyto`)

A project file saves the whole scene into **one self-contained file** and
reopens it exactly: every cloud with all its points, columns and pending
edits, every mesh, skeleton, QSM and LAD result, and the viewer state around
them. It never refers back to the files the scene was imported from. A
cloud's source file is read once, at import, and every later edit lives only
in the cloud's session. Replaying edits against a referenced source would
have to reproduce every tool exactly, so the project carries the data
itself.

## Container

A `.phyto` file is a **ZIP archive** (ZIP64, so members and the archive may
exceed 4 GB). Point arrays are stored **uncompressed**: they compress poorly
and are the bulk of the bytes, and storing them keeps save and open close to
disk speed. JSON members are deflated.

```text
manifest.json                       format, version, app version, members
scene.json                          the renderer's scene document
buffers/<k>.bin                     typed arrays referenced from scene.json
sessions/<sid>/session.json         one cloud session's scalar fields
sessions/<sid>/<column>.npy         its point-aligned arrays
sessions/<sid>/history/<k>.npy      delete / label undo deltas
sessions/<sid>/misses/<key>.npy     the backfilled-miss buffer
octrees/<cacheId>/<file>            the display octrees the scene points at
```

`manifest.json` holds `{"format": "phytograph-project", "version": 1,
"app_version", "created", "sessions": [...], "octrees": [...]}`. A reader
refuses an unknown `format`, or a `version` newer than its own, with a
message saying which Phytograph version wrote the file.

**No pickle, anywhere.** A project is a file people send each other.
Unpickling one would run whatever code it carries, so every array is a
`.npy` read with `allow_pickle=False`, and every other value is JSON. Member
names come from the manifest and are validated (`[A-Za-z0-9_.-]`, no path
separators). A name that fails validation fails the open, so no member can
write outside its target directory.

## What is saved

**Cloud sessions (backend).** Every `CloudSession` the scene references is
written with its full state:

| Kind | Fields |
|------|--------|
| point-aligned arrays | `positions`, `colors`, `intensity`, `deleted`, `deleted_base`, `timestamps`, `beam_origins`, and every `extras` column (in order, with its `extra_dims_meta` label) |
| undo history | `deleted_history` (one index array per step) and `label_history` (each `_LabelDelta`'s arrays, stroke id, encoding and count) |
| miss buffer | `backfilled_misses` (`positions`, `directions`, `timestamp`, `origins` when present) |
| scalars | `world_shift`, `ascii_format`, `column_plan`, `source_path` (provenance only), `crs_epsg`, `source_units`, `source_unit_scale`, `gps_time_encoding`, `octree_cache_id`, `rendered_octree_cache_id`, `miss_octree_cache_id`, `miss_octree_origin`, `octree_pose`, `octree_point_count`, `octree_stale_gen`, `normals_stale`, `derived_fields`, `backfilled_misses_stale`, `backfilled_misses_moved`, `unrestorable_hit_count` |

Pending (unbaked) deletions therefore reopen still pending, and undo still
works across a save. The backend's `deleted` mask and the renderer's
`pendingDeletes` are both saved, so they stay in step.

**Display octrees.** The octree directories the scene points at (each
cloud's current octree and its miss octree) are copied in. On open, each is
installed into the octree cache under the same content address, unless it
is already there. Reopening a large cloud therefore does not reconvert it.
An octree missing at save time, for example evicted from the cache, is
simply left out. The cloud's session is the source of truth, and the octree
is rebuilt from it on first display.

**Scene document (renderer).** The scene store's collections are saved:
scans and their clouds, meshes, skeletons, QSMs, LAD results, the transform
maps and the edit states. So is the viewer state a user expects back:

- per-cloud colour modes and the colormap;
- point size, measurements and picked points;
- the scene origin and the camera;
- the tree inventory, with its species/status/label entries and stand
  settings.

The document is plain JSON with three tagged forms:

- `{"$buf": k, "dtype": "f32"}` is a typed array stored as `buffers/<k>.bin`;
- `{"$map": [[key, value], ...]}` is a `Map`;
- `{"$set": [...]}` is a `Set`.

Any other value is written as itself.

**Not saved.**

- **Undo history of the scene store.** Undo does not reach back past an
  open. The session-level delete and label history above is kept, because
  it is part of the data.
- **Live plant-growth sessions.** Generated plants keep their mesh, their
  parameters and their seed, and can be regenerated. A plant cannot be
  *grown on* from its old age without regenerating it.
- **App-wide settings.** Theme, the palette library and default paths live
  in the app's settings, not in a project.

## Save and open

**Save** (`POST /api/project/save`, a plain `def`, admission-gated,
streaming progress, cancellable). The renderer sends its scene document and
buffers as one PHB1 frame, together with the target path and the ids of the
sessions the scene uses. The backend writes to `<path>.partial` and renames
it over the target only when the archive is complete. A failed or cancelled
save never damages an existing project. Session arrays are streamed from
their (possibly memory-mapped) columns in chunks, so saving a 100 M-point
cloud holds no second copy in RAM.

**Open** (`POST /api/project/open`, same properties). The backend:

1. validates the manifest;
2. installs the octrees;
3. creates **new** sessions from the saved ones. The ids are new, so an open
   can never collide with a live cloud. Columns are streamed straight into a
   memory-mapped session store for a large cloud, or into RAM for a small
   one, by the same size rule import uses;
4. returns the scene document, its buffers, and a map from the saved
   session ids to the new ones.

The renderer resets the scene (as **File → New**), rewrites every cloud's
session id through that map, and loads the document.

Opening a project replaces the current scene, so a scene with unsaved
changes asks for confirmation first, as **File → New** does.
