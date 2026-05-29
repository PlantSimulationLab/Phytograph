// Shared type definitions for the point-cloud viewer. These were originally
// declared inside PointCloudViewer.tsx; they live here so the viewer, its
// extracted leaf components (components/viewer/**), and the lib parsers can all
// import them without a components → lib cycle. Pure types only — no runtime
// code, so importing this module has zero side effects.
import * as THREE from 'three';
import type { BackendPointSource, TriangulationMethod } from '../utils/backendApi';

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
  asciiFormat?: string | null; // Helios <ASCII_format> hint, when known
  // Optional per-attribute min/max from PotreeConverter's metadata.
  // Keyed by attribute name ("intensity", "rgb", "classification", …).
  // The OctreePointCloud material effect uses these to set the shader's
  // heightMin/Max + intensityRange uniforms — without them the gradient
  // lookups all hit the same texel and the cloud renders solid colour.
  attributeRanges?: Record<string, { min: number[]; max: number[] }>;
}

// Result of buildPointSource: either an in-memory cloud (flat path) or a
// backend source descriptor (octree path). Downstream-op handlers branch on
// `kind`. The `source` shape is the BackendPointSource fields the renderer
// fills in (the per-op `max_points`/`want_colors` are added at the call site).
export type PointSourcePayload =
  | { kind: 'inline'; data: PointCloudData }
  | { kind: 'source'; source: Pick<BackendPointSource, 'source_path' | 'ascii_format' | 'translation'> };

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
}

// Per-cloud edit state. The crop region is no longer per-cloud — it
// lives at the viewer level so a single crop applies uniformly across
// every selected scan (see CropRegion / cropRegion state below).
export interface CloudEditState {
  translation: { x: number; y: number; z: number };
  erasedIndices: Set<number>;  // Set of erased point indices
}

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
}

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
  // Voxel-specific: per-axis grid subdivision count for the PyHelios LiDAR grid.
  // Only set on shape-voxel meshes; renders as a wireframe overlay when any axis > 1.
  gridSubdivisions?: { x: number; y: number; z: number };
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

// Color mapping modes
// 'per-scan' = each scan colored by its own swatch (the same color shown
// next to the scan in the side panel). Implemented internally as a 'single'
// render with a different singleColor per cloud. Default for newly loaded
// scans since it tells you at a glance which points came from which scanner.
export type ColorMode = 'x' | 'y' | 'height' | 'intensity' | 'rgb' | 'single' | 'per-scan' | 'scalar';

// Shape types for shape creator
export type ShapeType = 'voxel' | 'cylinder' | 'sphere' | 'cone';

// Filter range for a single field
export interface FilterRange {
  min: number;
  max: number;
  enabled: boolean;
}

// All filters for a point cloud
export interface CloudFilters {
  x: FilterRange;
  y: FilterRange;
  z: FilterRange;
  intensity?: FilterRange;
  scalarFields: Record<string, FilterRange>;
}
