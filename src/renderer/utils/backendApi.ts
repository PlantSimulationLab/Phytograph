// ==================== TRIANGULATION API ====================

export type TriangulationMethod = 'ball_pivoting' | 'poisson' | 'alpha_shape' | 'delaunay' | 'helios';

export interface TriangulationRequest {
  points: number[][];  // [[x, y, z], ...]
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

// ==================== HELIOS TRIANGULATION API ====================

export interface HeliosScanEntry {
  file_path?: string;       // Path to scan file on disk (preferred for large scans)
  ascii_format?: string;    // Column format e.g. "x y z timestamp" (auto-detected if omitted)
  points?: number[][];      // [[x, y, z], ...] fallback when no file_path
  colors?: number[][];      // [[r, g, b], ...] point colors (0-1 range)
  origin: number[];         // [x, y, z] scanner position
}

export interface HeliosTriangulationRequest {
  scans: HeliosScanEntry[];
  lmax: number;              // Maximum triangle edge length
  max_aspect_ratio: number;  // Maximum triangle aspect ratio (default 4.0)
  theta_min: number;         // Zenith angle min (degrees, default 30)
  theta_max: number;         // Zenith angle max (degrees, default 130)
  phi_min: number;           // Azimuth angle min (degrees, default 0)
  phi_max: number;           // Azimuth angle max (degrees, default 360)
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
  points: number[][];  // [[x, y, z], ...]

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
  console.log('Skeleton extraction - baseUrl:', baseUrl, 'points:', request.points.length);

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
  points: number[][];  // [[x, y, z], ...]
  colors?: number[][];  // [[r, g, b], ...] in 0-1 range
  format: 'las' | 'laz';
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
  console.log('LAS/LAZ export - points:', request.points.length, 'format:', request.format);

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
  points: number[];      // Flattened [x, y, z, ...] point cloud positions
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
  console.log('Alignment distance - points:', request.points.length / 3, 'vertices:', request.mesh_vertices.length / 3);

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
  points: number[];          // Flattened [x, y, z, ...] point cloud positions (TARGET - stays fixed)
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
  console.log('ICP registration - points:', request.points.length / 3, 'mesh vertices:', request.mesh_vertices.length / 3);

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
  target_points: number[];     // Flattened [x, y, z, ...] target point cloud (stays fixed)
  source_points: number[];     // Flattened [x, y, z, ...] source point cloud (to be moved)
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
  console.log('Cloud-to-cloud ICP - target points:', request.target_points.length / 3, 'source points:', request.source_points.length / 3);

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
