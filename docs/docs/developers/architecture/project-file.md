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
exceed 4 GB). JSON members are deflated. Point arrays are the bulk of the
bytes and are written as **`.pz` columns**: independent ~8 MB blocks, each
run through a transform picked per column from a sample, then raw-deflated
(level 1), compressed and decompressed on a thread pool. The ZIP member itself
is stored, since the compression happens inside it where it can run in
parallel. The transforms are:

| Filter | Wins on |
|--------|---------|
| `none` | small-integer columns: intensity, flags, target index and count |
| `shuffle` (byte planes) | float columns (reflectance) |
| `delta_shuffle` (differences of the integer view, then byte planes) | monotone columns: GPS time goes from 56% of raw size to 27% |

Deltas are taken on the integer view of the bits, so every column
round-trips **bit-exactly** (NaN payloads, `-0.0`, integer wraparound). On a
21 M-point RIEGL scan the columns go from ~48 to ~27 bytes/point. Float64
positions set the floor at ~76%, because their low mantissa bytes are
measurement noise. A `.pz` member is `PHYZ\x01\n`, a u32 header length, a
JSON header `{dtype, shape, filter, block_rows}`, then per block a u32
compressed length and the deflate body. Readers validate the header and each
block's decompressed length, so a damaged column fails the open instead of
loading garbage. A 0-d array is written as `.npy`.

```text
manifest.json                       format, version, app version, members
scene.bin                           the renderer's scene document (PSC1, below)
sessions/<sid>/session.json         one cloud session's scalar fields
sessions/<sid>/<column>.pz          its point-aligned arrays
sessions/<sid>/history/<k>.pz       delete / label undo deltas
sessions/<sid>/misses/<key>.pz      the backfilled-miss buffer
octrees/<cacheId>/<file>            display octrees a session cannot rebuild
```

`manifest.json` holds `{"format": "phytograph-project", "version": 2,
"app_version", "created", "sessions": [...], "octrees": [...],
"regenerate": [...]}`. `octrees` are embedded; `regenerate` names octrees
the file leaves out because a saved session rebuilds them. A reader refuses
an unknown `format`, or a `version` newer than its own, with a message saying
which Phytograph version wrote the file. Version 1 files (every column a
`.npy`, every octree embedded, no `regenerate`) still open: a reader looks
for `<stem>.pz` first and falls back to `<stem>.npy`.

**No pickle, anywhere.** A project is a file people send each other.
Unpickling one would run whatever code it carries, so every array is a
`.pz` column (plain numeric dtypes only) or a `.npy` read with
`allow_pickle=False`, and every other value is JSON. Member
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

**Display octrees.** A display octree is a second full copy of its cloud,
about 50 bytes/point, the same as the session itself. Embedding every one
doubled a project (a 675 MB, three-scan RIEGL project saved at 6.2 GB, half of
it octrees). So an octree is embedded only when the saved session **cannot**
reproduce it:

- **Left out (`regenerate`)**: the cloud's current octree and its miss
  octree, when the octree matches the session. That means `octree_cache_id`
  is set, and there is no `rendered_octree_cache_id` and no `octree_pose`.
  On open, if the id is not already in this machine's cache (reopening on the
  machine that saved finds it there and rebuilds nothing), the backend
  rebuilds it from the restored session *before* registering it, and returns
  `octree_map` (saved id → rebuilt id). The rebuild hashes the LAS it writes,
  not the one import wrote, so the id can change. The renderer rewrites each
  cloud's `cacheId`/`missOctreeCacheId` through the map. The cost is one
  PotreeConverter pass per cloud on a machine without the cache, the same
  as the original import's.
- **Embedded (`octrees`)**: everything else. A stale octree (a pending
  deletion the renderer masks, `rendered_octree_cache_id`) or a posed one
  (`octree_pose`, a transform the renderer applies on top) is a different
  picture than a rebuild would give, and the saved renderer state is written
  against that picture. On open each is installed into the cache under the
  same content address, unless it is already there.

An octree missing at save time, for example evicted from the cache, is
simply left out. The cloud's session is the source of truth, and the octree
is rebuilt from it on first display.

**Scene document (renderer).** The scene store's collections are saved:
scans and their clouds, meshes, skeletons, QSMs, LAD results, the transform
maps and the edit states. So is the viewer state a user expects back:

- per-cloud color modes, the colormap and custom color-ramp ranges, and
  live display filters;
