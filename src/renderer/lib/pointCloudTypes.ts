// Shared type definitions for the point-cloud viewer. These were originally
// declared inside PointCloudViewer.tsx; they live here so the viewer, its
// extracted leaf components (components/viewer/**), and the lib parsers can all
// import them without a components → lib cycle. Pure types only — no runtime
// code, so importing this module has zero side effects.
import * as THREE from 'three';
import type { BackendPointSource, ColumnPlan, ScanParamsFromFile, TriangulationMethod } from '../utils/backendApi';
import type { ScanParameters } from './scanParameters';

// potree-core's RequestManager interface isn't re-exported from the package
// root in v2.0.15. The shape is small and stable, so mirror it locally
// instead of importing from a deep subpath.
export interface PotreeRequestManager {
  fetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response>;
  getUrl(url: string): Promise<string>;
}

// Scalar field data with min/max for normalization
export interface ScalarField {
  values: Float32Array;
  min: number;
  max: number;
}

// Reference to a Potree 2.0 octree on disk (in the backend's cache). Present
// on every cloud produced by the XYZ importer post-0.3.0; absent on
// renderer-side synthetic data (skeleton/mesh-derived overlays). The viewer
// renders via potree-core streaming when this is set, falling back to the
// flat-typed-array path otherwise.
export interface OctreeRef {
  cacheId: string;            // sha1 hex; also the cache dir name
  sourceXyzPath: string;       // original on-disk source — needed for re-crop
  // Backend cloud-session id (Family-1 mutable model). When set, this cloud's
  // points live in an in-RAM backend array that is the source of truth: crop /
  // erase route through delete_region (instant mask, no rebuild), downstream
  // ops read the masked array via PointSource.session_id, and "Permanently
  // apply" bakes a fresh octree (updating `cacheId`). Octree clouds imported
  // via the editable flow always carry this.
  sessionId?: string | null;
  asciiFormat?: string | null; // Helios <ASCII_format> hint, when known
  // Optional per-attribute min/max from PotreeConverter's metadata.
  // Keyed by attribute name ("intensity", "rgb", "classification", …).
  // The OctreePointCloud material effect uses these to set the shader's
  // heightMin/Max + intensityRange uniforms — without them the gradient
  // lookups all hit the same texel and the cloud renders solid colour.
  attributeRanges?: Record<string, { min: number[]; max: number[] }>;
  // Display-name map for imported extra-dimension scalars, keyed by the
  // on-disk attribute slug (e.g. 'Reflectance_dB' → 'Reflectance [dB]').
  // Drives the scalar picker's option labels; slugs without an entry fall
  // back to showing the slug verbatim.
  attributeLabels?: Record<string, string>;
  // Explicit column layout chosen in the import wizard (ASCII sources only),
  // kept as provenance of how this cloud was imported. With the cloud-session
  // flow the wizard plan is honored once at session create and the points then
  // live in the in-RAM array, so edits never re-auto-detect columns — a
  // renamed/remapped/categorical scalar survives crop/erase/bake. Absent for
  // auto-detected imports.
  columnPlan?: ColumnPlan | null;
  // On-disk attribute slugs the user marked categorical in the wizard. The
  // renderer registers these so they colour as discrete classes rather than a
  // continuous gradient. See classification.ts registerCategoricalSlug.
  categoricalAttributes?: string[];
  // Sky/miss points (laser pulses that returned nothing). They live in the
  // backend session for LAD but are NOT in this octree (their ~20 km coords
  // would poison its bounding box), so they're fetched on demand and drawn as a
  // separate overlay relocated onto the bounding sphere. `hasMisses` gates the
  // "Show misses" toggle; `scanOrigin` (when the source carried it) is the true
  // beam apex used to project the overlay. See getCloudMisses / MissOverlay.
  hasMisses?: boolean;
  scanOrigin?: [number, number, number] | null;
  // Full scan-pattern parameters recovered from the source file (E57 pose +
  // angular sweep + grid resolution; PCD VIEWPOINT origin), when present. The
  // import path turns this into the Scan's ScanParameters so a lone-file import
  // auto-creates a populated scan, mirroring the Helios-XML path. Absent for
  // formats/files that carry no scan metadata. See buildScanFromWizardResult.
  scanParams?: ScanParamsFromFile | null;
}

