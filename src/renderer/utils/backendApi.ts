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

/**
 * Apply ground segmentation and re-convert the source cloud into a new octree
 * carrying a `ground_class` scalar attribute (1=ground, 2=plant) the renderer
 * can colour by. Returns the same octree-ref shape as `convertToOctree` /
 * `cropOctree`; the caller swaps the cloud's OctreeRef to the returned one.
 */
export interface GroundSegmentationApplyRequest {
  source_path: string;
  ascii_format?: string | null;
  cloth_resolution?: number;
  rigidness?: number;
  class_threshold?: number;
  iterations?: number;
  slope_smooth?: boolean;
  // 1=ground, 2=plant → keep only that class (split sub-cloud). Omit to
  // classify in place (all points, with the ground_class attribute).
  keep_class?: number;
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

export async function segmentGroundApply(
  request: GroundSegmentationApplyRequest
): Promise<SegmentApplyMetadata> {
  const baseUrl = getBackendUrl();
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), 300000); // 5 minutes (CSF + re-convert)

  try {
    const response = await fetch(`${baseUrl}/api/segment/ground/apply`, {
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
    return (await response.json()) as SegmentApplyMetadata;
  } catch (error) {
    clearTimeout(timeoutId);
    console.error('Ground segmentation apply failed:', error);
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

/**
 * Apply tree segmentation and re-convert the source cloud into a new octree
 * carrying a `tree_instance` scalar attribute (0 = unassigned, 1..N = trees) the
 * renderer can colour by. Mirrors `segmentGroundApply`; `keep_instance` extracts
 * a single tree as a sub-cloud.
 */
export interface TreeSegmentationApplyRequest {
  source_path: string;
  ascii_format?: string | null;
  seed_points?: number[][];
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
  keep_instance?: number;   // 1..N → keep only that tree (split sub-cloud)
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

export async function segmentTreesApply(
  request: TreeSegmentationApplyRequest
): Promise<SegmentApplyMetadata> {
  const baseUrl = getBackendUrl();
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), 300000); // 5 minutes (TreeIso + re-convert)

  try {
    const response = await fetch(`${baseUrl}/api/segment/trees/apply`, {
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
    return (await response.json()) as SegmentApplyMetadata;
  } catch (error) {
    clearTimeout(timeoutId);
    console.error('Tree segmentation apply failed:', error);
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

// ==================== MESH SURFACE SAMPLING API ====================

export interface MeshSampleRequest {
  vertices: number[][];  // [[x, y, z], ...] - mesh vertices
  triangles: number[][];  // [[i, j, k], ...] - triangle vertex indices
  vertex_colors?: number[][];  // [[r, g, b], ...] - colors per vertex (0-1 range)
  num_points?: number;  // Target number of points (if not using density)
  density?: number;  // Points per square meter (if not using num_points)
  seed?: number;  // Random seed for reproducibility
}

export interface MeshSampleResponse {
  success: boolean;
  points: number[][];  // [[x, y, z], ...] - sampled point positions
  colors?: number[][];  // [[r, g, b], ...] - interpolated colors
  num_points: number;
  surface_area: number;  // Total surface area of the mesh
  error?: string;
}

/**
 * Sample points uniformly from a mesh surface
 *
 * Converts a triangulated mesh into a point cloud by randomly sampling
 * points from the mesh surface. Points are distributed uniformly based on
 * triangle area.
 */
export async function sampleMeshSurface(
  request: MeshSampleRequest
): Promise<MeshSampleResponse> {
  const baseUrl = getBackendUrl();
  console.log('Mesh sampling - vertices:', request.vertices.length, 'triangles:', request.triangles.length);

  try {
    const response = await fetch(`${baseUrl}/api/mesh/sample`, {
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
    console.error('Mesh sampling failed:', error);
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

// Pulls a point-cloud file from disk via the backend rather than reading it
// into a string in the renderer (V8 caps strings at ~512 MB, which trips on
// multi-hundred-MB TLS scans). Backend dispatches by extension: XYZ-family
// via pandas (honours `asciiFormat`), PLY/PCD via open3d. `asciiFormat` is
// ignored on the PLY/PCD path.
export async function importPointCloudByPath(
  filePath: string,
  asciiFormat?: string | null,
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
    throw error;
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

// Crop a point cloud on the backend rather than in the renderer's JS heap.
// Same on-disk path the importer uses (renderer keeps it in
// `Scan.sourcePath`); same PHX1 binary response. The backend reads the
// original file, applies an AABB filter with NumPy, and streams the
// kept points back.
//
// Moving this off the renderer keeps a multi-million-point apply from
// hitting V8's 4 GB old-space ceiling — the renderer used to allocate
// peak ~3+ GB of throwaway typed arrays for a single apply on a
// 28M-point scan with RGB + intensity, and OOM'd. Backend memory is
// only bound by host RAM.
//
// `crop_min` / `crop_max` are world-space AABB bounds. If `translation`
// is provided, the backend bakes it into the cloud's positions before
// the AABB test — matching the in-renderer apply semantics where the
// editState translation gets folded into the new cloud.data.
export async function cropPointCloudByPath(
  filePath: string,
  opts: {
    asciiFormat?: string | null;
    cropMin: { x: number; y: number; z: number };
    cropMax: { x: number; y: number; z: number };
    cropInvert: boolean;
    translation?: { x: number; y: number; z: number } | null;
  },
): Promise<ImportPointCloudByPathResult> {
  const baseUrl = getBackendUrl();
  // Generous timeout — NumPy on a 28M-point scan is fast (single seconds),
  // but file IO can be slow on cold caches and we'd rather not bail.
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), 600000);
  try {
    const response = await fetch(`${baseUrl}/api/pointcloud/crop_by_path`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        file_path: filePath,
        ascii_format: opts.asciiFormat ?? null,
        crop_min: [opts.cropMin.x, opts.cropMin.y, opts.cropMin.z],
        crop_max: [opts.cropMax.x, opts.cropMax.y, opts.cropMax.z],
        crop_invert: opts.cropInvert,
        translation: opts.translation
          ? [opts.translation.x, opts.translation.y, opts.translation.z]
          : null,
      }),
      signal: controller.signal,
    });
    clearTimeout(timeoutId);
    if (!response.ok) {
      const errorData = await response.json().catch(() => ({}));
      throw new Error(errorData.detail || `HTTP ${response.status}: ${response.statusText}`);
    }
    const buf = await response.arrayBuffer();
    return decodePointCloudBinary(buf);
  } catch (error) {
    clearTimeout(timeoutId);
    console.error('Point-cloud crop-by-path failed:', error);
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
 * `OctreeMetadata` extended with the on-disk path of the segmented LAS the
 * apply baked the label into (ground_class / tree_instance). The renderer uses
 * it as the new cloud's `sourceXyzPath` so a later Filter/Crop re-reads a source
 * that carries the label — the original XYZ source does not. See
 * `segment_ground_apply` / `segment_trees_apply` in the backend.
 */
export interface SegmentApplyMetadata extends OctreeMetadata {
  segmented_source_path: string;
}

/**
 * Triggers a Potree 2.0 octree build on the backend for an XYZ-family source
 * file. The backend caches by sha1(sourcePath + mtime + asciiFormat) — repeat
 * calls hit the cache and return immediately. The renderer streams tiles via
 * the custom `app://octree/<cache_id>/...` protocol after this returns.
 *
 * Timeout: 5 minutes. A typical 13M-point Helios scan converts in ~7s; a
 * 100M-point synthetic cloud would still finish comfortably under the cap.
 */
export async function convertToOctree(
  filePath: string,
  asciiFormat?: string | null,
): Promise<OctreeMetadata> {
  const baseUrl = getBackendUrl();
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), 300000);
  try {
    const response = await fetch(`${baseUrl}/api/pointcloud/convert_to_octree`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        source_path: filePath,
        ascii_format: asciiFormat ?? null,
      }),
      signal: controller.signal,
    });
    clearTimeout(timeoutId);
    if (!response.ok) {
      const errorData = await response.json().catch(() => ({}));
      throw new Error(errorData.detail || `HTTP ${response.status}: ${response.statusText}`);
    }
    return (await response.json()) as OctreeMetadata;
  } catch (error) {
    clearTimeout(timeoutId);
    console.error('convert_to_octree failed:', error);
    throw error;
  }
}

/**
 * Crop region accepted by `cropOctree`. Either an axis-aligned box or a
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
      // snake_case to match the backend field forwarded verbatim by cropOctree.
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

/**
 * Response from `cropOctree`. Same shape as `OctreeMetadata` for non-empty
 * crops, except `cache_id` and `cache_dir` are `null` when the crop kept
 * zero points. Callers must check `point_count === 0` (renderer raises a
 * delete-confirmation in that case rather than 4xx-ing — the backend
 * returns HTTP 200 with the empty payload).
 */
export interface CropOctreeResult {
  cache_id: string | null;
  cache_dir: string | null;
  cached: boolean;
  // On-disk path of the persisted filtered LAS (carrying the kept points with
  // any scalar attributes). The renderer uses it as the resulting cloud's
  // `sourceXyzPath` so the NEXT crop/filter/segment composes on the current
  // point set, not the original source. `null` when the crop kept zero points.
  filtered_source_path: string | null;
  version: string;
  point_count: number;
  spacing: number;
  scale: [number, number, number];
  offset: [number, number, number];
  bounds: { min: [number, number, number]; max: [number, number, number] };
  tight_bounds: { min: [number, number, number]; max: [number, number, number] };
  attributes: OctreeAttribute[];
}

/**
 * Re-convert an XYZ-family source into a new Potree 2.0 octree after
 * applying a crop region (and optional translation). The returned
 * `cache_id` is the renderer's hot-swap target — the old octree's `app://`
 * resources are released once nothing references the prior cache id.
 *
 * Box, polygon, and sphere-union regions are all backend-side: the renderer
 * never sees the filtered point set. The 5-minute timeout matches `convertToOctree`
 * (a 100M-point cloud's worst-case re-conversion still fits comfortably).
 *
 * Empty crops resolve with `cache_id === null` and `point_count === 0`;
 * the call does NOT throw.
 */
export async function cropOctree(
  sourcePath: string,
  options: {
    asciiFormat?: string | null;
    // Spatial crop. Optional — omit for a scalar-only filter (at least one of
    // `region` or `scalarFilters` must be present, enforced by the backend).
    region?: CropOctreeRegion | null;
    // Imported-scalar value filters, AND-combined with each other and with
    // the region.
    scalarFilters?: ScalarFilter[] | null;
    // Invert the entire combined mask (spatial AND scalars) as the final step,
    // yielding the complement/leftover set. Used by the filter tool's "Segment"
    // action to produce the out-of-range cloud.
    invertAll?: boolean;
    translation?: [number, number, number] | null;
  },
): Promise<CropOctreeResult> {
  const baseUrl = getBackendUrl();
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), 300000);
  try {
    const response = await fetch(`${baseUrl}/api/pointcloud/crop_octree`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        source_path: sourcePath,
        ascii_format: options.asciiFormat ?? null,
        region: options.region ?? null,
        scalar_filters: options.scalarFilters ?? null,
        invert_all: options.invertAll ?? false,
        translation: options.translation ?? null,
      }),
      signal: controller.signal,
    });
    clearTimeout(timeoutId);
    if (!response.ok) {
      const errorData = await response.json().catch(() => ({}));
      throw new Error(errorData.detail || `HTTP ${response.status}: ${response.statusText}`);
    }
    return (await response.json()) as CropOctreeResult;
  } catch (error) {
    clearTimeout(timeoutId);
    console.error('crop_octree failed:', error);
    throw error;
  }
}

/**
 * Read metadata for a previously-converted octree. Used by the renderer when
 * it has only a cache id (e.g. after a project reload). For a fresh import,
 * `convertToOctree` already returns this same shape — no need to round-trip.
 */
export async function getOctreeMetadata(cacheId: string): Promise<OctreeMetadata> {
  const baseUrl = getBackendUrl();
  const response = await fetch(
    `${baseUrl}/api/pointcloud/octree_metadata?cache_id=${encodeURIComponent(cacheId)}`,
  );
  if (!response.ok) {
    const errorData = await response.json().catch(() => ({}));
    throw new Error(errorData.detail || `HTTP ${response.status}: ${response.statusText}`);
  }
  return (await response.json()) as OctreeMetadata;
}