- per-mesh opacity, color mode and displayed layer;
- point size, measurements and picked points;
- the scene origin (both a user-set pivot and the scanner-stations pivot
  latched when the scene first filled, which is restored rather than
  re-derived) and the camera (restored for any content, not only clouds);
- the tree inventory, with its species/status/label entries and stand
  settings, and the entries typed for every other cloud inventoried earlier
  (the per-cloud stash the panel restores when you return to one). Its
  staleness key names the octree it was measured on, and is remapped through
  `octree_map` on open, so a rebuilt octree does not read as "stale";
- uncommitted label strokes (`labelPending`, and `labelCommitHolds` for
  strokes whose bake had not reached the screen). A stroke writes the
  session's label column but not the display octree, so these are what draw
  it until a bake. Without them a reopened cloud showed its pre-label
  octree, and the labels looked erased. A hold comes back marked as a failed
  bake, so the next bake retries it;
- tree-segmentation seed points and the batch-QSM settings.

The document is stored as one PSC1 blob: a magic, a JSON header, then the
document's typed arrays back to back. The JSON has three tagged forms:

- `{"$buf": k, "dtype": "f32"}` is the header's typed array `k`;
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
streaming progress, cancelable). The renderer first stages its scene
document (`POST /api/project/scene`, which returns a token), then sends the
token, the target path and the ids of the sessions the scene uses. The
backend snapshots **every** session at one moment, before writing any, then
writes to a `<path>.<run>.partial` unique to the run and renames it over
the target only when the archive is complete. Saves to one target are
serialized by a per-path lock: two overlapping saves (Cancel, then Save
again, while the canceled one runs on to its next checkpoint) once shared
one `.partial`, and the first to finish renamed the other's half-written
archive over the project. A failed or canceled save never damages an
existing project, and the last cancel point is **before** the rename, so a
save reported canceled never replaced the file. Session arrays are streamed
from their (possibly memory-mapped) columns in chunks, so saving a
100 M-point cloud holds no second copy in RAM. A listed session the backend
no longer has (its spill trimmed) is left out and named in
`missing_sessions`, rather than failing the save: that cloud is already
unusable, and failing stopped the user saving anything else. The renderer
names those clouds in its warning.

The renderer makes a save (and an open) **modal**: an overlay covers the
window, keys are swallowed and menu commands refused until it finishes. An
edit landing mid-save would otherwise be in a cloud's saved session but not
in the scene document staged before it (or the reverse), and the file would
disagree with itself. When the save succeeds, the renderer marks as saved
the scene state and viewer state the document was **built from**, not
whatever they are by then.

**Unsaved changes.** The scene counts as unchanged since the last save or
open only while the scene store *and* the saved viewer state (the
`projectViewerState` object in `PointCloudViewer`) are the very objects that
were saved. The quit/close prompt reads that. A field added to the saved
viewer state belongs in `projectViewerState`, which both saves and tracks
it.

**Open** (`POST /api/project/open`, same properties). The backend:

1. validates the manifest;
2. installs the embedded octrees;
3. creates **new** sessions from the saved ones. The ids are new, so an open
   can never collide with a live cloud. Columns are streamed straight into a
   memory-mapped session store for a large cloud, or into RAM for a small
   one, by the same size rule import uses. Every column comes back in the
   dtype it was saved in: a live column only ever widens, and label undo
   writes its recorded values back relying on that, so narrowing a column
   to fit its current values (an instance column whose ids above 255 were
   all overpainted) made a later undo wrap them. Only version-1 files, some
   of which predate column compaction, are compacted on open, and even then
   not a column with label history;
4. rebuilds the `regenerate` octrees this machine's cache lacks (above).
   A rebuild that fails is a warning, not a failed open: the session came
   back whole, the octree id is left unmapped, and the renderer's
   missing-octree recovery rebuilds it from the session when the cloud is
   shown. The rebuild runs outside the open's own memory admission: the
   octree build takes its own, and nesting the two deadlocked whenever
   together they exceeded the budget;
5. stages the scene document and returns its token, a map from the saved
   session ids to the new ones, and the `octree_map`. The last cancel point
   is before the new sessions are registered, so a canceled open leaves none
   behind.

The renderer resets the scene (as **File → New**), rewrites every cloud's
session id and octree ids through those maps, and loads the document. A
Cancel wins until the scene document is downloaded and decoded; past that the
current scene is replaced. Any way out before the new scene takes the
restored sessions (a late cancel, a failed download) deletes them, since
nothing else knows their ids.

Opening a project replaces the current scene, so a scene with unsaved
changes asks for confirmation first, as **File → New** does.
