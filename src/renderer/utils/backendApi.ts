// ==================== SHARED POINT SOURCE ====================

/**
 * Tells a downstream endpoint to read points from a file on disk instead of
 * an inline `points` array. Octree-backed clouds keep no positions in the
 * renderer (geometry lives only in the on-disk octree), so skeleton /
 * triangulate / c2m / icp / export send this and the backend reads the
 * original source file — mirrors the M3 crop path. Matches the backend
 * `PointSource` Pydantic model.
 */
export interface BackendPointSource {
  source_path: string;
  ascii_format?: string | null;
  max_points?: number | null;     // stride-downsample cap; omit/null = full res
  translation?: [number, number, number] | null;  // ADDED to every point
  want_colors?: boolean;
  // When set, points come from a live cloud session's in-RAM array with its
  // per-point deletions already applied — NOT from `source_path` on disk. This
  // is how downstream ops honor unbaked deletions without a rebuild. The
  // backend ignores `source_path` (kept for provenance) when this is present.
  session_id?: string | null;
}

// ==================== TRIANGULATION API ====================

export type TriangulationMethod = 'ball_pivoting' | 'poisson' | 'alpha_shape' | 'delaunay' | 'helios';

export interface TriangulationRequest {
  points?: number[][];  // [[x, y, z], ...] — omit when `source` is set
  source?: BackendPointSource;  // octree-backed clouds read from disk
  method: TriangulationMethod;
  // Ball pivoting parameters
  radii?: number[];
  // Poisson parameters
  depth?: number;
  // Alpha shape parameters
  alpha?: number;
  // General parameters
  estimate_normals?: boolean;
  normal_radius?: number;
  normal_max_nn?: number;
}

export interface TriangulationResponse {
  success: boolean;
  vertices: number[][];
  triangles: number[][];
  normals?: number[][];
  surface_area?: number;
  num_triangles: number;
  num_vertices: number;
  method_used: string;
  error?: string;
  points_used?: number;  // input points actually triangulated (octree cap may downsample)
}

import { BACKEND_PORT_PROD } from '../../shared/constants';

/**
 * Get the backend API base URL.
 * The bundled PyInstaller backend always listens on BACKEND_PORT_PROD —
 * in dev, main.ts supervises the same binary on the same port.
 */
export function getBackendUrl(): string {
  return `http://127.0.0.1:${BACKEND_PORT_PROD}`;
}

/**
 * Turn a raw fetch rejection into an actionable message. `fetch` rejects with a
 * bare `TypeError: Failed to fetch` when the connection never completes — the
 * backend is down, still starting, or crashed mid-response (a 500 that resets
 * the socket before the body is sent). That message tells the user nothing, so
 * we rewrite it; genuine HTTP-status errors (which we throw ourselves with the
 * backend's `detail`) pass through untouched.
 */
export function describeBackendError(error: unknown, action: string): Error {
  if (error instanceof Error) {
    const isConnectionFailure =
      error.name === 'TypeError' ||
      /failed to fetch|networkerror|load failed|connection/i.test(error.message);
    if (isConnectionFailure) {
      return new Error(
        `${action} failed: could not reach the backend (it may still be starting, ` +
          `or it crashed processing this file). Check the backend status and try again.`,
      );
    }
    if (error.name === 'AbortError') {
      return new Error(`${action} timed out. The file may be too large, or the backend is stuck.`);
    }
    return error;
  }
  return new Error(`${action} failed: ${String(error)}`);
}

/**
 * Send triangulation request to backend API
 */
export async function triangulatePointCloud(
  request: TriangulationRequest
): Promise<TriangulationResponse> {
  const baseUrl = getBackendUrl();

  try {
    const response = await fetch(`${baseUrl}/api/triangulate`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(request),
    });

    if (!response.ok) {
      const errorData = await response.json().catch(() => ({}));
      throw new Error(errorData.detail || `HTTP ${response.status}: ${response.statusText}`);
    }

    return await response.json();
  } catch (error) {
    console.error('Triangulation request failed:', error);
    throw error;
  }
}

// ==================== GROUND SEGMENTATION API ====================

/**
 * Classify a point cloud into ground (1) and plant (2) points via the Cloth
 * Simulation Filter. Send inline `points` for flat clouds or a `source`
 * descriptor for octree-backed clouds (the backend re-reads the file at full
 * resolution; labels align 1:1 with the resolved point order). The CSF defaults
 * are tuned for close-range plant scans, not airborne LiDAR.
 */
export interface GroundSegmentationRequest {
  points?: number[][];          // [[x, y, z], ...] — omit when `source` is set
  source?: BackendPointSource;  // octree-backed clouds read from disk
  cloth_resolution?: number;
  rigidness?: number;
  class_threshold?: number;
  iterations?: number;
  slope_smooth?: boolean;
}

export interface GroundSegmentationResponse {
  success: boolean;
  labels: number[];   // 1=ground, 2=plant, aligned to resolved point order
  num_ground: number;
  num_plant: number;
  num_points: number;
  error?: string;
}

export async function segmentGround(
  request: GroundSegmentationRequest
): Promise<GroundSegmentationResponse> {
  const baseUrl = getBackendUrl();
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), 300000); // 5 minutes

  try {
    const response = await fetch(`${baseUrl}/api/segment/ground`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(request),
      signal: controller.signal,
    });
    clearTimeout(timeoutId);
    if (!response.ok) {
      const errorData = await response.json().catch(() => ({}));
      throw new Error(errorData.detail || `HTTP ${response.status}: ${response.statusText}`);
    }
    return await response.json();
  } catch (error) {
    clearTimeout(timeoutId);
    console.error('Ground segmentation failed:', error);
    throw error;
  }
}

// ==================== TREE INSTANCE SEGMENTATION API ====================

/**
 * Segment a multi-tree point cloud into per-point tree instance ids via TreeIso
 * (cut-pursuit graph method, CPU-only). Send inline `points` for flat clouds or
 * a `source` descriptor for octree-backed clouds (full resolution; labels align
 * 1:1 with the resolved point order). Labels are 0 = unassigned, 1..N = trees.
 * TreeIso expects ground-removed input — `ground_warning` flags a likely
 * un-removed ground surface. Optional `seed_points` ([[x,y,z], ...]) are trunk
 * seeds for human-in-the-loop: each seed yields exactly one tree.
 */
export interface TreeSegmentationRequest {
  points?: number[][];          // [[x, y, z], ...] — omit when `source` is set
  source?: BackendPointSource;  // octree-backed clouds read from disk
  seed_points?: number[][];     // [[x, y, z], ...] trunk seeds (HITL)
  // TreeIso parameters (defaults match the backend / Xi & Hopkinson 2022).
  reg_strength1?: number;
  min_nn1?: number;
  decimate_res1?: number;
  reg_strength2?: number;
  min_nn2?: number;
  decimate_res2?: number;
  max_gap?: number;
  rel_height_length_ratio?: number;
  vertical_weight?: number;
  min_nn3?: number;
  score_candidate_thresh?: number;
  init_stem_rel_length_thresh?: number;
  max_outlier_gap?: number;
}

export interface TreeSegmentationResponse {
  success: boolean;
  labels: number[];        // 0 = unassigned, 1..N = tree ids; aligned to input
  num_trees: number;
  num_points: number;
  ground_warning: boolean;
  error?: string;
}

export async function segmentTrees(
  request: TreeSegmentationRequest
): Promise<TreeSegmentationResponse> {
  const baseUrl = getBackendUrl();
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), 300000); // 5 minutes

  try {
    const response = await fetch(`${baseUrl}/api/segment/trees`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(request),
      signal: controller.signal,
    });
    clearTimeout(timeoutId);
    if (!response.ok) {
      const errorData = await response.json().catch(() => ({}));
      throw new Error(errorData.detail || `HTTP ${response.status}: ${response.statusText}`);
    }
    return await response.json();
  } catch (error) {
    clearTimeout(timeoutId);
    console.error('Tree segmentation failed:', error);
    throw error;
  }
}

// ==================== HELIOS TRIANGULATION API ====================

export interface HeliosScanEntry {
  file_path?: string;       // Path to scan file on disk (preferred for large scans)
  ascii_format?: string | null;  // Column format e.g. "x y z timestamp" (auto-detected if omitted/null)
  points?: number[][];      // [[x, y, z], ...] fallback when no file_path
  colors?: number[][];      // [[r, g, b], ...] point colors (0-1 range)
  origin: number[];         // [x, y, z] scanner position
  // Per-scan acquisition geometry from the scan's own ScanParameters. Helios
  // triangulates each scan in its scanner-angular (theta, phi) grid, so these
  // describe how it was actually sampled. Omit to let the backend fall back to
  // request-level angles and a count-based grid estimate.
  n_theta?: number;         // Zenith samples (Ntheta)
  n_phi?: number;           // Azimuth samples (Nphi)
  theta_min?: number;       // Zenith angle min (degrees)
  theta_max?: number;       // Zenith angle max (degrees)
  phi_min?: number;         // Azimuth angle min (degrees)
  phi_max?: number;         // Azimuth angle max (degrees)
}

// An explicit triangulation grid derived from a voxel box in the viewer:
// center/size are the box's world transform; nx/ny/nz its cell subdivisions.
export interface HeliosGrid {
  center: [number, number, number];
  size: [number, number, number];
  nx: number;
  ny: number;
  nz: number;
}