// Result of buildPointSource: either an in-memory cloud (flat path) or a
// backend source descriptor (octree path). Downstream-op handlers branch on
// `kind`. The `source` shape is the BackendPointSource fields the renderer
// fills in (the per-op `max_points`/`want_colors` are added at the call site).
export type PointSourcePayload =
  | { kind: 'inline'; data: PointCloudData }
  | { kind: 'source'; source: Pick<BackendPointSource, 'source_path' | 'ascii_format' | 'translation' | 'session_id'> };

// Point cloud data interface
export interface PointCloudData {
  positions: Float32Array;  // x, y, z interleaved — empty when `octree` is set
  colors?: Float32Array;    // r, g, b interleaved (0-1 range)
  intensities?: Float32Array;
  scalarFields?: Record<string, ScalarField>;  // name -> values with min/max
  pointCount: number;
  bounds: {
    min: THREE.Vector3;
    max: THREE.Vector3;
    center: THREE.Vector3;
    size: THREE.Vector3;
  };
  fileName?: string;
  octree?: OctreeRef;  // present iff the cloud is streamed from an octree
}

// Point cloud entry with metadata. Internal alias matching the data-bearing
// shape of `Scan` for legacy callsites — every PointCloudEntry seen inside
// this file is derived from `scans.filter(hasData)`.
export interface PointCloudEntry {
  id: string;
  data: PointCloudData;
  visible: boolean;
  color: string; // Label color for identification
  // On-disk source path, when known. Set at import time via the
  // electron `webUtils.getPathForFile` bridge or the Helios XML
  // resolver. Lets the apply-crop path delegate the heavy filter
  // work to the Python backend (which can re-read the file) instead
  // of allocating big intermediates in V8 — see handleApplyCrop.
  sourcePath?: string;
  // Helios <ASCII_format> hint preserved from the importing XML so the
  // backend can re-parse XYZ-family files with the same column layout.
  asciiFormat?: string | null;
  // Mirrors Scan.showMisses — whether to draw the sky/miss overlay for this
  // cloud (off by default; offered only when data.octree.hasMisses).
  showMisses?: boolean;
  // Scanner geometry (origin etc.) when the scan carries params, so the miss
  // overlay can project misses along the true beam direction.
  params?: ScanParameters;
}

// Per-cloud edit state. The crop region is no longer per-cloud — it
// lives at the viewer level so a single crop applies uniformly across
// every selected scan (see CropRegion / cropRegion state below).
export interface CloudEditState {
  translation: { x: number; y: number; z: number };
  erasedIndices: Set<number>;  // Set of erased point indices (flat clouds only)
  // Session-backed clouds (Family-1): the ordered stack of delete regions
  // applied this session but NOT yet baked. Each is the exact CropOctreeRegion
  // sent to the backend's delete_region. Drives (a) the GPU clip-volume preview
  // so deleted points vanish instantly, (b) undo via reset_edits(count), and
  // (c) the "unbaked deletions" indicator + on-close bake prompt. Cleared on
  // bake. Absent/empty when nothing is pending. The region shape is kept as a
  // plain object (PendingDeleteRegion) to avoid a backendApi import cycle here.
  pendingDeletes?: PendingDeleteRegion[];
  // Backend-reported count of points currently deleted by the pending (unbaked)
  // deletes, so the scan row's point count reflects the deletion immediately
  // (the octree metadata's pointCount only drops on bake). 0 when none pending.
  pendingDeletedCount?: number;
}

// Mirror of backendApi's CropOctreeRegion, duplicated here to keep this
// types-only module free of a backendApi import. Kept structurally identical so
// a PendingDeleteRegion passes straight to deleteCloudRegion / the clip preview.
export type PendingDeleteRegion =
  | { kind: 'box'; min: [number, number, number]; max: [number, number, number]; invert?: boolean }
  | {
      kind: 'polygon';
      points: Array<[number, number]>;
      projection: number[];
      view: number[];
      canvas: { width: number; height: number };
      invert?: boolean;
    }
  | {
      kind: 'squares_union';
      centers: Array<[number, number]>;
      half_sizes: number[];
      projection: number[];
      view: number[];
      canvas: { width: number; height: number };
      invert?: boolean;
    };