export interface HeliosTriangulationRequest {
  scans: HeliosScanEntry[];
  lmax: number;              // Maximum triangle edge length
  max_aspect_ratio: number;  // Maximum triangle aspect ratio (default 4.0)
  // Request-level angular fallbacks for scans that don't carry their own.
  theta_min: number;         // Zenith angle min (degrees, default 30)
  theta_max: number;         // Zenith angle max (degrees, default 130)
  phi_min: number;           // Azimuth angle min (degrees, default 0)
  phi_max: number;           // Azimuth angle max (degrees, default 360)
  // Explicit grid from a voxel box. When omitted, the backend auto-creates a
  // single-cell grid over all points and sets grid_warning on the response.
  grid?: HeliosGrid;
}

export interface HeliosTriangulationResponse {
  success: boolean;
  vertices: number[][];
  triangles: number[][];
  colors?: number[][];      // Per-vertex RGB colors (0-1 range)
  normals?: number[][];
  surface_area?: number;
  num_triangles: number;
  num_vertices: number;
  method_used: string;
  error?: string;
  // Source scan index for each triangle (aligned 1:1 with `triangles`), so the
  // viewer can color triangles by the scan they came from.
  triangle_scan_ids?: number[];
  // Set when no grid box was supplied and all points were triangulated within
  // their bounding box; grid_message is the human-readable warning to surface.
  grid_warning?: boolean;
  grid_message?: string | null;
}

/**
 * Send Helios triangulation request to backend API.
 * Uses PyHelios LiDARCloud spherical hull triangulation.
 */
export async function heliosTriangulate(
  request: HeliosTriangulationRequest,
  signal?: AbortSignal,
): Promise<HeliosTriangulationResponse> {
  const baseUrl = getBackendUrl();
  console.log('Helios triangulation - scans:', request.scans.length, 'Lmax:', request.lmax);

  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), 600000); // 10 minutes

  // Forward external abort signal to our controller
  if (signal) {
    signal.addEventListener('abort', () => controller.abort());
  }

  try {
    const response = await fetch(`${baseUrl}/api/triangulate/helios`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(request),
      signal: controller.signal,
    });

    clearTimeout(timeoutId);

    if (!response.ok) {
      const errorData = await response.json().catch(() => ({}));
      throw new Error(errorData.detail || `HTTP ${response.status}: ${response.statusText}`);
    }

    return await response.json();
  } catch (error) {
    clearTimeout(timeoutId);
    console.error('Helios triangulation failed:', error);
    throw error;
  }
}

// ==================== LEAF AREA DENSITY (LAD) API ====================
// Per-voxel leaf area density (m²/m³). The triangulation (Lmax/aspect) only
// supplies the G-function; Helios traces beam paths through the voxel grid and
// inverts Beer's law per voxel. The grid is REQUIRED (unlike triangulation).

// A scan for LAD: same as HeliosScanEntry plus the return type (single- vs
// multi-return changes the backend weighting algorithm).
export interface LADScanEntry extends HeliosScanEntry {
  return_type?: 'single' | 'multi';
  beam_exit_diameter?: number;   // meters (multi-return only)
  beam_divergence?: number;      // milliradians (multi-return only)
  // Point-data source for LAD (see backend HeliosScanEntry). A session-backed
  // cloud passes session_id (the backend dumps its surviving in-RAM points +
  // any multi-return columns). A flat in-RAM cloud (e.g. a synthetic
  // full-waveform scan) passes points plus, for multi-return, the aligned
  // per-pulse columns in scalar_columns (timestamp/target_index/target_count).
  session_id?: string | null;
  scalar_columns?: Record<string, number[]>;
}

export interface LADRequest {
  scans: LADScanEntry[];
  grid: HeliosGrid;              // REQUIRED — the LAD voxel grid
  lmax: number;                 // max triangle edge length (G-function)
  max_aspect_ratio: number;     // max triangle aspect ratio
  min_voxel_hits: number;       // min ray hits for a voxel to be solved
  // Request-level angular fallbacks (degrees) for scans lacking their own.
  theta_min: number;
  theta_max: number;
  phi_min: number;
  phi_max: number;
}

export interface LADVoxelResult {
  index: number;
  center: [number, number, number];
  size: [number, number, number];
  leaf_area: number;   // m²
  lad: number;         // m²/m³
  gtheta: number;      // G(theta)
  hit_count: number;
}

export interface LADResponse {
  success: boolean;
  cells: LADVoxelResult[];
  nx: number;
  ny: number;
  nz: number;
  grid_center: number[];
  grid_size: number[];
  bounds: number[][];          // [[lo...], [hi...]]
  is_multi_return: boolean;
  return_mode: string;         // "single" | "multi"
  total_leaf_area: number;
  method_used: string;
  warnings: string[];
  error?: string;
}

/**
 * Compute per-voxel leaf area density via the PyHelios LiDAR plugin.
 * Mirrors heliosTriangulate: long timeout, StreamingResponse body parsed as JSON.
 */
export async function computeLAD(
  request: LADRequest,
  signal?: AbortSignal,
): Promise<LADResponse> {
  const baseUrl = getBackendUrl();
  console.log('LAD compute - scans:', request.scans.length,
    'grid:', `${request.grid.nx}×${request.grid.ny}×${request.grid.nz}`);

  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), 600000); // 10 minutes

  if (signal) {
    signal.addEventListener('abort', () => controller.abort());
  }

  try {
    const response = await fetch(`${baseUrl}/api/lad/compute`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(request),
      signal: controller.signal,
    });

    clearTimeout(timeoutId);

    if (!response.ok) {
      const errorData = await response.json().catch(() => ({}));
      throw new Error(errorData.detail || `HTTP ${response.status}: ${response.statusText}`);
    }

    return await response.json();
  } catch (error) {
    clearTimeout(timeoutId);
    console.error('LAD computation failed:', error);
    throw error;
  }
}

// ==================== SKELETON EXTRACTION API (BFS Graph-Based Algorithm) ====================
// Based on Li et al. 2017 "An Automatic Tree Skeleton Extracting Method"

export type DominantAxis = 'x' | 'y' | 'z';

export interface SkeletonRequest {
  points?: number[][];  // [[x, y, z], ...] — omit when `source` is set
  source?: BackendPointSource;  // octree-backed clouds read from disk

  // Pre-processing options
  remove_outliers?: boolean;  // Statistical outlier removal (default: true)
  outlier_nb_neighbors?: number;  // Neighbors for outlier detection (default: 20)
  outlier_std_ratio?: number;  // Std deviation threshold (default: 2.0)

  // Graph building parameters (BFS algorithm)
  search_radius?: number;  // Radius for KD-tree neighbor search (default: 0.05)
  max_neighbors?: number;  // Maximum neighbors per point (default: 20)

  // Root detection
  root_threshold?: number;  // Height threshold for root set selection (default: 0.02)

  // Quantization parameters
  quantization_levels?: number;  // Number of quantization intervals (default: 60)
  use_nonlinear_quantization?: boolean;  // Use sqrt scaling (default: true)

  // Filtering parameters
  threshold_filter?: number;  // Minimum points per block (default: 30)
  use_proportion_filter?: boolean;  // Use parent/child ratio filter (default: true)
  proportion_threshold?: number;  // Min ratio of child to parent block (default: 0.1)

  // Smoothing
  smooth_skeleton?: boolean;  // Apply Laplace smoothing (default: true)
  smoothing_iterations?: number;  // Number of smoothing passes (default: 2)

  // Legacy parameters (for API compatibility)
  dominant_axis?: DominantAxis;  // Not used in BFS algorithm
}

export interface SkeletonBlock {
  block_id: number;
  center: number[];  // [x, y, z] centroid (skeleton node)
  quantized_level: number;  // BFS level after quantization
  num_points: number;  // Number of points in block
  parent_block_id?: number;  // Parent block ID
  child_block_ids?: number[];  // Child block IDs
}

export interface SkeletonResponse {
  success: boolean;
  // Skeleton data - ordered from root to tips
  skeleton_points: number[][];  // [[x, y, z], ...] skeleton nodes
  skeleton_edges?: number[][];  // [[from_idx, to_idx], ...] connections
  branch_orders?: number[];  // Branch order (Strahler number) for each node
  // Metrics
  total_length: number | null;  // Total skeleton length
  num_nodes: number;  // Number of skeleton nodes
  num_edges?: number;  // Number of skeleton edges
  num_branches?: number;  // Number of branch points (nodes with >2 connections)
  max_branch_order?: number;  // Maximum branch order in the skeleton
  // Block info (optional detailed output)
  blocks?: SkeletonBlock[];
  // Processing info
  points_before_filtering: number | null;
  points_after_filtering: number | null;
  num_blocks_before_filter?: number;
  num_blocks_after_filter?: number;
  // Legacy fields for API compatibility
  dominant_axis: string;
  slice_thickness?: number;
  num_slices?: number;  // Alias for num_nodes
  diameters?: number[] | null;
  error?: string;
}

/**
 * Extract skeleton from a stem point cloud
 */
export async function extractSkeleton(
  request: SkeletonRequest
): Promise<SkeletonResponse> {
  const baseUrl = getBackendUrl();
  console.log('Skeleton extraction - baseUrl:', baseUrl, 'points:', request.points?.length ?? `source:${request.source?.source_path}`);

  // Use AbortController for 5 minute timeout (skeleton extraction can be slow)
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), 300000); // 5 minutes

  try {
    const response = await fetch(`${baseUrl}/api/skeleton/extract`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(request),
      signal: controller.signal,
    });

    clearTimeout(timeoutId);

    if (!response.ok) {
      const errorData = await response.json().catch(() => ({}));
      throw new Error(errorData.detail || `HTTP ${response.status}: ${response.statusText}`);
    }

    return await response.json();
  } catch (error) {
    clearTimeout(timeoutId);
    console.error('Skeleton extraction failed:', error);
    throw error;
  }
}

// ==================== PLANT MODEL GENERATION API ====================
// Uses pyhelios3d PlantArchitecture to generate procedural plant models

export interface PlantGenerationRequest {
  plant_type: string;  // Plant model name from library (e.g., 'bean', 'maize', 'tomato')
  age: number;  // Age in days
  position_x?: number;
  position_y?: number;
  position_z?: number;
  // Advanced parameters (optional)
  random_seed?: number;  // Random seed for reproducibility
}

export interface PlantCanopyRequest {
  plant_type: string;  // Plant model name from library
  age: number;         // Age of all plants in days
  center_x?: number;   // Canopy center (meters)
  center_y?: number;
  center_z?: number;
  spacing_x?: number;  // Spacing between plants in x (meters)
  spacing_y?: number;  // Spacing between plants in y (meters)
  count_x?: number;    // Plants in x
  count_y?: number;    // Plants in y
  germination_rate?: number;  // Probability (0-1) each grid position is filled
  // Advanced parameters (optional)
  random_seed?: number;  // Random seed for reproducibility
}

export interface PlantMaterial {
  name: string;
  color?: number[];  // [r, g, b] ambient/diffuse color (0-1 range)
  texture_name?: string;  // Name of texture in textures dict
  has_alpha: boolean;  // Whether texture has alpha transparency
}

export interface PlantMaterialGroup {
  material_name: string;
  triangle_indices: number[];  // Indices into the main indices array
}

export interface PlantGenerationResponse {
  success: boolean;
  vertices: number[][];  // [[x, y, z], ...]
  indices: number[][];   // [[v0, v1, v2], ...] triangle indices
  normals?: number[][];  // [[nx, ny, nz], ...]
  colors?: number[][];   // [[r, g, b], ...] vertex colors (0-1 range)
  // Texture support (OBJ export)
  uv_coordinates?: number[][];  // [[u, v], ...] per vertex
  materials?: PlantMaterial[];  // Material definitions
  material_groups?: PlantMaterialGroup[];  // Triangle-to-material mapping
  textures?: Record<string, string>;  // {texture_name: base64_png_data}
  vertex_count: number;
  triangle_count: number;
  plant_type: string;
  age: number;
  height?: number;
  available_models?: string[];
  helios_xml?: string;   // Plant structure XML for Helios simulation
  error?: string;
  // Retained session for age stepping (single-plant streaming builds)
  session_id?: string;
  // Canopy support (echoed back from /api/plant/canopy/generate)
  plant_count?: number;  // Total plants actually built (after germination)
  count_x?: number;      // Grid columns requested
  count_y?: number;      // Grid rows requested
  spacing_x?: number;    // Spacing used in x (meters)
  spacing_y?: number;    // Spacing used in y (meters)
}

/**
 * Get list of available plant models from pyhelios library
 */
export async function getAvailablePlantModels(): Promise<{ success: boolean; models: string[] }> {
  const baseUrl = getBackendUrl();

  try {
    const response = await fetch(`${baseUrl}/api/plant/models`, {
      method: 'GET',
    });

    if (!response.ok) {
      const errorData = await response.json().catch(() => ({}));
      throw new Error(errorData.detail || `HTTP ${response.status}: ${response.statusText}`);
    }

    return await response.json();
  } catch (error) {
    console.error('Failed to get plant models:', error);
    throw error;
  }
}

/**
 * Generate a procedural plant model using pyhelios PlantArchitecture
 */
export async function generatePlantModel(
  request: PlantGenerationRequest
): Promise<PlantGenerationResponse> {
  const baseUrl = getBackendUrl();
  console.log('Plant generation - baseUrl:', baseUrl, 'type:', request.plant_type, 'age:', request.age);

  // Use AbortController for 5 minute timeout (plant generation can be slow)
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), 300000); // 5 minutes

  try {
    const response = await fetch(`${baseUrl}/api/plant/generate`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(request),
      signal: controller.signal,
    });

    clearTimeout(timeoutId);

    if (!response.ok) {
      const errorData = await response.json().catch(() => ({}));
      throw new Error(errorData.detail || `HTTP ${response.status}: ${response.statusText}`);
    }

    return await response.json();
  } catch (error) {
    clearTimeout(timeoutId);
    console.error('Plant generation failed:', error);
    throw error;
  }
}

/**
 * Generate a canopy of regularly spaced plants using pyhelios PlantArchitecture.
 * Returns one merged mesh (same shape as generatePlantModel) for all plants.
 */
export async function generatePlantCanopy(
  request: PlantCanopyRequest
): Promise<PlantGenerationResponse> {
  const baseUrl = getBackendUrl();
  console.log(
    'Plant canopy - baseUrl:', baseUrl, 'type:', request.plant_type,
    'grid:', `${request.count_x}x${request.count_y}`, 'age:', request.age,
  );

  // Canopies build N plants, so allow the full 5 minute timeout.
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), 300000); // 5 minutes

  try {
    const response = await fetch(`${baseUrl}/api/plant/canopy/generate`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(request),
      signal: controller.signal,
    });

    clearTimeout(timeoutId);

    if (!response.ok) {
      const errorData = await response.json().catch(() => ({}));
      throw new Error(errorData.detail || `HTTP ${response.status}: ${response.statusText}`);
    }

    return await response.json();
  } catch (error) {
    clearTimeout(timeoutId);
    console.error('Plant canopy generation failed:', error);
    throw error;
  }
}

/**
 * A single plant or a canopy build, streamed with progress (SSE). The viewer
 * uses this so large canopies (and single plants) report a live progress bar.
 */
export type PlantStreamPayload =
  | { mode: 'single'; request: PlantGenerationRequest }
  | { mode: 'canopy'; request: PlantCanopyRequest };

/**
 * Generate a plant or canopy via the SSE endpoint, reporting progress through
 * `onProgress(fraction 0-1, message)`. Resolves with the final
 * PlantGenerationResponse (single plants include a session_id). Pass an
 * AbortSignal to cancel a long build.
 */
export async function generatePlantStreaming(
  payload: PlantStreamPayload,
  onProgress: (progress: number, message: string) => void,
  signal?: AbortSignal,
): Promise<PlantGenerationResponse> {
  const baseUrl = getBackendUrl();
  // The stream request flattens mode + the relevant fields; the backend reads
  // the subset it needs per mode.
  const body = { mode: payload.mode, ...payload.request };

  const response = await fetch(`${baseUrl}/api/plant/generate/stream`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
    signal,
  });

  if (!response.ok || !response.body) {
    const errorData = await response.json().catch(() => ({}));
    throw new Error(errorData.detail || `HTTP ${response.status}: ${response.statusText}`);
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });

      // SSE frames are separated by a blank line ("\n\n").
      let boundary: number;
      while ((boundary = buffer.indexOf('\n\n')) !== -1) {
        const frame = buffer.slice(0, boundary);
        buffer = buffer.slice(boundary + 2);

        let eventType = 'message';
        let data = '';
        for (const line of frame.split('\n')) {
          if (line.startsWith('event:')) eventType = line.slice(6).trim();
          else if (line.startsWith('data:')) data = line.slice(5).trim();
        }
        if (!data) continue;

        if (eventType === 'progress') {
          const parsed = JSON.parse(data);
          onProgress(parsed.progress, parsed.message);
        } else if (eventType === 'result') {
          return JSON.parse(data) as PlantGenerationResponse;
        } else if (eventType === 'error') {
          const parsed = JSON.parse(data);
          throw new Error(parsed.detail || 'Plant generation failed');
        }
      }
    }
  } finally {
    reader.cancel().catch(() => {});
  }

  throw new Error('Stream ended without a result');
}

// ==================== PLANT SESSION API (Age Stepping) ====================

export interface PlantSessionCreateRequest {
  plant_type: string;
  initial_age: number;
  position_x?: number;
  position_y?: number;
  position_z?: number;
  random_seed?: number;
}

export interface PlantSessionCreateResponse {
  success: boolean;
  session_id?: string;
  plant_type: string;
  current_age: number;
  height?: number;
  helios_xml?: string;
  error?: string;
}

export interface PlantSessionAdvanceRequest {
  dt: number;  // Days to advance
}

export interface PlantSessionAdvanceResponse {
  success: boolean;
  session_id: string;
  previous_age: number;
  current_age: number;
  height?: number;
  vertices: number[][];
  indices: number[][];
  colors?: number[][];
  // Texture data (real Helios UVs, V-flipped) so session-generated plants
  // render textured, matching /api/plant/generate.
  normals?: number[][];
  uv_coordinates?: number[][];
  materials?: PlantMaterial[];
  material_groups?: PlantMaterialGroup[];
  textures?: Record<string, string>;
  vertex_count: number;
  triangle_count: number;
  error?: string;
}