// State snapshot for mesh/skeleton
export interface ObjectState {
  position: { x: number; y: number; z: number };
  rotation?: { x: number; y: number; z: number };
  scale?: { x: number; y: number; z: number };
}

// History entry for undo/redo (supports all object types)
export interface HistoryEntry {
  type: 'cloud' | 'mesh' | 'skeleton';
  id: string;
  // Before and after states for proper undo/redo
  before: {
    cloudState?: CloudEditState;
    objectState?: ObjectState;
  };
  after: {
    cloudState?: CloudEditState;
    objectState?: ObjectState;
  };
}

// Mesh data from triangulation
export interface MeshData {
  vertices: Float32Array;  // x, y, z interleaved
  indices: Uint32Array;    // triangle indices
  normals?: Float32Array;  // vertex normals
  vertexColors?: Float32Array;  // r, g, b interleaved (0-1 range)
  uvCoordinates?: Float32Array;  // u, v interleaved (for textures)
  vertexCount: number;
  triangleCount: number;
  surfaceArea?: number;
  // Helios-only provenance: source scan index per triangle (aligned 1:1 with
  // `indices`/3), plus the display color of each scan as a hex string keyed by
  // that index. Present when a multi-scan Helios mesh was built; drives the
  // 'scan' pseudocolor mode. Absent for cloud-only / plant / shape meshes.
  triangleScanIds?: Uint32Array;
  scanColors?: string[];
  // Helios-only: each source scan's sensor origin [x,y,z], flat-packed and keyed
  // by scan index (so scan s is scanOrigins[s*3 .. s*3+2]). Used to orient each
  // facet's normal toward the scanner that saw it before deriving azimuth, so a
  // scanned closed surface (e.g. a sphere) reads a continuous outward bearing
  // instead of a 180° seam. Aligned with `triangleScanIds`.
  scanOrigins?: Float32Array;
  // Helios-only: the grid cell index per triangle (row-major i + nx*(j + ny*k))
  // its centroid fell in; 0xffffffff (-1 as uint32) means outside the grid.
  // Paired with `grid` below, this lets the leaf-angle plot split the
  // distribution per voxel. Present when a Helios mesh was built with a grid.
  triangleCellIds?: Uint32Array;
  // The Helios triangulation grid this mesh was built in (full extents +
  // per-axis subdivisions). Lets the leaf-angle plot label and locate cells.
  grid?: {
    center: [number, number, number];
    size: [number, number, number];
    nx: number;
    ny: number;
    nz: number;
  };
  // Helios-only: per-triangle filter metrics (aligned 1:1 with `indices`/3),
  // computed by the backend at full precision so the front-end can apply the
  // Lmax / aspect filter interactively and reproduce the C++ filter exactly
  // (see lib/heliosFilter.ts). triEdgeMax = max of the triangle's three 3-D
  // edge lengths (m); triAspect = maxEdge / minEdge. Present on an unfiltered
  // Helios triangulation mesh and on the filtered views derived from it.
  triEdgeMax?: Float32Array;
  triAspect?: Float32Array;
}

// Per-triangle pseudocolor modes for a triangulated mesh. 'solid' uses the
// mesh's label color (or its baked vertex colors); the others color each
// triangle by a geometric scalar derived from its face normal / area.
//   inclination — zenith of the face normal (0deg = horizontal, 90deg = vertical)
//   azimuth     — compass direction the face normal points (0..360deg)
//   area        — triangle surface area
//   scan        — the source scan each triangle came from, in that scan's color
//                 (Helios multi-scan meshes only)
export type MeshColorMode = 'solid' | 'inclination' | 'azimuth' | 'area' | 'scan';