export interface PlantSessionStatusResponse {
  success: boolean;
  session_id: string;
  plant_type: string;
  current_age: number;
  height?: number;
  error?: string;
}

/**
 * Create a new plant session for incremental growth simulation
 */
export async function createPlantSession(
  request: PlantSessionCreateRequest
): Promise<PlantSessionCreateResponse> {
  const baseUrl = getBackendUrl();
  console.log('Creating plant session:', request.plant_type, 'initial_age:', request.initial_age);

  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), 60000);

  try {
    const response = await fetch(`${baseUrl}/api/plant/session/create`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(request),
      signal: controller.signal,
    });

    clearTimeout(timeoutId);

    if (!response.ok) {
      const errorData = await response.json().catch(() => ({}));
      throw new Error(errorData.detail || `HTTP ${response.status}: ${response.statusText}`);
    }

    return await response.json();
  } catch (error) {
    clearTimeout(timeoutId);
    console.error('Plant session creation failed:', error);
    throw error;
  }
}

/**
 * Advance time for a plant session and get updated geometry
 */
export async function advancePlantSession(
  sessionId: string,
  dt: number
): Promise<PlantSessionAdvanceResponse> {
  const baseUrl = getBackendUrl();
  console.log('Advancing plant session:', sessionId, 'dt:', dt);

  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), 60000);

  try {
    const response = await fetch(`${baseUrl}/api/plant/session/${sessionId}/advance`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ dt }),
      signal: controller.signal,
    });

    clearTimeout(timeoutId);

    if (!response.ok) {
      const errorData = await response.json().catch(() => ({}));
      throw new Error(errorData.detail || `HTTP ${response.status}: ${response.statusText}`);
    }

    return await response.json();
  } catch (error) {
    clearTimeout(timeoutId);
    console.error('Plant session advance failed:', error);
    throw error;
  }
}

/**
 * Get the status of a plant session
 */
export async function getPlantSessionStatus(
  sessionId: string
): Promise<PlantSessionStatusResponse> {
  const baseUrl = getBackendUrl();

  const response = await fetch(`${baseUrl}/api/plant/session/${sessionId}`, {
    method: 'GET',
  });

  if (!response.ok) {
    const errorData = await response.json().catch(() => ({}));
    throw new Error(errorData.detail || `HTTP ${response.status}: ${response.statusText}`);
  }

  return await response.json();
}

/**
 * Delete a plant session and free resources
 */
export async function deletePlantSession(sessionId: string): Promise<{ success: boolean }> {
  const baseUrl = getBackendUrl();
  console.log('Deleting plant session:', sessionId);

  const response = await fetch(`${baseUrl}/api/plant/session/${sessionId}`, {
    method: 'DELETE',
  });

  if (!response.ok) {
    const errorData = await response.json().catch(() => ({}));
    throw new Error(errorData.detail || `HTTP ${response.status}: ${response.statusText}`);
  }

  return await response.json();
}

// ==================== PLANT MORPH API ====================
// XML-based approach: parse the plant structure XML from a generated plant,
// expose its per-phytomer parameters for tuning, then rebuild via readPlantStructureXML.

export interface PlantMorphPhytomer {
  internode: Record<string, string>;
  petioles: Array<{
    leaves: Array<Record<string, string>>;
    [key: string]: string | Array<Record<string, string>>;
  }>;
}

export interface PlantMorphShoot {
  shoot_id: number;
  shoot_type_label: string;
  parent_shoot_id: number;
  parent_node_index: number;
  parent_petiole_index: number;
  base_rotation: string;
  phytomers: PlantMorphPhytomer[];
}

export interface DistributionParam {
  distribution: string;   // 'constant' | 'uniform' | 'normal' | 'weibull'
  parameters: number[];   // e.g. [0.025] for constant, [40.0, 60.0] for uniform
}

export interface PlantMorphParseResponse {
  success: boolean;
  plant_type: string;
  plant_age: number;
  base_position: string;
  shoots: PlantMorphShoot[];
  distribution_params: Record<string, Record<string, DistributionParam | boolean | Record<string, unknown>>>;
  error?: string;
}

export interface PlantMorphRequest {
  plant_type: string;
  helios_xml: string;
}

export interface PlantMorphResponse {
  success: boolean;
  session_id?: string;
  vertices: number[][];
  indices: number[][];
  colors?: number[][];
  normals?: number[][];
  uv_coordinates?: number[][];
  materials?: PlantMaterial[];
  material_groups?: PlantMaterialGroup[];
  textures?: Record<string, string>;
  vertex_count: number;
  triangle_count: number;
  current_age: number;
  height?: number;
  helios_xml?: string;
  error?: string;
}

/**
 * Parse a plant structure XML into editable parameters
 */
export async function parsePlantMorphParameters(
  heliosXml: string,
  plantType: string
): Promise<PlantMorphParseResponse> {
  const baseUrl = getBackendUrl();

  try {
    const response = await fetch(`${baseUrl}/api/plant/morph/parse`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ helios_xml: heliosXml, plant_type: plantType }),
    });

    if (!response.ok) {
      const errorData = await response.json().catch(() => ({}));
      throw new Error(errorData.detail || `HTTP ${response.status}: ${response.statusText}`);
    }

    return await response.json();
  } catch (error) {
    console.error('Failed to parse plant morph parameters:', error);
    throw error;
  }
}

/**
 * Morph/regrow a plant from modified structure XML
 */
export async function morphPlant(
  request: PlantMorphRequest
): Promise<PlantMorphResponse> {
  const baseUrl = getBackendUrl();
  console.log('Morphing plant:', request.plant_type);

  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), 300000); // 5 minutes

  try {
    const response = await fetch(`${baseUrl}/api/plant/morph`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(request),
      signal: controller.signal,
    });

    clearTimeout(timeoutId);

    if (!response.ok) {
      const errorData = await response.json().catch(() => ({}));
      throw new Error(errorData.detail || `HTTP ${response.status}: ${response.statusText}`);
    }

    return await response.json();
  } catch (error) {
    clearTimeout(timeoutId);
    console.error('Plant morph failed:', error);
    throw error;
  }
}

// ==================== SYNTHETIC LIDAR SCAN API ====================

// One mesh to load into the scannable scene (world-space coordinates — the
// renderer applies each mesh's scale/rotation/translation before sending).
export interface LidarScanMesh {
  vertices: number[][];  // [[x, y, z], ...]
  triangles: number[][];  // [[i, j, k], ...] - triangle vertex indices
  colors?: number[][];  // [[r, g, b], ...] - per-vertex colors (0-1 range)
}

// One scanner position + acquisition geometry (mirrors ScanParameters; angles
// stay in degrees and the backend converts to radians). `id` is the renderer's
// scan id — results come back keyed by it so each scanner's points attach to its
// own scan.
export interface LidarScanScanner {
  id: string;
  origin: number[];  // [x, y, z]
  n_theta: number;
  n_phi: number;
  theta_min_deg: number;
  theta_max_deg: number;
  phi_min_deg: number;
  phi_max_deg: number;
  return_type: 'single' | 'multi';
  exit_diameter_m: number;
  beam_divergence_mrad: number;
}

export interface LidarScanRequest {
  meshes: LidarScanMesh[];
  scanners: LidarScanScanner[];
  // Extra per-hit scalar fields to record beyond the standard set. Each is also a
  // column-format label, so the scan samples that named primitive data onto hits.
  extra_fields?: string[];
  rays_per_pulse?: number;  // full-waveform only (return_type === 'multi')
  pulse_distance_threshold?: number;  // full-waveform only (meters)
}

// Per-scanner scan result. `scalars` maps a field name (intensity, distance,
// timestamp, target_index, target_count, plus any extra_fields the engine
// recorded) to per-point values aligned 1:1 with `points`.
export interface LidarScanResult {
  scanner_id: string;
  points: number[][];  // [[x, y, z], ...]
  colors?: number[][] | null;  // [[r, g, b], ...] (0-1) or null when empty
  scalars: Record<string, number[]>;
  num_points: number;
}

export interface LidarScanResponse {
  success: boolean;
  results: LidarScanResult[];
  error?: string;
}

/**
 * Run a true ray-traced synthetic LiDAR scan via the PyHelios `lidar` plugin.
 *
 * Loads the supplied geometry into a Helios Context, adds one scan per scanner,
 * ray-traces the scene, and returns the resulting hit points as a point cloud.
 * Unlike random surface sampling, the output respects occlusion, scanner
 * position, field of view, and resolution.
 */
export async function runLidarScan(
  request: LidarScanRequest
): Promise<LidarScanResponse> {
  const baseUrl = getBackendUrl();
  console.log('LiDAR scan - meshes:', request.meshes.length, 'scanners:', request.scanners.length);

  // A high-resolution scan ray-traces Ntheta×Nphi rays per scanner; allow time.
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), 300000); // 5 minutes

  try {
    const response = await fetch(`${baseUrl}/api/lidar/scan`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(request),
      signal: controller.signal,
    });

    clearTimeout(timeoutId);

    if (!response.ok) {
      const errorData = await response.json().catch(() => ({}));
      throw new Error(errorData.detail || `HTTP ${response.status}: ${response.statusText}`);
    }

    return await response.json();
  } catch (error) {
    clearTimeout(timeoutId);
    console.error('LiDAR scan failed:', error);
    throw error;
  }
}

// ==================== POINT CLOUD LAS/LAZ IMPORT/EXPORT API ====================

export interface PointCloudExportRequest {
  points?: number[][];  // [[x, y, z], ...] — omit when `source` is set
  colors?: number[][];  // [[r, g, b], ...] in 0-1 range
  source?: BackendPointSource;  // octree-backed clouds export from disk
  // Flat clouds send 'las'/'laz' here (text formats are built in the renderer);
  // octree clouds may send any of these (the backend formats the text).
  format: 'las' | 'laz' | 'xyz' | 'txt' | 'csv' | 'ply' | 'obj';
  filename?: string;
}

export interface PointCloudExportResponse {
  success: boolean;
  data?: string;  // Base64-encoded file content
  filename: string;
  point_count: number;
  has_colors: boolean;
  format: string;
  error?: string;
}

export interface PointCloudImportResponse {
  success: boolean;
  points?: number[][];  // [[x, y, z], ...]
  colors?: number[][];  // [[r, g, b], ...] in 0-1 range
  point_count: number;
  has_colors: boolean;
  filename?: string;
  error?: string;
}

/**
 * Export a point cloud to LAS or LAZ format via the backend.
 * Uses laspy with lazrs for efficient LAZ compression.
 */
export async function exportPointCloudLasLaz(
  request: PointCloudExportRequest
): Promise<PointCloudExportResponse> {
  const baseUrl = getBackendUrl();
  console.log('Point cloud export -', request.points ? `${request.points.length} points` : `source:${request.source?.source_path}`, 'format:', request.format);

  // Use AbortController for timeout
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), 120000); // 2 minutes

  try {
    const response = await fetch(`${baseUrl}/api/pointcloud/export`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(request),
      signal: controller.signal,
    });

    clearTimeout(timeoutId);

    if (!response.ok) {
      const errorData = await response.json().catch(() => ({}));
      throw new Error(errorData.detail || `HTTP ${response.status}: ${response.statusText}`);
    }

    return await response.json();
  } catch (error) {
    clearTimeout(timeoutId);
    console.error('LAS/LAZ export failed:', error);
    throw error;
  }
}

// Result of a path-based point-cloud import. Positions/colors/intensity are
// raw Float32Array slices from the backend's binary response; callers wrap
// them into PointCloudData.
export interface ImportPointCloudByPathResult {
  pointCount: number;
  positions: Float32Array;        // length = pointCount * 3
  colors: Float32Array | null;    // length = pointCount * 3 (0-1) when present
  intensity: Float32Array | null; // length = pointCount when present
}

// ==================== IMPORT WIZARD (preview + column plan) ====================

// One column's explicit import mapping, produced by the import wizard.
// `role` is a Helios token (x/y/z/r255/g255/b255/r/g/b/intensity/reflectance/
// skip) or the literal 'extra' for a carried scalar field. For 'extra' columns,
// `slug`/`label` set the on-disk attribute name + picker label (rename) and
// `categorical` marks it for discrete colouring. `index` is the 0-based source
// column position.
export interface ColumnPlanEntry {
  index: number;
  role: string;
  slug?: string | null;
  label?: string | null;
  categorical?: boolean;
}

// Explicit column layout for an XYZ-family file. When attached to an import,
// it fully overrides backend auto-detection. `rgbIs255` records whether r/g/b
// are 0-255 ints (true) or 0-1 floats (false). ASCII formats only.
export interface ColumnPlan {
  columns: ColumnPlanEntry[];
  rgbIs255: boolean;
}

// Serialise a ColumnPlan to the backend's snake_case request shape.
export function columnPlanToPayload(plan: ColumnPlan): {
  columns: Array<{ index: number; role: string; slug: string | null; label: string | null; categorical: boolean }>;
  rgb_is_255: boolean;
} {
  return {
    columns: plan.columns.map((c) => ({
      index: c.index,
      role: c.role,
      slug: c.slug ?? null,
      label: c.label ?? null,
      categorical: !!c.categorical,
    })),
    rgb_is_255: plan.rgbIs255,
  };
}

export interface PreviewColumn {
  index: number;
  header_name: string | null;
  detected_role: string;          // x/y/z/r255/g255/b255/intensity/reflectance/extra/skip
  suggested_label: string;
  suggested_slug: string;
  type_hint: string;              // integer | float | categorical | empty
  remappable: boolean;            // true for ASCII; false for PLY/PCD/LAS
}

export interface PointCloudPreviewResponse {
  kind: string;                   // ascii | ply | pcd | las
  delimiter: string | null;       // comma | whitespace | tab | semicolon | null
  has_header: boolean;
  columns: PreviewColumn[];
  sample_rows: string[][];
  warning?: string | null;
}

// Cheaply inspect a point-cloud file for the import wizard. The backend reads
// only the header + a handful of rows and never 500s on a parse problem (it
// returns a 200 with `warning` and empty columns), so the wizard can always
// fall back to auto-detect.
export async function previewPointCloud(
  filePath: string,
  asciiFormat?: string | null,
  maxRows = 20,
): Promise<PointCloudPreviewResponse> {
  const baseUrl = getBackendUrl();
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), 60000);
  try {
    const response = await fetch(`${baseUrl}/api/pointcloud/preview`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        file_path: filePath,
        ascii_format: asciiFormat ?? null,
        max_rows: maxRows,
      }),
      signal: controller.signal,
    });
    clearTimeout(timeoutId);
    if (!response.ok) {
      const errorData = await response.json().catch(() => ({}));
      throw new Error(errorData.detail || `HTTP ${response.status}: ${response.statusText}`);
    }
    return (await response.json()) as PointCloudPreviewResponse;
  } catch (error) {
    clearTimeout(timeoutId);
    console.error('pointcloud preview failed:', error);
    throw describeBackendError(error, 'Preview');
  }
}

// Pulls a point-cloud file from disk via the backend rather than reading it
// into a string in the renderer (V8 caps strings at ~512 MB, which trips on
// multi-hundred-MB TLS scans). Backend dispatches by extension: XYZ-family
// via pandas (honours `asciiFormat`), PLY/PCD via open3d. `asciiFormat` is
// ignored on the PLY/PCD path.
export async function importPointCloudByPath(
  filePath: string,
  asciiFormat?: string | null,
  columnPlan?: ColumnPlan | null,
): Promise<ImportPointCloudByPathResult> {
  const baseUrl = getBackendUrl();
  // 10 minute timeout: a multi-GB scan takes tens of seconds to parse and
  // additional time to stream back. Matches the triangulation budget.
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), 600000);
  try {
    const response = await fetch(`${baseUrl}/api/pointcloud/import_by_path`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        file_path: filePath,
        ascii_format: asciiFormat ?? null,
        column_plan: columnPlan ? columnPlanToPayload(columnPlan) : null,
      }),
      signal: controller.signal,
    });
    clearTimeout(timeoutId);
    if (!response.ok) {
      // The endpoint returns JSON {detail: "..."} on error and octet-stream
      // on success — only try to parse JSON when the request actually failed.
      const errorData = await response.json().catch(() => ({}));
      throw new Error(errorData.detail || `HTTP ${response.status}: ${response.statusText}`);
    }
    const buf = await response.arrayBuffer();
    return decodePointCloudBinary(buf);
  } catch (error) {
    clearTimeout(timeoutId);
    console.error('Point-cloud by-path import failed:', error);
    throw describeBackendError(error, 'Import');
  }
}

// ==================== TEXTURED MESH IMPORT (OBJ + MTL) ====================

export interface MeshImportResponse {
  success: boolean;
  vertices: number[][];          // [[x, y, z], ...]
  indices: number[][];           // [[v0, v1, v2], ...]
  normals?: number[][];
  colors?: number[][];           // per-vertex colors (0-1)
  uv_coordinates?: number[][];   // [[u, v], ...] V-flipped for three.js
  materials?: PlantMaterial[];
  material_groups?: PlantMaterialGroup[];
  textures?: Record<string, string>;  // {basename: base64}
  vertex_count: number;
  triangle_count: number;
  filename?: string;
  has_textures: boolean;
  error?: string;
}

/**
 * Import a textured mesh (OBJ + sibling MTL + texture images) from a disk path.
 * The backend resolves the MTL and image files relative to the OBJ and returns
 * geometry, real per-vertex UVs, and base64 textures in the same shape the
 * textured renderer already consumes for plant models.
 */
export async function importTexturedMesh(filePath: string): Promise<MeshImportResponse> {
  const baseUrl = getBackendUrl();
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), 120000);
  try {
    const response = await fetch(`${baseUrl}/api/mesh/import`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ path: filePath }),
      signal: controller.signal,
    });
    clearTimeout(timeoutId);
    if (!response.ok) {
      const errorData = await response.json().catch(() => ({}));
      throw new Error(errorData.detail || `HTTP ${response.status}: ${response.statusText}`);
    }
    return await response.json();
  } catch (error) {
    clearTimeout(timeoutId);
    console.error('Textured mesh import failed:', error);
    throw error;
  }
}