// Material definition for textured meshes
export interface PlantMaterialDef {
  name: string;
  color?: [number, number, number];  // RGB 0-1
  textureData?: string;  // base64 PNG data
  hasAlpha: boolean;
  triangleIndices: number[];  // Indices of triangles using this material
}

// Mesh entry with metadata
export interface MeshEntry {
  id: string;
  sourceCloudId: string;  // Which point cloud this mesh came from
  data: MeshData;
  visible: boolean;
  color: string;
  method: TriangulationMethod;
  // User-assigned display name. When set, overrides the computed default name
  // (plant type/age, or source cloud filename). Cleared back to default when blank.
  name?: string;
  // Triangulation provenance: the parameters actually used to reconstruct this
  // mesh. Present on meshes produced by /api/triangulate (absent for imported
  // OBJ meshes and Helios plants). Drives the default display name and the
  // provenance readout in the mesh list. `pointsUsed` reflects any octree
  // downsampling; the per-method fields are only set when relevant to `method`.
  triangulationParams?: {
    // Cloud-triangulation fields (ball_pivoting / poisson / alpha_shape / delaunay)
    pointsUsed?: number;
    normalRadius?: number;
    normalMaxNn?: number;
    depth?: number;        // poisson octree depth
    alpha?: number;        // alpha-shape radius
    radii?: number[];      // ball-pivoting radii (auto-computed when omitted)
    // Helios-triangulation fields (method === 'helios')
    lmax?: number;             // max triangle edge length (m)
    maxAspectRatio?: number;   // max triangle aspect ratio
    scanCount?: number;        // number of scans fused into the mesh
    // Filter breakdown from the Helios run (method === 'helios'). Each dropped
    // candidate is attributed to one primary reason, so
    // candidates === kept + droppedLmax + droppedAspect + droppedDegenerate.
    // Lets the mesh's provenance readout show whether Lmax/aspect did the
    // pruning — and how much survived.
    candidateTriangles?: number;
    droppedLmax?: number;
    droppedAspect?: number;
    droppedDegenerate?: number;
  };
  // Interactive Helios filtering (method === 'helios'). `heliosUnfiltered.data`
  // holds the returned (auto-estimated, payload-bounded) mesh with per-triangle
  // metrics computed from its geometry; `cap` is the loosening limit of that set
  // (the front-end can filter down to it but not past it without a re-run);
  // `estimate` is the backend auto-estimate (seeds the default + separation /
  // merged-cloud readout). `heliosFilter` is the Lmax / aspect the user has
  // dialed in. `data` is always the FILTERED view derived from
  // heliosUnfiltered.data via applyHeliosFilter, so every consumer of `mesh.data`
  // (rendering, leaf angles, exports) sees the chosen filter — and that chosen
  // lmax/maxAspectRatio is what gets carried into the LAD inversion.
  heliosUnfiltered?: {
    data: MeshData;
    estimate: import('./heliosFilter').HeliosFilterEstimate;
    cap: { lmax: number; maxAspectRatio: number };
  };
  heliosFilter?: { lmax: number; maxAspectRatio: number };
  // Plant-specific fields (for Helios plants)
  isPlant?: boolean;
  plantType?: string;
  plantAge?: number;
  plantPosition?: { x: number; y: number; z: number };  // Position for regeneration
  plantSeed?: number;  // Random seed for reproducible regeneration
  plantSessionId?: string;  // Session ID for stateful time-stepping (keeps plant consistent across ages)
  regenerationKey?: number;  // Counter that increments on each regeneration to force React remount
  heliosXml?: string;  // Plant structure XML for Helios simulation export
  plantMaterials?: PlantMaterialDef[];  // Materials with textures for plant rendering
  // Canopy-specific: grid dimensions when this plant mesh is a multi-plant canopy.
  // Drives the display name (e.g. "bean canopy 3×3 (30d)"); absent for single plants.
  plantCanopy?: { countX: number; countY: number; plantCount: number };
  // Voxel-specific: per-axis grid subdivision count for the PyHelios LiDAR grid.
  // Only set on shape-voxel meshes; renders as a wireframe overlay when any axis > 1.
  gridSubdivisions?: { x: number; y: number; z: number };
}