// 32-byte header: 4s magic, I count, B has_colors, B has_intensity, 22x reserved.
const POINTCLOUD_BIN_HEADER_SIZE = 32;
const POINTCLOUD_BIN_MAGIC = 'PHX1';

function decodePointCloudBinary(buf: ArrayBuffer): ImportPointCloudByPathResult {
  if (buf.byteLength < POINTCLOUD_BIN_HEADER_SIZE) {
    throw new Error(`Binary response too short: ${buf.byteLength} bytes`);
  }
  const view = new DataView(buf);
  const magic = String.fromCharCode(view.getUint8(0), view.getUint8(1), view.getUint8(2), view.getUint8(3));
  if (magic !== POINTCLOUD_BIN_MAGIC) {
    throw new Error(`Unexpected binary magic: got "${magic}", want "${POINTCLOUD_BIN_MAGIC}"`);
  }
  const pointCount = view.getUint32(4, true);
  const hasColors = view.getUint8(8) === 1;
  const hasIntensity = view.getUint8(9) === 1;

  let offset = POINTCLOUD_BIN_HEADER_SIZE;
  const positions = new Float32Array(buf, offset, pointCount * 3);
  offset += pointCount * 3 * 4;

  let colors: Float32Array | null = null;
  if (hasColors) {
    colors = new Float32Array(buf, offset, pointCount * 3);
    offset += pointCount * 3 * 4;
  }

  let intensity: Float32Array | null = null;
  if (hasIntensity) {
    intensity = new Float32Array(buf, offset, pointCount);
    offset += pointCount * 4;
  }

  // Defensive: a short payload would silently truncate the typed-array view.
  // Re-check that the response covered everything we expected.
  if (offset > buf.byteLength) {
    throw new Error(`Binary response shorter than declared: expected ${offset} bytes, got ${buf.byteLength}`);
  }

  return { pointCount, positions, colors, intensity };
}

/**
 * Import a LAS or LAZ file via the backend.
 * Uses laspy with lazrs for LAZ decompression.
 */
export async function importPointCloudLasLaz(
  file: File
): Promise<PointCloudImportResponse> {
  const baseUrl = getBackendUrl();
  console.log('LAS/LAZ import - file:', file.name, 'size:', file.size);

  // Use AbortController for timeout
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), 120000); // 2 minutes

  try {
    const formData = new FormData();
    formData.append('file', file);

    const response = await fetch(`${baseUrl}/api/pointcloud/import`, {
      method: 'POST',
      body: formData,
      signal: controller.signal,
    });

    clearTimeout(timeoutId);

    if (!response.ok) {
      const errorData = await response.json().catch(() => ({}));
      throw new Error(errorData.detail || `HTTP ${response.status}: ${response.statusText}`);
    }

    return await response.json();
  } catch (error) {
    clearTimeout(timeoutId);
    console.error('LAS/LAZ import failed:', error);
    throw error;
  }
}

// ==================== ALIGNMENT DISTANCE API ====================

export interface AlignmentDistanceRequest {
  points?: number[];      // Flattened [x, y, z, ...] — omit when `source` is set
  source?: BackendPointSource;  // octree-backed clouds read from disk
  mesh_vertices: number[];  // Flattened [x, y, z, ...] mesh vertices
  mesh_indices: number[];   // Triangle indices [i, j, k, ...]
}

export interface AlignmentDistanceResponse {
  success: boolean;
  error?: string;
  mean_distance?: number;
  rmse?: number;
  std_deviation?: number;
  min_distance?: number;
  max_distance?: number;
  median_distance?: number;
  percentile_90?: number;
  percentile_95?: number;
  percentile_99?: number;
  points_within_1mm?: number;   // Percentage of points within 1mm
  points_within_5mm?: number;   // Percentage of points within 5mm
  points_within_10mm?: number;  // Percentage of points within 10mm
  point_count?: number;
}

/**
 * Compute alignment distance statistics.
 *
 * Calculates how well a point cloud fits a mesh by computing
 * the distance from each point to the nearest mesh surface.
 * Uses Open3D's RaycastingScene for efficient distance queries.
 */
export async function computeAlignmentDistance(
  request: AlignmentDistanceRequest
): Promise<AlignmentDistanceResponse> {
  const baseUrl = getBackendUrl();
  console.log('Alignment distance - points:', request.points ? request.points.length / 3 : `source:${request.source?.source_path}`, 'vertices:', request.mesh_vertices.length / 3);

  // Use AbortController for timeout (can be slow for large clouds)
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), 120000); // 2 minutes

  try {
    const response = await fetch(`${baseUrl}/api/c2m/distance`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(request),
      signal: controller.signal,
    });

    clearTimeout(timeoutId);

    if (!response.ok) {
      const errorData = await response.json().catch(() => ({}));
      throw new Error(errorData.detail || `HTTP ${response.status}: ${response.statusText}`);
    }

    return await response.json();
  } catch (error) {
    clearTimeout(timeoutId);
    console.error('Alignment distance computation failed:', error);
    throw error;
  }
}

// ==================== ICP REGISTRATION (SNAP TO FIT) API ====================

export interface ICPRegistrationRequest {
  points?: number[];         // Flattened [x, y, z, ...] (TARGET - stays fixed); omit when `source` is set
  source?: BackendPointSource;  // octree-backed TARGET cloud read from disk
  mesh_vertices: number[];   // Flattened [x, y, z, ...] mesh vertices (SOURCE - to be moved)
  mesh_indices: number[];    // Triangle indices [i, j, k, ...]
  max_correspondence_distance?: number;  // Optional max correspondence distance
  max_iterations?: number;   // Optional max iterations (default 50)
}

export interface ICPRegistrationResponse {
  success: boolean;
  error?: string;
  translation?: number[];         // [dx, dy, dz] translation to apply to mesh
  transformation_matrix?: number[]; // Full 4x4 transformation matrix (row-major)
  fitness?: number;               // Fitness score (0-1, higher is better)
  rmse?: number;                  // RMSE after alignment
}

/**
 * Perform ICP (Iterative Closest Point) registration to align a mesh to a point cloud.
 *
 * The point cloud is the TARGET (stays fixed), the mesh is the SOURCE (will be transformed).
 * Returns the transformation needed to "snap" the mesh to the cloud.
 * Uses Open3D's point-to-plane ICP for robust registration.
 */
export async function icpRegisterMeshToCloud(
  request: ICPRegistrationRequest
): Promise<ICPRegistrationResponse> {
  const baseUrl = getBackendUrl();
  console.log('ICP registration - points:', request.points ? request.points.length / 3 : `source:${request.source?.source_path}`, 'mesh vertices:', request.mesh_vertices.length / 3);

  // Use AbortController for timeout
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), 120000); // 2 minutes

  try {
    const response = await fetch(`${baseUrl}/api/c2m/icp-register`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(request),
      signal: controller.signal,
    });

    clearTimeout(timeoutId);

    if (!response.ok) {
      const errorData = await response.json().catch(() => ({}));
      throw new Error(errorData.detail || `HTTP ${response.status}: ${response.statusText}`);
    }

    return await response.json();
  } catch (error) {
    clearTimeout(timeoutId);
    console.error('ICP registration failed:', error);
    throw error;
  }
}

// ==================== CLOUD-TO-CLOUD ICP REGISTRATION API ====================

export interface CloudToCloudICPRequest {
  // Each side is flat inline points OR an octree source descriptor, resolved
  // independently so a flat and an octree cloud can be mixed (the source must
  // be flat in practice — its transform is baked renderer-side).
  target_points?: number[];     // Flattened [x, y, z, ...] target (stays fixed); omit when target_source is set
  source_points?: number[];     // Flattened [x, y, z, ...] source (to be moved); omit when source_source is set
  target_source?: BackendPointSource;  // octree-backed target read from disk
  source_source?: BackendPointSource;  // octree-backed source read from disk
  max_correspondence_distance?: number;  // Optional max correspondence distance
  max_iterations?: number;     // Optional max iterations (default 50)
}

/**
 * Perform ICP (Iterative Closest Point) registration to align one point cloud to another.
 *
 * The target cloud stays fixed, the source cloud will be transformed.
 * Returns the transformation needed to align the source to the target.
 */
export async function icpRegisterCloudToCloud(
  request: CloudToCloudICPRequest
): Promise<ICPRegistrationResponse> {
  const baseUrl = getBackendUrl();
  console.log('Cloud-to-cloud ICP - target:', request.target_points ? `${request.target_points.length / 3} pts` : `source:${request.target_source?.source_path}`, 'source:', request.source_points ? `${request.source_points.length / 3} pts` : `source:${request.source_source?.source_path}`);

  // Use AbortController for timeout
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), 120000); // 2 minutes

  try {
    const response = await fetch(`${baseUrl}/api/c2c/icp-register`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(request),
      signal: controller.signal,
    });

    clearTimeout(timeoutId);

    if (!response.ok) {
      const errorData = await response.json().catch(() => ({}));
      throw new Error(errorData.detail || `HTTP ${response.status}: ${response.statusText}`);
    }

    return await response.json();
  } catch (error) {
    clearTimeout(timeoutId);
    console.error('Cloud-to-cloud ICP registration failed:', error);
    throw error;
  }
}

// ==================== MESH-TO-MESH ICP REGISTRATION API ====================

export interface MeshToMeshICPRequest {
  target_vertices: number[];   // Flattened [x, y, z, ...] target mesh vertices (stays fixed)
  target_indices: number[];    // Target triangle indices [i, j, k, ...]
  source_vertices: number[];   // Flattened [x, y, z, ...] source mesh vertices (to be moved)
  source_indices: number[];    // Source triangle indices [i, j, k, ...]
  max_correspondence_distance?: number;  // Optional max correspondence distance
  max_iterations?: number;     // Optional max iterations (default 100)
}

/**
 * Perform ICP (Iterative Closest Point) registration to align one mesh to another.
 *
 * Both meshes are sampled to point clouds, then ICP is performed.
 * The target mesh stays fixed, the source mesh will be transformed.
 * Returns the transformation needed to align the source to the target.
 */
export async function icpRegisterMeshToMesh(
  request: MeshToMeshICPRequest
): Promise<ICPRegistrationResponse> {
  const baseUrl = getBackendUrl();
  console.log('Mesh-to-mesh ICP - target vertices:', request.target_vertices.length / 3, 'source vertices:', request.source_vertices.length / 3);

  // Use AbortController for timeout
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), 180000); // 3 minutes (mesh sampling + ICP)

  try {
    const response = await fetch(`${baseUrl}/api/m2m/icp-register`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(request),
      signal: controller.signal,
    });

    clearTimeout(timeoutId);

    if (!response.ok) {
      const errorData = await response.json().catch(() => ({}));
      throw new Error(errorData.detail || `HTTP ${response.status}: ${response.statusText}`);
    }

    return await response.json();
  } catch (error) {
    clearTimeout(timeoutId);
    console.error('Mesh-to-mesh ICP registration failed:', error);
    throw error;
  }
}

// ==================== POINT CLOUD → OCTREE PIPELINE (0.3.0) ====================

export interface OctreeAttribute {
  name: string;
  size: number;
  type: string;
  num_elements: number;
  // Per-attribute value range from PotreeConverter's metadata. Present
  // when the converter knows the actual extrema for the attribute (true
  // for the standard LAS schema fields: intensity, gpsTime, RGB,
  // classification, etc.); absent otherwise.
  min?: number[];
  max?: number[];
  // Human-readable display name for an imported extra-dimension scalar
  // (e.g. attribute name 'Reflectance_dB' → label 'Reflectance [dB]').
  // Present only for carried extra dims; absent for builtin LAS attributes.
  label?: string;
}

export interface OctreeMetadata {
  cache_id: string;
  cache_dir: string;
  cached: boolean;
  version: string;
  point_count: number;
  spacing: number;
  scale: [number, number, number];
  offset: [number, number, number];
  // `bounds` is PotreeConverter's cube-padded octree extent (used internally
  // by the loader for LOD math). `tight_bounds` is the actual data extent —
  // what the UI should use for camera framing and the crop box.
  bounds: { min: [number, number, number]; max: [number, number, number] };
  tight_bounds: { min: [number, number, number]; max: [number, number, number] };
  attributes: OctreeAttribute[];
}

/**
 * Crop region accepted by the cloud-session filter/split/extract ops. Either an
 * axis-aligned box or a
 * screen-space polygon with frozen camera matrices (so the backend can
 * reproject the source points without needing a live camera).
 */
export type CropOctreeRegion =
  | {
      kind: 'box';
      min: [number, number, number];
      max: [number, number, number];
      invert?: boolean;
    }
  | {
      kind: 'polygon';
      points: Array<[number, number]>;       // canvas-pixel coordinates
      projection: number[];                  // 16-element column-major matrix
      view: number[];                        // 16-element column-major matrix
      canvas: { width: number; height: number };
      invert?: boolean;
    }
  | {
      // Erase brush: the union of screen-space square stamps under one frozen
      // camera (same projection/view/canvas as a polygon crop). A point is
      // "inside" the region if its pixel falls within ANY square; erase sends
      // invert=true to keep the complement. Because the test is purely 2D, a
      // square removes points at every depth behind it — an infinite extrusion
      // through the cloud. `centers` are [px, py] pixel positions, `halfSizes`
      // are the squares' half-extents in pixels.
      kind: 'squares_union';
      centers: Array<[number, number]>;
      // snake_case to match the backend field forwarded verbatim to the session op.
      half_sizes: number[];
      projection: number[];                  // 16-element column-major matrix
      view: number[];                        // 16-element column-major matrix
      canvas: { width: number; height: number };
      invert?: boolean;
    };

/**
 * Keep only points whose imported scalar attribute `slug` matches. Continuous
 * fields use the inclusive range [min, max]; categorical fields (ground_class /
 * tree_instance) set `values` to keep points whose value rounds to one of the
 * listed class ids (an OR within the field — `min`/`max` are ignored). `slug` is
 * the on-disk extra-dimension name — the same key used in
 * `OctreeRef.attributeRanges` and the value (after the `scalar:` prefix) the
 * filter panel's field dropdown emits for octrees.
 */
export interface ScalarFilter {
  slug: string;
  min: number;
  max: number;
  // Categorical membership: when set, keep iff round(value) is in this set.
  values?: number[];
}

// ==================== MUTABLE CLOUD SESSIONS (Family-1) ====================
//
// A cloud session holds the imported cloud's positions in RAM on the backend
// as the mutable source of truth. Deletions are an instant per-point mask
// (delete_region) mirrored on the GPU by the renderer's clip-volume stack; the
// Potree octree is a derived cache rebuilt only on bake. Downstream ops read
// the masked array via PointSource.session_id (see buildPointSource).

/** Metadata returned by the cloud-session endpoints — octree metadata plus the
 * session id and current point count. `cache_id` is the derived octree the
 * renderer streams; it changes on bake. */
export interface CloudSessionMetadata extends OctreeMetadata {
  session_id: string;
  point_count: number;
  // Sky/miss points (laser pulses that returned nothing) are kept in the
  // session for LAD but NOT in the octree (their ~20 km coords would poison the
  // bounding box). `has_misses` lets the renderer offer a "Show misses" toggle;
  // `scan_origin` (when the source carried it, e.g. an E57 pose) seeds the
  // scan's params.origin and the miss-overlay relocation.
  has_misses?: boolean;
  miss_count?: number;
  miss_slug?: string;
  scan_origin?: [number, number, number];
}

/** Sky/miss points for a session, relocated onto the hit cloud's bounding
 * sphere for display (true coords stay in the session for LAD). `positions` is
 * a flat [x,y,z, ...] triple list. */
export interface CloudMissesResult {
  count: number;
  origin: [number, number, number];
  radius: number;
  positions: number[];
}

/**
 * Fetch a session's sky/miss points, relocated onto the hit cloud's bounding
 * sphere so they render at a sensible distance. Pass the scan's true origin when
 * known so the projection uses the real beam apex; otherwise the backend falls
 * back to the hit-cloud centre.
 */
export async function getCloudMisses(
  sessionId: string,
  origin?: { x: number; y: number; z: number } | null,
): Promise<CloudMissesResult> {
  const baseUrl = getBackendUrl();
  const q = origin
    ? `?origin_x=${origin.x}&origin_y=${origin.y}&origin_z=${origin.z}`
    : '';
  try {
    const response = await fetch(
      `${baseUrl}/api/cloud/session/${sessionId}/misses${q}`,
    );
    if (!response.ok) {
      const errorData = await response.json().catch(() => ({}));
      throw new Error(errorData.detail || `HTTP ${response.status}: ${response.statusText}`);
    }
    return (await response.json()) as CloudMissesResult;
  } catch (error) {
    console.error('get_cloud_misses failed:', error);
    throw describeBackendError(error, 'Misses');
  }
}

/** Result of a delete_region / reset_edits call — counts only (no rebuild). */
export interface CloudSessionEditResult {
  session_id: string;
  deleted_count: number;
  remaining_count: number;
  total_count: number;
}

/** Result of a bake — fresh octree metadata for the survivor set. `baked` is
 * false when there were no pending deletions (the octree is unchanged). */
export interface CloudSessionBakeResult extends OctreeMetadata {
  session_id: string;
  point_count: number;
  baked: boolean;
}

/**
 * Load a source cloud into an in-RAM backend session and build its first
 * (derived) octree for the editable octree flow:
 * the returned `cache_id` streams to the GPU, but edits and
 * downstream ops route through `session_id`. The wizard `columnPlan` is honored
 * once here and carried for the life of the session (no re-auto-detect on edit).
 */
export async function createCloudSession(
  filePath: string,
  asciiFormat?: string | null,
  columnPlan?: ColumnPlan | null,
): Promise<CloudSessionMetadata> {
  const baseUrl = getBackendUrl();
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), 300000);
  try {
    const response = await fetch(`${baseUrl}/api/cloud/session/create`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        source_path: filePath,
        ascii_format: asciiFormat ?? null,
        column_plan: columnPlan ? columnPlanToPayload(columnPlan) : null,
      }),
      signal: controller.signal,
    });
    clearTimeout(timeoutId);
    if (!response.ok) {
      const errorData = await response.json().catch(() => ({}));
      throw new Error(errorData.detail || `HTTP ${response.status}: ${response.statusText}`);
    }
    return (await response.json()) as CloudSessionMetadata;
  } catch (error) {
    clearTimeout(timeoutId);
    console.error('create_cloud_session failed:', error);
    throw describeBackendError(error, 'Import');
  }
}