// Human-readable label for a triangulation method, used in the default mesh
// name and the provenance readout.
export const TRIANGULATION_METHOD_LABELS: Record<TriangulationMethod, string> = {
  ball_pivoting: 'Ball-pivoting',
  poisson: 'Poisson',
  alpha_shape: 'Alpha-shape',
  delaunay: 'Delaunay',
  helios: 'Helios',
};

// The label shown for a mesh in the scene list, delete confirm, and export panel.
// A user-assigned `name` wins; otherwise plants show type/age (or canopy grid),
// triangulated meshes show their method + "triangulation" + source filename
// (e.g. "Poisson triangulation (tree.xyz)", "Helios triangulation") — the word
// "triangulation" disambiguates a Helios *triangulation* mesh from a Helios
// *plant model* — and any other mesh falls back to its source filename, then a
// generic "Mesh".
// `sourceFileName` is the imported/triangulated source cloud's filename when known.
export function meshDisplayName(mesh: MeshEntry, sourceFileName?: string): string {
  if (mesh.name) return mesh.name;
  if (mesh.isPlant) {
    return mesh.plantCanopy
      ? `${mesh.plantType} canopy ${mesh.plantCanopy.countX}×${mesh.plantCanopy.countY} (${mesh.plantAge}d)`
      : `${mesh.plantType} (${mesh.plantAge}d)`;
  }
  // Meshes built by triangulation carry params; name them after the method so
  // they're distinguishable from imported OBJ meshes, plant models, and each other.
  if (mesh.triangulationParams) {
    const label = TRIANGULATION_METHOD_LABELS[mesh.method] ?? 'Triangulated';
    const base = `${label} triangulation`;
    return sourceFileName ? `${base} (${sourceFileName})` : base;
  }
  return sourceFileName || 'Mesh';
}

// Like meshDisplayName, but disambiguates auto-generated names that collide
// across the scene by appending " (2)", " (3)", … in list order. Only
// AUTO names participate: a user-renamed mesh (mesh.name set) keeps its exact
// text and never gets a suffix, nor does it bump the counter for others. The
// first mesh of a given auto-name stays bare; each later duplicate gets the
// next ordinal. Numbering is positional, so deleting an earlier duplicate
// renumbers the rest — acceptable since these are throwaway defaults the user
// can rename. `allMeshes` must be the full scene list in display order;
// `fileNameFor` resolves a mesh's source-cloud filename (or undefined).
export function meshDisplayNameFor(
  mesh: MeshEntry,
  allMeshes: MeshEntry[],
  fileNameFor: (m: MeshEntry) => string | undefined,
): string {
  const base = meshDisplayName(mesh, fileNameFor(mesh));
  // A user-assigned name is taken verbatim — no collision numbering.
  if (mesh.name) return base;
  // Count how many earlier auto-named meshes share this exact base name.
  let priorCollisions = 0;
  for (const m of allMeshes) {
    if (m.id === mesh.id) break;
    if (m.name) continue;  // manual names don't collide with autos
    if (meshDisplayName(m, fileNameFor(m)) === base) priorCollisions++;
  }
  return priorCollisions === 0 ? base : `${base} (${priorCollisions + 1})`;
}

// Skeleton data from extraction
export interface SkeletonData {
  points: Float32Array;  // x, y, z interleaved
  edges: number[][] | null;  // [[from_idx, to_idx], ...] - connections between points
  branchOrders: number[] | null;  // Branch order (Strahler number) for each point
  maxBranchOrder: number;  // Maximum branch order in the skeleton
  diameters: Float32Array | null;  // diameter at each point
  pointCount: number;
  totalLength: number;
}

// Skeleton entry with metadata
export interface SkeletonEntry {
  id: string;
  sourceCloudId: string;
  data: SkeletonData;
  visible: boolean;
  color: string;
}