/**
 * Mark points inside `region` as deleted on a cloud session. Instant — sets the
 * in-RAM mask and records the region for bake replay; does NOT rebuild the
 * octree. The renderer mirrors the deletion on the GPU clip-volume stack so the
 * viewport updates immediately. Returns counts only.
 */
export async function deleteCloudRegion(
  sessionId: string,
  region: CropOctreeRegion,
): Promise<CloudSessionEditResult> {
  const baseUrl = getBackendUrl();
  try {
    const response = await fetch(
      `${baseUrl}/api/cloud/session/${sessionId}/delete_region`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ region }),
      },
    );
    if (!response.ok) {
      const errorData = await response.json().catch(() => ({}));
      throw new Error(errorData.detail || `HTTP ${response.status}: ${response.statusText}`);
    }
    return (await response.json()) as CloudSessionEditResult;
  } catch (error) {
    console.error('delete_cloud_region failed:', error);
    throw error;
  }
}

/**
 * Undo: restore the deleted mask to an earlier snapshot, keeping the first
 * `editCount` committed deletes and discarding the rest. Omit `editCount` to
 * clear all deletions. Returns counts only — no rebuild.
 */
export async function resetCloudEdits(
  sessionId: string,
  editCount?: number,
): Promise<CloudSessionEditResult> {
  const baseUrl = getBackendUrl();
  try {
    const response = await fetch(
      `${baseUrl}/api/cloud/session/${sessionId}/reset_edits`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ edit_count: editCount ?? null }),
      },
    );
    if (!response.ok) {
      const errorData = await response.json().catch(() => ({}));
      throw new Error(errorData.detail || `HTTP ${response.status}: ${response.statusText}`);
    }
    return (await response.json()) as CloudSessionEditResult;
  } catch (error) {
    console.error('reset_cloud_edits failed:', error);
    throw error;
  }
}

/**
 * Permanently apply deletions: rebuild the octree from the survivors (one
 * PotreeConverter run) and clear the mask. The deliberately-slow step. Returns
 * the new octree metadata; `baked === false` when there were no deletions.
 */
export async function bakeCloudSession(
  sessionId: string,
): Promise<CloudSessionBakeResult> {
  const baseUrl = getBackendUrl();
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), 300000);
  try {
    const response = await fetch(
      `${baseUrl}/api/cloud/session/${sessionId}/bake`,
      { method: 'POST', signal: controller.signal },
    );
    clearTimeout(timeoutId);
    if (!response.ok) {
      const errorData = await response.json().catch(() => ({}));
      throw new Error(errorData.detail || `HTTP ${response.status}: ${response.statusText}`);
    }
    return (await response.json()) as CloudSessionBakeResult;
  } catch (error) {
    clearTimeout(timeoutId);
    console.error('bake_cloud_session failed:', error);
    throw error;
  }
}

/**
 * Apply a spatial + scalar filter to a session by deleting the excluded points
 * (operates on the in-RAM arrays; no source file read). `rebuild` true rebuilds
 * the octree from the survivors and returns its metadata.
 */
export async function sessionFilter(
  sessionId: string,
  options: { region?: CropOctreeRegion | null; scalarFilters?: ScalarFilter[] | null; rebuild?: boolean },
): Promise<CloudSessionBakeResult & { rebuilt: boolean }> {
  const baseUrl = getBackendUrl();
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), 300000);
  try {
    const response = await fetch(`${baseUrl}/api/cloud/session/${sessionId}/filter`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        region: options.region ?? null,
        scalar_filters: options.scalarFilters ?? null,
        rebuild: options.rebuild ?? true,
      }),
      signal: controller.signal,
    });
    clearTimeout(timeoutId);
    if (!response.ok) {
      const errorData = await response.json().catch(() => ({}));
      throw new Error(errorData.detail || `HTTP ${response.status}: ${response.statusText}`);
    }
    return (await response.json()) as CloudSessionBakeResult & { rebuilt: boolean };
  } catch (error) {
    clearTimeout(timeoutId);
    console.error('session_filter failed:', error);
    throw error;
  }
}

/** Result of a session split: the kept side (this session) + an optional new
 * leftover session, both with fresh octree metadata. Built entirely from the
 * in-RAM arrays (no source file read). */
export interface CloudSessionSplitResult {
  session_id: string;
  kept: OctreeMetadata & { point_count: number; cache_id: string };
  leftover: (OctreeMetadata & { session_id: string; point_count: number; cache_id: string }) | null;
}

/**
 * Split a session by a spatial+scalar filter: keep the passing points on this
 * session, move the excluded points to a NEW leftover session. Both octrees are
 * rebuilt from the in-RAM arrays — no source file read.
 */
export async function sessionSplit(
  sessionId: string,
  options: { region?: CropOctreeRegion | null; scalarFilters?: ScalarFilter[] | null },
): Promise<CloudSessionSplitResult> {
  const baseUrl = getBackendUrl();
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), 300000);
  try {
    const response = await fetch(`${baseUrl}/api/cloud/session/${sessionId}/split`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        region: options.region ?? null,
        scalar_filters: options.scalarFilters ?? null,
      }),
      signal: controller.signal,
    });
    clearTimeout(timeoutId);
    if (!response.ok) {
      const errorData = await response.json().catch(() => ({}));
      throw new Error(errorData.detail || `HTTP ${response.status}: ${response.statusText}`);
    }
    return (await response.json()) as CloudSessionSplitResult;
  } catch (error) {
    clearTimeout(timeoutId);
    console.error('session_split failed:', error);
    throw error;
  }
}

/** Extract the filter-selected points into a NEW child session, leaving the
 * parent unchanged. Built from the in-RAM arrays — no source file read. Returns
 * the child's octree metadata, or null `extracted` when the selection is empty. */
export async function sessionExtract(
  sessionId: string,
  options: { region?: CropOctreeRegion | null; scalarFilters?: ScalarFilter[] | null },
): Promise<{ session_id: string; extracted: (OctreeMetadata & { session_id: string; point_count: number; cache_id: string }) | null }> {
  const baseUrl = getBackendUrl();
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), 300000);
  try {
    const response = await fetch(`${baseUrl}/api/cloud/session/${sessionId}/extract`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ region: options.region ?? null, scalar_filters: options.scalarFilters ?? null }),
      signal: controller.signal,
    });
    clearTimeout(timeoutId);
    if (!response.ok) {
      const errorData = await response.json().catch(() => ({}));
      throw new Error(errorData.detail || `HTTP ${response.status}: ${response.statusText}`);
    }
    return await response.json();
  } catch (error) {
    clearTimeout(timeoutId);
    console.error('session_extract failed:', error);
    throw error;
  }
}

/** Run CSF ground segmentation on the session's in-RAM points, append a
 * `ground_class` column, and rebuild the octree from the arrays (no file read). */
export async function sessionSegmentGround(
  sessionId: string,
  params: { cloth_resolution?: number; rigidness?: number; class_threshold?: number; iterations?: number; slope_smooth?: boolean },
): Promise<CloudSessionBakeResult> {
  const baseUrl = getBackendUrl();
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), 300000);
  try {
    const response = await fetch(`${baseUrl}/api/cloud/session/${sessionId}/segment_ground`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(params),
      signal: controller.signal,
    });
    clearTimeout(timeoutId);
    if (!response.ok) {
      const errorData = await response.json().catch(() => ({}));
      throw new Error(errorData.detail || `HTTP ${response.status}: ${response.statusText}`);
    }
    return (await response.json()) as CloudSessionBakeResult;
  } catch (error) {
    clearTimeout(timeoutId);
    console.error('session_segment_ground failed:', error);
    throw error;
  }
}

/** Run TreeIso on the session's in-RAM points, append a `tree_instance` column,
 * and rebuild the octree from the arrays (no file read). Pass TreeIso tuning. */
export async function sessionSegmentTrees(
  sessionId: string,
  params: { [k: string]: number | number[][] | undefined; seed_points?: number[][] },
): Promise<CloudSessionBakeResult> {
  const baseUrl = getBackendUrl();
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), 600000);
  try {
    const response = await fetch(`${baseUrl}/api/cloud/session/${sessionId}/segment_trees`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(params),
      signal: controller.signal,
    });
    clearTimeout(timeoutId);
    if (!response.ok) {
      const errorData = await response.json().catch(() => ({}));
      throw new Error(errorData.detail || `HTTP ${response.status}: ${response.statusText}`);
    }
    return (await response.json()) as CloudSessionBakeResult;
  } catch (error) {
    clearTimeout(timeoutId);
    console.error('session_segment_trees failed:', error);
    throw error;
  }
}

/**
 * Free a cloud session's in-RAM arrays. Called when the user removes a cloud
 * from the scene. Best-effort: never throws (a failed cleanup must not block
 * the UI removal).
 */
export async function deleteCloudSession(sessionId: string): Promise<void> {
  const baseUrl = getBackendUrl();
  try {
    await fetch(`${baseUrl}/api/cloud/session/${sessionId}`, { method: 'DELETE' });
  } catch (error) {
    console.warn('delete_cloud_session failed (ignored):', error);
  }
}