// A built QSM (Quantitative Structure Model): cylinders + shoots + metrics from
// /api/qsm/build, plus per-entry display state. The cylinder/shoot/metrics shapes
// mirror the backend response types in utils/backendApi.ts.
export interface QSMEntry {
  id: string;
  // The scan this QSM is anchored to. For an aggregate QSM (fused from several
  // multi-view scans of one tree) this is the FIRST contributing scan, and
  // sourceLabel overrides the displayed name; visibility/lookup still resolve
  // through this id.
  sourceCloudId: string;
  // Display name override. Set for aggregate QSMs ("scanA + N more"); when
  // absent the results panel falls back to the source scan's fileName.
  sourceLabel?: string;
  // Raw backend response payload (cylinders, shoots, metrics, counts).
  cylinders: import('../utils/backendApi').QSMCylinder[];
  shoots: import('../utils/backendApi').QSMShoot[];
  metrics: import('../utils/backendApi').QSMMetrics | null;
  visible: boolean;
  // Phase-1 procedural foliage: leaves placed on the terminal shoots, as a
  // pre-flattened textured mesh (rendered via TexturedPlantMesh). Set once the
  // Add Leaves tool runs; absent until then.
  leaves?: {
    data: MeshData;
    plantMaterials?: PlantMaterialDef[];
    leafCount: number;
    // The originating Phase-1 placement request, kept so Phase 2 ("Adjust Leaf
    // Angles") can re-place the leaves identically before matching their angles
    // to a measured distribution. Absent for leaves placed before this field existed.
    request?: import('../utils/backendApi').QSMLeavesRequest;
  };
  leavesVisible?: boolean;
}

// A single voxel of a leaf-area-density result. center/size are world-space;
// lad is leaf area density (m²/m³); gtheta is the per-cell G-function;
// hitCount is how many points fell inside (0 = empty cell).
export interface LADVoxel {
  index: number;
  center: [number, number, number];
  size: [number, number, number];
  leafArea: number;   // m²
  lad: number;        // m²/m³
  gtheta: number;
  hitCount: number;
}

// A leaf-area-density result: a 3D grid of voxels each carrying an LAD scalar.
// Kept separate from MeshEntry (which is triangle/vertex oriented) — LAD is
// rendered as instanced translucent voxel cells colored by the shared colormap.
export interface LADResultEntry {
  id: string;
  sourceScanIds: string[];   // provenance: which scans produced it
  voxels: LADVoxel[];
  nx: number;
  ny: number;
  nz: number;
  bounds: { min: [number, number, number]; max: [number, number, number] };
  // Which Beer's-law weighting actually ran: 'single' (discrete) or 'multi'
  // (full-waveform, beams grouped + misses gap-filled). Derived from the
  // backend's authoritative detection, not the requested return type.
  returnMode: 'single' | 'multi';
  visible: boolean;
  color: string;             // fallback/solid swatch in the object list
  // Colorbar domain override; undefined => auto from the voxel LAD range.
  ladMinOverride?: number;
  ladMaxOverride?: number;
  hideEmpty: boolean;        // hide cells with lad<=0 / hitCount===0
  opacity: number;           // 0..1 cell translucency
}

// Color mapping modes
// 'per-scan' = each scan colored by its own swatch (the same color shown
// next to the scan in the side panel). Implemented internally as a 'single'
// render with a different singleColor per cloud. Default for newly loaded
// scans since it tells you at a glance which points came from which scanner.
export type ColorMode = 'x' | 'y' | 'height' | 'intensity' | 'rgb' | 'single' | 'per-scan' | 'scalar';

// Shape types for shape creator
export type ShapeType = 'voxel' | 'cylinder' | 'sphere' | 'cone';

// Filter range for a single field. Continuous fields use [min, max]; a
// categorical field (e.g. ground_class / tree_instance) instead sets
// `selectedClasses` — the integer class ids to KEEP — and the backend filters by
// set membership rather than a range. min/max still carry the field's full
// extent so a disabled/cleared filter has sensible bounds.
export interface FilterRange {
  min: number;
  max: number;
  enabled: boolean;
  selectedClasses?: number[];
}

// All filters for a point cloud
export interface CloudFilters {
  x: FilterRange;
  y: FilterRange;
  z: FilterRange;
  intensity?: FilterRange;
  scalarFields: Record<string, FilterRange>;
}
