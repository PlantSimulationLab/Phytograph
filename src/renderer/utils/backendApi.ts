// ==================== REQUEST TIMEOUTS ====================

/**
 * Thrown when a backend request exceeds its client-side deadline.
 *
 * Every fetch helper below guards itself with an `AbortController` + `setTimeout`.
 * Aborting with NO reason makes `fetch` reject with Chromium's own DOMException,
 * whose message is the useless `"signal is aborted without reason"` — which is
 * what users saw in the Export Failed toast: no operation, no endpoint, no
 * duration, no hint at what to do. `AbortController.abort(reason)` lets us supply
 * the rejection value ourselves, so the error that reaches the catch block (and
 * therefore the toast) is already a self-describing message.
 *
 * Just as important: it is DISTINGUISHABLE from a user cancel. Several callers
 * treat `DOMException`/`name === 'AbortError'` as "the user pressed Cancel" and
 * silently swallow it — so before this, a genuine timeout on those paths showed
 * the user nothing at all. A cancel still aborts with no reason (a plain
 * AbortError); only the deadline produces this type.
 */
export class BackendTimeoutError extends Error {
  readonly endpoint: string;
  readonly timeoutMs: number;
  constructor(endpoint: string, timeoutMs: number) {
    const secs = timeoutMs >= 60000
      ? `${Math.round(timeoutMs / 60000)} min`
      : `${Math.round(timeoutMs / 1000)} s`;
    super(
      `The backend did not respond within ${secs} (POST ${endpoint}). ` +
      `Requests run concurrently, so this is not another tool holding it up — the ` +
      `operation itself is either still working on an unusually large cloud or it ` +
      `is stuck. The backend logs a "[slow]" line naming any request over 5 s; if ` +
      `nothing is progressing there, restart the backend.`,
    );
    this.name = 'BackendTimeoutError';
    this.endpoint = endpoint;
    this.timeoutMs = timeoutMs;
  }
}

/**
 * Arm a request deadline. Returns the timer id to `clearTimeout` on completion.
 * Prefer this over a bare `setTimeout(() => controller.abort(), ms)` — the reason
 * is what the user ends up reading. `endpoint` is the route (a `:id` placeholder
 * is fine; it is for the human, not for parsing).
 */
export function abortOnTimeout(
  controller: AbortController,
  timeoutMs: number,
  endpoint: string,
): ReturnType<typeof setTimeout> {
  return setTimeout(
    () => controller.abort(new BackendTimeoutError(endpoint, timeoutMs)),
    timeoutMs,
  );
}

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

// ==================== KILLABLE SEGMENTATION HELPER ====================

/**
 * Advisory workload estimate for a tree segmentation run. TreeIso's cost tracks
 * the POST-DECIMATION voxel count, not raw point count (it decimates before every
 * expensive stage), so `nodes` — not `points` — is what makes a run slow.
 *
 * Receiving one is a prompt, not a refusal: re-send the request with
 * `acknowledge_cost: true` to run it anyway. There is no workload the backend
 * will refuse outright, so a user willing to wait can always proceed (and Cancel
 * mid-run).
 */
export interface TreeCostWarning {
  nodes: number;           // voxels TreeIso will actually process
  node_guideline: number;  // the advisory threshold that was exceeded
  points: number;          // non-ground input points
  decimate_res1: number;   // resolved stage-1 voxel size, metres
  message: string;         // ready-to-display copy
}

/** Thrown when a segmentation endpoint wants explicit confirmation before
 *  running an expensive job. Carries the estimate so the UI can prompt. */
export class CostWarningError extends Error {
  readonly costWarning: TreeCostWarning;
  constructor(costWarning: TreeCostWarning) {
    super(costWarning.message);
    this.name = 'CostWarningError';
    this.costWarning = costWarning;
  }
}

/**
 * POST a JSON request to a (non-streaming) segmentation endpoint, with a 5-minute
 * safety timeout AND optional external cancellation. The external `signal` is the
 * Cancel button: aborting the fetch closes the TCP connection, the backend detects
 * the disconnect and SIGKILLs its worker subprocess (see `_run_killable`). The
 * fetch aborts when EITHER the timeout fires OR the external signal aborts — and
 * the two are deliberately distinguishable at the catch site: a cancel aborts with
 * no reason (a plain DOMException 'AbortError', which callers swallow as user
 * intent), the deadline aborts with a `BackendTimeoutError` (a real failure that
 * must surface).
 */
async function postSegment<T>(path: string, request: unknown, signal?: AbortSignal, timeoutMs = 300000): Promise<T> {
  const baseUrl = getBackendUrl();
  const controller = new AbortController();
  const timeoutId = abortOnTimeout(controller, timeoutMs, path);
  // Mirror the external signal into our controller so the fetch aborts on either
  // the timeout or a user-initiated cancel. `once` keeps the listener from leaking.
  const onExternalAbort = () => controller.abort();
  if (signal) {
    if (signal.aborted) controller.abort();
    else signal.addEventListener('abort', onExternalAbort, { once: true });
  }
  try {
    const response = await fetch(`${baseUrl}${path}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(request),
      signal: controller.signal,
    });
    if (!response.ok) {
      const errorData = await response.json().catch(() => ({}));
      const detail = errorData?.detail;
      // A 409 carrying a structured `cost_warning` is a CONFIRMATION prompt, not
      // a failure: the workload is above the cost guideline and the backend wants
      // an explicit "run it anyway". Surface it as a typed error so callers can
      // prompt and retry with `acknowledge_cost` instead of showing a raw
      // stringified object to the user.
      if (response.status === 409 && detail && typeof detail === 'object'
          && (detail as { cost_warning?: TreeCostWarning }).cost_warning) {
        throw new CostWarningError((detail as { cost_warning: TreeCostWarning }).cost_warning);
      }
      throw new Error(
        (typeof detail === 'string' ? detail : (detail as { message?: string })?.message)
        || `HTTP ${response.status}: ${response.statusText}`
      );
    }
    return await response.json();
  } finally {
    clearTimeout(timeoutId);
    if (signal) signal.removeEventListener('abort', onExternalAbort);
  }
}

// ==================== TRIANGULATION API ====================

export type TriangulationMethod = 'ball_pivoting' | 'poisson' | 'alpha_shape' | 'delaunay' | 'helios' | 'dem' | 'crown';

export interface TriangulationRequest {
  points?: number[][];  // [[x, y, z], ...] — omit when `source` is set
  source?: BackendPointSource;  // octree-backed clouds read from disk
  // Merged multi-scan triangulation: every contributing octree source. The
  // backend reads + vstacks them (folding in any inline `points` too) before
  // meshing. Takes precedence over `source` when non-empty.
  sources?: BackendPointSource[];
  method: TriangulationMethod;
  // Crop-to-grid box [min_x, min_y, min_z, max_x, max_y, max_z] (world coords).
  // When set, points outside this box are dropped before meshing (a numpy mask
  // applied backend-side to the resolved points, regardless of source kind).
  // Omit for no crop.
  crop_box?: number[];
  // Azimuthal rotation of the crop box about +z (degrees, about the box center).
  // Non-zero → the backend crops the ROTATED box, not its AABB (crop_box gives
  // the box's axis-aligned extent before rotation). Omit/0 = axis-aligned.
  crop_box_rotation_deg?: number;
  // PIN this triangulation to a voxel grid so the mesh can later be re-used as the
  // external triangulation for the leaf-area (LAD) inversion. The renderer also
  // sets crop_box from the SAME grid (so points outside the box are dropped before
  // meshing); `grid` drives the per-triangle cell binning the response echoes back
  // (triangleCellIds), which the LAD reuse path uses to keep only in-grid
  // triangles. Omit = not pinned (mesh isn't LAD-reusable).
  grid?: HeliosGrid;
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

// Decoded Open3D triangulation result — big arrays are zero-copy typed-array
// views over the PHB1 binary frame.
export interface TriangulationResult {
  success: boolean;
  error?: string;
  vertices: Float32Array;   // flat xyz (numVertices*3)
  triangles: Uint32Array;   // flat indices (numTriangles*3)
  normals?: Float32Array;   // flat per-vertex xyz
  surfaceArea?: number;
  numTriangles: number;
  numVertices: number;
  methodUsed: string;
  pointsUsed?: number;      // input points actually triangulated (post-crop, post-cap)
  // True iff the max_points cap actually downsampled. Distinct from
  // pointsUsed < cloud size, which a crop alone also makes true — gate the
  // "downsampled" warning on THIS, not on the count comparison.
  downsampled?: boolean;
  // Per-triangle grid cell (0xffffffff = outside) when the request pinned the
  // mesh to a `grid`. Aligned 1:1 with `triangles`. Undefined when not pinned.
  triangleCellIds?: Uint32Array;
}

import { BACKEND_PORT_PROD } from '../../shared/constants';
// The wire shape of the backend `scan_params` dict (E57/PCD scan-pattern
// metadata). Canonically defined in scanParameters.ts alongside the converter
// that turns it into ScanParameters; imported here for CloudSessionMetadata and
// re-exported below so backendApi consumers get it without a second import.
import type { ScanParamsFromFile } from '../lib/scanParameters';
import type { MeshData, PlantMaterialDef } from '../lib/pointCloudTypes';

// Cached backend base URL. The port is chosen per-instance by the main process
// (src/main/backend.ts) so concurrent app instances / dev sessions / E2E runs
// never collide on a fixed port. We can't read it synchronously from a static
// renderer bundle, so initBackendUrl() fetches it once from main via the
// preload bridge and caches it here for the many synchronous getBackendUrl()
// callers. Until that resolves we fall back to the prod default (8008), which
// is correct for any single-instance run.
let cachedBackendUrl = `http://127.0.0.1:${BACKEND_PORT_PROD}`;

/**
 * Fetch the real backend URL from the main process and cache it. Call once at
 * renderer startup, before issuing API calls. Idempotent and safe to await
 * multiple times. Falls back silently to the default if the bridge is absent
 * (e.g. unit tests run outside Electron).
 */
export async function initBackendUrl(): Promise<string> {
  try {
    const info = await window.electronAPI?.backend?.getInfo?.();
    if (info?.url) cachedBackendUrl = info.url;
  } catch {
    // Keep the default; getBackendUrl() stays usable.
  }
  return cachedBackendUrl;
}

/**
 * Get the backend API base URL. Returns the per-instance URL once
 * initBackendUrl() has resolved; before that, the prod default.
 */
export function getBackendUrl(): string {
  return cachedBackendUrl;
}

/**
 * Turn a raw fetch rejection into an actionable message. `fetch` rejects with a
 * bare `TypeError: Failed to fetch` when the connection never completes — the
 * backend is down, still starting, or crashed mid-response (a 500 that resets
 * the socket before the body is sent). That message tells the user nothing, so
 * we rewrite it; genuine HTTP-status errors (which we throw ourselves with the
 * backend's `detail`) pass through untouched.
 */
/**
 * Whether an error means the backend could not be REACHED, as opposed to the
 * backend answering with a failure. Callers with a local fallback path use this
 * to tell the two apart: falling back is right when the backend is genuinely
 * absent, but reporting "the backend was unavailable" for an error the backend
 * itself returned (or for a client-side decode failure) sends users chasing a
 * process that was up the whole time.
 */
export function isBackendUnreachable(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  // A deadline abort means the backend was reachable but too slow — not absent.
  if (error instanceof BackendTimeoutError) return false;
  return (
    error.name === 'TypeError' ||
    /failed to fetch|networkerror|load failed|connection/i.test(error.message)
  );
}

/**
 * Render a FastAPI `detail` as text.
 *
 * A raised HTTPException gives a plain string, but a 422 VALIDATION error gives
 * an ARRAY of `{loc, msg, type}` objects — and interpolating that into a
 * template literal yields the useless "[object Object]" a user actually saw.
 * Flatten those into "field: message" so a malformed request says which field
 * was wrong.
 */
export function formatBackendDetail(detail: unknown): string {
  if (typeof detail === 'string') return detail;
  if (Array.isArray(detail)) {
    return detail
      .map((e) => {
        if (typeof e === 'string') return e;
        const err = e as { loc?: unknown[]; msg?: string };
        // `loc` is like ["body", "keep_columns"]; the last element names the
        // offending field, which is the part worth showing.
        const field = Array.isArray(err.loc) ? String(err.loc[err.loc.length - 1]) : '';
        return field ? `${field}: ${err.msg ?? 'invalid'}` : (err.msg ?? 'invalid');
      })
      .join('; ');
  }
  if (detail && typeof detail === 'object') {
    const d = detail as { msg?: string; detail?: string };
    return d.msg ?? d.detail ?? JSON.stringify(detail);
  }
  return '';
}

export function describeBackendError(error: unknown, action: string): Error {
  if (error instanceof Error) {
    const isConnectionFailure = isBackendUnreachable(error);
    if (isConnectionFailure) {
      return new Error(
        `${action} failed: could not reach the backend (it may still be starting, ` +
          `or it crashed processing this file). Check the backend status and try again.`,
      );
    }
    // A deadline abort already carries the endpoint, the elapsed budget and what
    // to do about it (see BackendTimeoutError) — only prefix the operation name.
    if (error instanceof BackendTimeoutError) {
      return new Error(`${action} timed out. ${error.message}`);
    }
    // A reason-less AbortError is a user-initiated cancel (the Cancel button
    // mirrors its signal into the request's controller without a reason).
    if (error.name === 'AbortError') {
      return new Error(`${action} was cancelled.`);
    }
    return error;
  }
  return new Error(`${action} failed: ${String(error)}`);
}

/**
 * Whether synthetic-scan ray tracing will run on the GPU or the CPU, and why.
 * The packaged Windows/Linux builds always contain the CUDA path (the release
 * CI fails otherwise) and macOS is always CPU-only, so the path is decided by a
 * runtime probe for a usable NVIDIA GPU (`gpuPresent`). See /api/device-info.
 */
export interface DeviceInfo {
  gpuPresent: boolean;
  gpuCount: number;
  gpuName: string | null;
  driverVersion: string | null;
  effectivePath: 'gpu' | 'cpu';
  reason: string;
}

export async function getDeviceInfo(signal?: AbortSignal): Promise<DeviceInfo> {
  const res = await fetch(`${getBackendUrl()}/api/device-info`, { signal });
  if (!res.ok) throw new Error(`device-info failed: ${res.status}`);
  const j = (await res.json()) as Record<string, unknown>;
  return {
    gpuPresent: j.gpu_present === true,
    gpuCount: typeof j.gpu_count === 'number' ? j.gpu_count : 0,
    gpuName: typeof j.gpu_name === 'string' ? j.gpu_name : null,
    driverVersion: typeof j.driver_version === 'string' ? j.driver_version : null,
    effectivePath: j.effective_path === 'gpu' ? 'gpu' : 'cpu',
    reason: typeof j.reason === 'string' ? j.reason : '',
  };
}

/**
 * Whether RIEGL raw-project (.riproject / .rxp) import is available here, and
 * why not when it isn't.
 *
 * Reading .rxp needs RIEGL's closed-source RiVLib, which has no macOS build, so
 * Phytograph runs it inside a linux/amd64 container. That makes the feature
 * conditional on three things at once — Docker reachable, the user's own RiVLib
 * supplied, and the image built from it — and RiVLib's licence forbids us from
 * shipping it, so this is a runtime probe rather than a build-time flag.
 * See /api/riegl/status.
 */
export interface RieglStatus {
  available: boolean;
  platformSupported: boolean;
  dockerPresent: boolean;
  imageBuilt: boolean;
  rivlibPath: string | null;
  rivlibValid: boolean;
  image: string;
  reason: string;
}

/**
 * Build the RIEGL reader Docker image from the bundled Dockerfile.
 *
 * The image is always built locally and never pulled: publishing it would mean
 * redistributing RiVLib, which its licence forbids. The build itself carries no
 * licensed bytes (RiVLib is bind-mounted at run time), so it is safe to re-run
 * and cheap on a warm cache.
 *
 * Streams PHP1 progress like every other long backend operation.
 */
export async function buildRieglImage(
  rivlibPath: string | null,
  opts?: ImportProgressOptions,
): Promise<{ ok: boolean; image: string }> {
  return fetchJsonWithProgress<{ ok: boolean; image: string }>(
    '/api/riegl/image/build',
    { rivlib_path: rivlibPath },
    opts?.signal,
    // Docker pulls a ~150 MB base image on a cold cache, so allow well beyond
    // the default; the backend enforces its own 30-minute ceiling.
    30 * 60 * 1000,
    opts?.onProgress,
    opts?.onRunId,
  );
}

/** One scan position inside a raw RIEGL project. */
/**
 * How well a scan position is placed.
 *
 * - `registered` — a real registration result (a .PROJ's plane or voxel .sopv).
 *   Placed to the registration's own accuracy, millimetres in practice.
 * - `prior` — only the inclinometer/compass/GNSS estimate. Metre-level; the
 *   user should refine it with ICP.
 * - `none` — no pose at all: an aborted acquisition, or any .riproject, which
 *   carries no registration whatsoever.
 */
export type RieglRegistration = 'registered' | 'prior' | 'none';

export type RieglFrame = 'local' | 'registered';

export interface RieglScanPosition {
  name: string;
  /** How this position is placed — see RieglRegistration. */
  registration?: RieglRegistration;
  /**
   * SOCS -> project-frame transform as a 4x4, row-major. Present only for a
   * .PROJ, and only when the position has a pose. The backend applies it; this
   * is here so the UI can describe the placement.
   */
  sop?: number[][];
  /**
   * project.json's own verdict on this position's registration, kept distinct
   * from `registration`: a position can be absent from the manifest entirely
   * (an aborted acquisition) and still hold perfectly good point data.
   */
  manifest_success?: boolean | null;
  /**
   * The cloud session the backend built for this position, present after
   * extraction. The importer streams points straight into a session — no
   * intermediate LAS is written, so there is no file for the renderer to
   * re-import (that round trip cost ~10 s and ~1.6 GB per position).
   */
  session?: CloudSessionMetadata;
  /** Exact after extraction; a bounded probe read during inspect. */
  point_count?: number;
  point_count_probed?: number;
  /**
   * Approximate count from the .rxp's size. A .PROJ preview reads no points at
   * all (all its metadata is in JSON sidecars), so this is the only figure
   * available before extraction — approximate, not a floor like
   * `point_count_probed`.
   */
  point_count_estimated?: number;
  size_bytes?: number;
  max_returns_per_pulse?: number;
  instrument?: { model?: string; serial?: string };
  /** The commanded scan pattern, from the position's .pat or .scn file. */
  scan_params?: ScanParamsFromFile & {
    theta_increment?: number;
    phi_increment?: number;
  };
  gnss?: {
    latitude: number;
    longitude: number;
    height_m: number;
    height_datum: string;
  } | null;
  /** Centroid-anchored ENU offset (metres) derived from the GNSS fix. */
  enu?: { east_m: number; north_m: number; up_m: number } | null;
  origin_prior?: [number, number, number];
  /** Set when pulse grouping disagreed with RiVLib's echo flags. */
  warning?: string;
  error?: string;
}

export interface RieglProject {
  project: string;
  rivlib_version: string;
  scan_count: number;
  gnss_anchor: {
    latitude: number;
    longitude: number;
    height_m: number;
  } | null;
  /** Which layout the backend detected. */
  layout?: 'riproject' | 'proj';
  /** The reader container's contract version. */
  reader_version?: number;
  /** The frame the points were placed in. */
  frame?: RieglFrame;
  /**
   * Whether ANY position carried a real registration. Always false for a
   * .riproject: raw scanner data carries no registration (that is what RiSCAN
   * PRO produces), so every position sits in its own frame and the
   * GNSS-derived `origin_prior` is a metres-level seed for ICP, not a
   * placement. A .PROJ reports what it actually found — check
   * `registered_count` and each position's `registration`, because a project
   * is routinely a mix.
   */
  registered: boolean;
  /** How many positions carried a real registration. */
  registered_count?: number;
  scans: RieglScanPosition[];
  /** Extraction only: the directory holding the written LAS files. */
  extract_dir?: string;
}

/** List a RIEGL project's scan positions without extracting point data. */
export async function inspectRieglProject(
  projectPath: string,
  rivlibPath: string | null,
  signal?: AbortSignal,
  frame: RieglFrame = 'registered',
): Promise<RieglProject> {
  const res = await fetch(`${getBackendUrl()}/api/riegl/project/inspect`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      project_path: projectPath,
      rivlib_path: rivlibPath,
      frame,
    }),
    signal,
  });
  if (!res.ok) {
    // 503 carries the capability remediation ("start Docker", "choose a RiVLib
    // folder"); surface it verbatim rather than a generic status message.
    const detail = await res.json().catch(() => null);
    throw new Error(detail?.detail ?? `riegl inspect failed: ${res.status}`);
  }
  return (await res.json()) as RieglProject;
}

/**
 * Extract the chosen scan positions to LAS, one file per position.
 *
 * Each written file is an ordinary point cloud: the caller imports it through
 * the normal `parsePointCloudFromPath` path, so nothing downstream has to know
 * what a .riproject is.
 */
export async function extractRieglProject(
  projectPath: string,
  scans: string[] | null,
  rivlibPath: string | null,
  /**
   * Scalar columns to keep, from the import wizard. null/undefined keeps
   * everything the scanner recorded. `is_miss` is always retained regardless —
   * it is a system flag driving the Hit/Miss scheme and the octree exclusion,
   * not a user column.
   */
  keepColumns?: string[] | null | ImportProgressOptions,
  opts?: ImportProgressOptions,
  /**
   * `registered` applies each position's SOP so a .PROJ's scans land
   * pre-aligned; `local` keeps scanner-local coordinates, which is all a
   * .riproject can offer and what a user wanting the exact LAD raster picks.
   */
  frame: RieglFrame = 'registered',
): Promise<RieglProject> {
  // Tolerate the options object being passed in the keepColumns position.
  // A caller written against the older 4-arg signature does exactly that, and
  // the failure mode was ugly: the object reached the backend as
  // `keep_columns`, which 422'd with "Input should be a valid list" — rendered
  // in the UI as "[object Object]". Detecting it here costs nothing and turns a
  // silent shape mismatch into correct behaviour.
  let keep: string[] | null = null;
  let options = opts;
  if (Array.isArray(keepColumns)) {
    keep = keepColumns;
  } else if (keepColumns && typeof keepColumns === 'object') {
    options = keepColumns as ImportProgressOptions;
  }

  return fetchJsonWithProgress<RieglProject>(
    '/api/riegl/project/extract',
    {
      project_path: projectPath,
      scans,
      rivlib_path: rivlibPath,
      keep_columns: keep,
      frame,
    },
    options?.signal,
    // ~14 M points per position, plus LAS writing, under x86 emulation: a
    // six-position project runs into the minutes. The backend enforces its own
    // one-hour ceiling.
    60 * 60 * 1000,
    options?.onProgress,
    options?.onRunId,
  );
}

export async function getRieglStatus(
  rivlibPath?: string | null,
  signal?: AbortSignal,
): Promise<RieglStatus> {
  // The path travels per request because the backend sidecar is spawned once at
  // launch: passing it in the environment would go stale as soon as the user
  // picked a different folder, and only an app restart would pick it up.
  const url = new URL(`${getBackendUrl()}/api/riegl/status`);
  if (rivlibPath) url.searchParams.set('rivlib_path', rivlibPath);

  const res = await fetch(url.toString(), { signal });
  if (!res.ok) throw new Error(`riegl-status failed: ${res.status}`);
  const j = (await res.json()) as Record<string, unknown>;
  // Validate every field: a backend that omits one should yield a safe default
  // (i.e. "not available"), never `undefined` leaking into the UI.
  return {
    available: j.available === true,
    platformSupported: j.platform_supported === true,
    dockerPresent: j.docker_present === true,
    imageBuilt: j.image_built === true,
    rivlibPath: typeof j.rivlib_path === 'string' ? j.rivlib_path : null,
    rivlibValid: j.rivlib_valid === true,
    image: typeof j.image === 'string' ? j.image : '',
    reason: typeof j.reason === 'string' ? j.reason : '',
  };
}

/**
 * Send triangulation request to backend API
 */
export async function triangulatePointCloud(
  request: TriangulationRequest,
  signal?: AbortSignal,
  onProgress?: BinaryFrameProgress,
  onRunId?: (runId: string) => void,
): Promise<TriangulationResult> {
  const { meta, buffers } = await fetchBinaryFrame('/api/triangulate', request, signal, 600000, onProgress, onRunId);
  if (!meta.success) {
    return {
      success: false,
      error: (meta.error as string) ?? 'Triangulation failed',
      vertices: new Float32Array(0),
      triangles: new Uint32Array(0),
      numTriangles: 0,
      numVertices: 0,
      methodUsed: (meta.method_used as string) ?? request.method,
      pointsUsed: meta.points_used as number | undefined,
    };
  }
  return {
    success: true,
    vertices: (buffers.vertices as Float32Array) ?? new Float32Array(0),
    triangles: (buffers.indices as Uint32Array) ?? new Uint32Array(0),
    normals: buffers.normals as Float32Array | undefined,
    surfaceArea: meta.surface_area as number | undefined,
    numTriangles: meta.num_triangles as number,
    numVertices: meta.num_vertices as number,
    methodUsed: meta.method_used as string,
    pointsUsed: meta.points_used as number | undefined,
    downsampled: meta.downsampled as boolean | undefined,
    triangleCellIds: buffers.triangle_cell_ids as Uint32Array | undefined,
  };
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
  // Measure the tolerance off the settled cloth instead of using
  // `class_threshold`. The seeded value scales with the cloud's horizontal
  // extent, which is unrelated to how thick the ground return band actually is.
  auto_class_threshold?: boolean;
}

export interface GroundSegmentationResponse {
  success: boolean;
  labels: number[];   // 1=ground, 2=plant, aligned to resolved point order
  num_ground: number;
  num_plant: number;
  num_points: number;
  error?: string;
  // What the run actually used, and how it was chosen:
  // 'manual' | 'knee' | 'tail' | 'fallback'.
  class_threshold_used?: number;
  class_threshold_method?: string;
}

export async function segmentGround(
  request: GroundSegmentationRequest,
  signal?: AbortSignal
): Promise<GroundSegmentationResponse> {
  return postSegment<GroundSegmentationResponse>('/api/segment/ground', request, signal);
}

// ==================== DEM (DIGITAL ELEVATION MODEL) API ====================

export type DemInterpMethod = 'tin' | 'idw' | 'nearest';

// Which surface product to build: DTM (bare-earth ground), DSM (first-return /
// top-of-canopy), CHM (canopy height = DSM − DTM). A DTM additionally carries a
// bundle of scalar LAYERS (density/intensity/hillshade/slope/aspect) — see
// DemLayer — that the renderer colours the terrain by and exports as rasters.
export type DemSurfaceType = 'dtm' | 'dsm' | 'chm';

export interface DemGenerateRequest {
  points?: number[][];          // flat clouds — omit when `source` is set
  source?: BackendPointSource;  // octree-backed clouds read from disk
  ground_labels?: number[];     // 1=ground; restricts gridding to ground points
  // Per-point return index (0 = first return) aligned to `points`; feeds the DSM /
  // CHM first-return surface. Omit for single-return clouds (all treated as first).
  first_return_labels?: number[];
  // Per-point intensity aligned to `points`; feeds the intensity raster. Omit when
  // not building an intensity surface (or when the cloud carries no intensity).
  intensity?: number[];
  surface_type?: DemSurfaceType;
  auto_segment_ground?: boolean;
  cloth_resolution?: number;
  rigidness?: number;
  class_threshold?: number;
  cell_size?: number | null;
  bbox?: number[] | null;
  method?: DemInterpMethod;
  ground_percentile?: number;
  fill_voids?: boolean;
  // Also return a per-point height-above-ground buffer (gap-free ground under
  // every point). Used by the flat-cloud CHM path.
  compute_height_above_ground?: boolean;
}

export interface DemSessionRequest {
  surface_type?: DemSurfaceType;  // 'dtm' (default) | 'dsm' | 'chm'
  auto_segment_ground?: boolean;
  cloth_resolution?: number;
  rigidness?: number;
  class_threshold?: number;
  cell_size?: number | null;
  bbox?: number[] | null;
  method?: DemInterpMethod;
  ground_percentile?: number;
  fill_voids?: boolean;
  add_height_column?: boolean;  // also write height_above_ground + rebuild octree
}

// The regular DEM grid, kept alongside the surface mesh so raster export can
// reconstruct the raster (the mesh has lost the grid structure). `z` is
// row-major (ny*nx), row 0 = min y, with NaN for void cells. `origin` is the
// lower-left corner in the cloud's DISPLAY coordinates; `worldShift` re-adds the
// import-time global shift to recover true-world coordinates for georeferencing.
export interface DemGrid {
  z: Float32Array;
  nx: number;
  ny: number;
  cellSize: number;
  origin: [number, number];
  worldShift: [number, number, number];
  // EPSG code of the source cloud's CRS (from the LAS/LAZ header), when known —
  // written into the GeoTIFF for georeferencing. null/undefined when unknown.
  crsEpsg?: number | null;
}

// One scalar layer of a DTM surface (elevation / point density / return density /
// intensity / hillshade / slope / aspect). `grid` is the per-cell raster (for
// export); `vertexValues` is one value per mesh vertex (for colouring the surface,
// aligned 1:1 with `vertices`); `min`/`max` bound the colorbar; `label` is the
// human-readable caption.
export interface DemLayer {
  grid: DemGrid;
  vertexValues: Float32Array;
  min: number;
  max: number;
  label: string;
}

export interface DemResult {
  success: boolean;
  error?: string;
  vertices: Float32Array;
  triangles: Uint32Array;
  normals?: Float32Array;
  surfaceArea?: number;
  numVertices: number;
  numTriangles: number;
  surfaceType?: DemSurfaceType;  // which product was built ('dtm'|'dsm'|'chm')
  groundSource?: string;   // "column" | "csf_auto" | "all_points"
  surfaceSource?: string;  // DSM/CHM first-return provenance ("first_return"|"all_points")
  warning?: string;
  grid?: DemGrid;
  // DTM scalar layers (name → layer). The renderer colours the terrain by the
  // selected layer and exports any of them as a raster. Present only for a DTM.
  layers?: Record<string, DemLayer>;
  // Per-point height-above-ground (point z − gap-free ground), aligned to the
  // resolved points. Present when compute_height_above_ground was set (flat path).
  heightAboveGround?: Float32Array;
  // Set only when a session DEM wrote a height_above_ground column and rebuilt:
  cacheId?: string;
  pointCount?: number;
  // Raw frame meta (octree fields etc.) for buildSessionOctreeData after a rebuild.
  rawMeta?: Record<string, unknown>;
}

function decodeDemFrame(meta: Record<string, unknown>, buffers: Record<string, ArrayBufferView>): DemResult {
  if (!meta.success) {
    return {
      success: false,
      error: (meta.error as string) ?? 'DEM generation failed',
      vertices: new Float32Array(0),
      triangles: new Uint32Array(0),
      numVertices: 0,
      numTriangles: 0,
    };
  }
  const gridZ = buffers.grid_z as Float32Array | undefined;
  const origin = (meta.grid_origin as number[]) ?? [0, 0];
  const ws = (meta.world_shift as number[]) ?? [0, 0, 0];
  // Shared grid geometry for the surface grid + every layer grid (they align).
  const gridGeom = {
    nx: meta.grid_nx as number,
    ny: meta.grid_ny as number,
    cellSize: meta.grid_cell as number,
    origin: [origin[0], origin[1]] as [number, number],
    worldShift: [ws[0], ws[1], ws[2]] as [number, number, number],
    crsEpsg: (meta.crs_epsg as number | undefined) ?? null,
  };

  // Decode the DTM scalar layers (meta.layers lists min/max/label per name; the
  // per-cell grid + per-vertex arrays ride as layer_grid_<name> / layer_vert_<name>).
  const layerMeta = meta.layers as Record<string, { min: number; max: number; label: string }> | undefined;
  let layers: Record<string, DemLayer> | undefined;
  if (layerMeta) {
    layers = {};
    for (const [name, info] of Object.entries(layerMeta)) {
      const grid = buffers[`layer_grid_${name}`] as Float32Array | undefined;
      const vertexValues = buffers[`layer_vert_${name}`] as Float32Array | undefined;
      if (!grid || !vertexValues) continue;
      layers[name] = {
        grid: { z: grid, ...gridGeom },
        vertexValues,
        min: info.min,
        max: info.max,
        label: info.label,
      };
    }
  }

  return {
    success: true,
    vertices: (buffers.vertices as Float32Array) ?? new Float32Array(0),
    triangles: (buffers.indices as Uint32Array) ?? new Uint32Array(0),
    normals: buffers.normals as Float32Array | undefined,
    surfaceArea: meta.surface_area as number | undefined,
    numVertices: meta.num_vertices as number,
    numTriangles: meta.num_triangles as number,
    surfaceType: meta.surface_type as DemSurfaceType | undefined,
    groundSource: meta.ground_source as string | undefined,
    surfaceSource: meta.surface_source as string | undefined,
    warning: meta.warning as string | undefined,
    heightAboveGround: buffers.hag as Float32Array | undefined,
    grid: gridZ ? { z: gridZ, ...gridGeom } : undefined,
    layers,
    cacheId: meta.cache_id as string | undefined,
    pointCount: meta.point_count as number | undefined,
    rawMeta: meta,
  };
}

/** Generate a DEM from a flat cloud (inline points / source). Returns a
 * heightmap surface mesh + the regular grid (PHB1 binary frame). */
export async function generateDEM(
  request: DemGenerateRequest,
  signal?: AbortSignal,
  onProgress?: BinaryFrameProgress,
  onRunId?: (runId: string) => void,
): Promise<DemResult> {
  const { meta, buffers } = await fetchBinaryFrame('/api/dem', request, signal, 600000, onProgress, onRunId);
  return decodeDemFrame(meta, buffers);
}

/** Generate a DEM from a session's in-RAM survivors (ground-aware). When
 * `add_height_column`, also appends a height_above_ground scalar and rebuilds
 * the octree (cacheId in the result). */
export async function generateSessionDEM(
  sessionId: string,
  request: DemSessionRequest,
  signal?: AbortSignal,
  onProgress?: BinaryFrameProgress,
  onRunId?: (runId: string) => void,
): Promise<DemResult> {
  const { meta, buffers } = await fetchBinaryFrame(
    `/api/cloud/session/${sessionId}/dem`, request, signal, 600000, onProgress, onRunId);
  return decodeDemFrame(meta, buffers);
}

export interface DemRasterExportRequest {
  format: 'asc' | 'tif';
  grid_z: number[];         // row-major (ny*nx); voids encoded as `nodata`
  nx: number;
  ny: number;
  cell_size: number;
  origin: [number, number]; // true-world lower-left corner
  nodata?: number;
  crs_epsg?: number | null;
}

/** Write a DEM grid to ESRI ASCII (.asc) or GeoTIFF (.tif); returns the file
 * bytes (base64) for the renderer to save via the main-process fs bridge. */
export async function exportDemRaster(
  request: DemRasterExportRequest,
): Promise<{ success: boolean; format: string; data_base64: string }> {
  const baseUrl = getBackendUrl();
  const controller = new AbortController();
  const timeoutId = abortOnTimeout(controller, 120000, '/api/dem/export-raster');
  try {
    const response = await fetch(`${baseUrl}/api/dem/export-raster`, {
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
    console.error('DEM raster export failed:', error);
    throw error;
  }
}

// ==================== TRAJECTORY PARSE API ====================
// Parse a binary trajectory file (SBET .sbet/.out) server-side into the canonical
// PoseStream wire shape. Binary parsing lives on the backend (it needs pyproj for
// the geographic->UTM projection); text trajectories are parsed in the renderer.
// `path` is a server-readable file path (same as the cloud-import endpoints).
export async function parseTrajectory(
  path: string,
  options?: { smrmsgPath?: string; targetPoses?: number }
): Promise<unknown> {
  const baseUrl = getBackendUrl();
  const controller = new AbortController();
  const timeoutId = abortOnTimeout(controller, 120000, '/api/trajectory/parse'); // 2 minutes

  try {
    const response = await fetch(`${baseUrl}/api/trajectory/parse`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        path,
        smrmsg_path: options?.smrmsgPath,
        target_poses: options?.targetPoses,
      }),
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
    console.error('Trajectory parse failed:', error);
    throw error;
  }
}

// ==================== WOOD/LEAF SEGMENTATION API ====================

/**
 * Classify a point cloud into wood (1, trunk/branches) and leaf (2) points from
 * XYZ geometry alone (verticality + low-sphericity; non-ML). Send inline
 * `points` for flat clouds or a `source` descriptor for octree-backed clouds
 * (the backend re-reads the file at full resolution; labels align 1:1 with the
 * resolved point order). `wood_bias` is the wood-vs-leaf sensitivity (lower →
 * more wood); `reg_iters` the smoothing strength; `voxel_size` (>0) enables
 * downsample-classify-propagate for very large clouds.
 */
export interface WoodSegmentationRequest {
  points?: number[][];          // [[x, y, z], ...] — omit when `source` is set
  source?: BackendPointSource;  // octree-backed clouds read from disk
  // Aggregate: several pre-registered scans segmented TOGETHER. Read and
  // concatenated in order; `source_counts` in the response lets the caller
  // slice the labels back per scan. Takes precedence over points/source.
  sources?: BackendPointSource[];
  k_min?: number;
  k_max?: number;
  k_step?: number;
  wood_bias?: number;
  reg_k?: number;
  reg_iters?: number;
  min_speckle?: number;
  voxel_size?: number;
  // REFLECTANCE ASSIST: when the cloud carries a per-point reflectance/intensity
  // scalar, supplement the geometric score with it — auto-weighted per cloud by
  // how separable wood/leaf are in the reflectance (≈0 on low-contrast species,
  // so it never hurts). `reflectance` is the inline path (aligned 1:1 with
  // `points`); for `source`/`sources`/session clouds the backend re-reads it
  // (`scalar_slug` picks which session extra-dim). `reflectance_weight_max`
  // caps the blend (0 disables the assist).
  reflectance?: number[];
  scalar_slug?: string;
  reflectance_weight_max?: number;
  // METHOD: 'sota' (default) = segment-wise classifier — skeleton branch-segments
  // classified by cylinder-fit quality, recovering thin branches without flooding
  // leaves; 'connectivity' = geodesic-skeleton backbone recovery; 'geometric' =
  // original point-wise classifier. 'sota'/'connectivity' need the ground removed.
  // `backbone_support` (0 = auto) tunes connectivity's isolated-false-wood pruning.
  method?: 'sota' | 'connectivity' | 'geometric';
  backbone_support?: number;
}

export interface WoodSegmentationResponse {
  success: boolean;
  labels: number[];   // 1=wood, 2=leaf, aligned to resolved point order
  num_wood: number;
  num_leaf: number;
  num_points: number;
  source_counts: number[];  // per-source point counts (aggregate); else []
  // Non-fatal advisories from the connectivity method (e.g. base looks like
  // un-removed ground). Surfaced as a warning toast; the result is still valid.
  warnings?: string[];
  error?: string;
}

export async function segmentWood(
  request: WoodSegmentationRequest,
  signal?: AbortSignal
): Promise<WoodSegmentationResponse> {
  return postSegment<WoodSegmentationResponse>('/api/segment/wood', request, signal);
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
  ground_class?: number[];      // per-point ground/plant labels (1=ground) to exclude
  // Confirms an expensive run. When the workload is above the cost guideline the
  // backend returns a `cost_warning` (inline) / 409 `CostWarningError` (session)
  // instead of running; re-send with this true to proceed. Not a cap — purely a
  // "are you sure" step, so any workload can ultimately run.
  acknowledge_cost?: boolean;

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
  // Set (with success=false and no error) when the run needs confirmation.
  // Re-send with `acknowledge_cost: true` to proceed.
  cost_warning?: TreeCostWarning;
  error?: string;
}

export async function segmentTrees(
  request: TreeSegmentationRequest,
  signal?: AbortSignal
): Promise<TreeSegmentationResponse> {
  return postSegment<TreeSegmentationResponse>('/api/segment/trees', request, signal);
}

// ==================== HELIOS TRIANGULATION API ====================

export interface HeliosScanEntry {
  // Point-data source priority (backend resolves session → file → points):
  //   session_id — a session-backed (octree) cloud; the backend triangulates its
  //     in-RAM surviving HIT points (deletions honored, misses excluded). This is
  //     the source of truth after any edit (crop/erase/backfill/segment), so the
  //     file is never re-read, and file_path is NOT sent alongside it — a stale
  //     session must fail loudly, not silently fall back to the pre-edit file.
  session_id?: string | null;
  file_path?: string;       // Path to scan file on disk (cloud that never had a session)
  ascii_format?: string | null;  // Column format e.g. "x y z timestamp" (auto-detected if omitted/null)
  points?: number[][];      // [[x, y, z], ...] flat in-RAM cloud (no session, no file)
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
  // Azimuthal rotation about +z, in degrees. Optional — omitted for
  // axis-aligned grids. Carried so a rotated grid round-trips into the
  // Helios XML's <rotation> tag on scan export.
  rotation?: number;
  // Per-(x,y)-column z offsets for a terrain-following ("snapped") grid,
  // row-major [j*nx + i], length nx*ny. When present these are authoritative —
  // the backend uses them verbatim (no DEM re-sampling). `kept_columns` marks
  // columns inside the DEM footprint (false = dropped). Both come from
  // /api/lad/snap-grid via the grid mesh's gridGroundSnap.
  column_offsets?: number[];
  kept_columns?: boolean[];
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
  // Snapped-grid only: `grid` is the flat envelope Helios crops/triangulates
  // within; `bin_grid` is the actual SNAPPED grid (with column_offsets) the backend
  // bins triangles into so it can drop the ground-below / canopy-above triangles the
  // flat crop admits. Omitted for non-snapped grids (binned against `grid`).
  bin_grid?: HeliosGrid;
}

// Auto-estimate fields as returned by the backend.
export interface HeliosFilterEstimateDTO {
  lmax: number | null;
  eta: number;
  label: string;
  sep_ratio?: number | null;
  sep_label?: string;
  merged: boolean;
  merged_message?: string | null;
}

export interface HeliosTriangulationDiagnostics {
  candidates: number;          // pre-filter triangle count
  kept: number;                // survivors (=== num_triangles)
  dropped_lmax: number;        // dropped: an edge exceeded Lmax
  dropped_aspect: number;      // dropped: aspect-ratio / separation-ratio limit
  dropped_degenerate: number;  // dropped: degenerate (NaN) area
}

// Decoded Helios triangulation result. The big arrays arrive as zero-copy
// typed-array views over the PHB1 binary frame (no .flat()/JSON.parse).
export interface HeliosTriangulationResult {
  success: boolean;
  error?: string;
  vertices: Float32Array;          // flat xyz (numVertices*3)
  triangles: Uint32Array;          // flat indices (numTriangles*3)
  triangleScanIds?: Uint32Array;   // source scan per triangle
  triangleCellIds?: Uint32Array;   // grid cell per triangle (0xffffffff = outside)
  numTriangles: number;
  numVertices: number;
  surfaceArea?: number;
  // Interactive-filter support — see lib/triangleFilter.ts.
  capLmax: number;
  capAspect: number;
  candidateCount: number;
  estimate?: HeliosFilterEstimateDTO | null;
  diagnostics?: HeliosTriangulationDiagnostics;
  gridWarning?: boolean;
  gridMessage?: string | null;
}

/**
 * Send Helios triangulation request to the backend (PyHelios spherical hull
 * triangulation). The response is a PHB1 binary frame decoded to typed arrays.
 */
export async function heliosTriangulate(
  request: HeliosTriangulationRequest,
  signal?: AbortSignal,
  onProgress?: BinaryFrameProgress,
  onRunId?: (runId: string) => void,
): Promise<HeliosTriangulationResult> {
  const { meta, buffers } = await fetchBinaryFrame('/api/triangulate/helios', request, signal, 600000, onProgress, onRunId);
  if (!meta.success) {
    return {
      success: false,
      error: (meta.error as string) ?? 'Triangulation failed',
      vertices: new Float32Array(0),
      triangles: new Uint32Array(0),
      numTriangles: 0,
      numVertices: 0,
      capLmax: 0,
      capAspect: 0,
      candidateCount: 0,
      diagnostics: meta.diagnostics as HeliosTriangulationDiagnostics | undefined,
      gridWarning: meta.grid_warning as boolean | undefined,
      gridMessage: meta.grid_message as string | null | undefined,
    };
  }
  return {
    success: true,
    vertices: (buffers.vertices as Float32Array) ?? new Float32Array(0),
    triangles: (buffers.triangles as Uint32Array) ?? new Uint32Array(0),
    triangleScanIds: buffers.triangle_scan_ids as Uint32Array | undefined,
    triangleCellIds: buffers.triangle_cell_ids as Uint32Array | undefined,
    numTriangles: meta.num_triangles as number,
    numVertices: meta.num_vertices as number,
    surfaceArea: meta.surface_area as number | undefined,
    capLmax: meta.cap_lmax as number,
    capAspect: meta.cap_aspect as number,
    candidateCount: meta.candidate_count as number,
    estimate: meta.estimate as HeliosFilterEstimateDTO | null | undefined,
    diagnostics: meta.diagnostics as HeliosTriangulationDiagnostics | undefined,
    gridWarning: meta.grid_warning as boolean | undefined,
    gridMessage: meta.grid_message as string | null | undefined,
  };
}

// Lmax is no longer suggested by a separate (slow) backend endpoint: the
// triangulation now returns every candidate triangle plus per-triangle metrics,
// so the auto-estimate (Otsu separability + merged-cloud guard) runs instantly
// once during the main triangulation run and returned in `estimate`.

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
  // Moving-platform trajectory (backend `PoseStream` wire shape). When present
  // this scan is a moving-platform acquisition: the backend reconstructs a
  // per-beam emission origin for every return by joining its timestamp to this
  // trajectory and runs the beam-based (Gtheta) inversion (no triangulation).
  // `origin` is then only a fallback anchor. Build it via poseStreamToWire().
  trajectory?: unknown;
}

// A DEM elevation raster sent to terrain-following LAD. Mirrors the backend
// DemRaster model. `grid_z` is row-major (row 0 = min y), `origin` is the world
// lower-left corner [minx, miny], and voids are encoded as `nodata` (JSON can't
// carry NaN). Built from a DEM MeshEntry's demGrid (origin shifted to world).
export interface LADDemRaster {
  grid_z: number[];
  nx: number;
  ny: number;
  cell: number;
  origin: [number, number];
  nodata?: number;
}

// "Snap to ground": ask the backend to sample a DEM under each voxel column so
// the grid can be displaced to follow the terrain. The returned offsets are
// rendered in the viewport AND fed back to LAD verbatim (single source of truth).
export interface SnapGridRequest {
  grid: HeliosGrid;
  dem: LADDemRaster;
  safety_fraction: number;
}

export interface SnapGridResponse {
  column_offsets: number[];  // row-major [j*nx + i], len nx*ny, world-z meters
  kept_columns: boolean[];   // false = column outside the DEM footprint (dropped)
  dropped_columns: number;
}

export async function snapGridToGround(
  request: SnapGridRequest,
): Promise<SnapGridResponse> {
  const baseUrl = getBackendUrl();
  const response = await fetch(`${baseUrl}/api/lad/snap-grid`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(request),
  });
  if (!response.ok) {
    const errorData = await response.json().catch(() => ({}));
    throw new Error(errorData.detail || `HTTP ${response.status}: ${response.statusText}`);
  }
  return await response.json();
}

// ---- Direct G(theta) / leaf-angle-distribution override -------------------
// The third triangulation source (alongside "run a new triangulation" and
// "reuse a triangulation"): specify the leaf-angle distribution / G(theta)
// directly, either constant across the grid or as a vertical profile (per
// z-level), with G(theta) given as a constant value, derived from a de Wit
// classical distribution, or derived from Beta (Goel-Strebel) parameters.
export type DeWitDistribution =
  | 'spherical' | 'planophile' | 'erectophile'
  | 'plagiophile' | 'extremophile' | 'uniform';

export interface GThetaValueSpec {
  kind: 'constant' | 'dewit' | 'beta';
  value?: number;               // kind='constant', in (0,1]
  dewit?: DeWitDistribution;    // kind='dewit'
  beta_mu?: number;             // kind='beta' (toward-horizontal weight)
  beta_nu?: number;             // kind='beta' (toward-vertical weight)
}

export interface GThetaOverrideSpec {
  spatial: 'constant' | 'profile';
  spec?: GThetaValueSpec;          // spatial='constant'
  profile?: GThetaValueSpec[];     // spatial='profile', length === grid.nz (z0 = lowest)
}

export interface LADRequest {
  scans: LADScanEntry[];
  grid: HeliosGrid;              // REQUIRED — the LAD voxel grid
  lmax: number;                 // max triangle edge length (G-function)
  max_aspect_ratio: number;     // max triangle aspect ratio
  min_voxel_hits: number;       // min ray hits for a voxel to be solved
  // Characteristic vegetation element width (m), e.g. broadleaf ≈ 0.05, conifer
  // ≈ 0.002. Drives the Pimont et al. (2018) per-voxel sampling uncertainty.
  element_width?: number;
  // Request-level angular fallbacks (degrees) for scans lacking their own.
  theta_min: number;
  theta_max: number;
  phi_min: number;
  phi_max: number;
  // Mean leaf-projection coefficient G(theta), in (0, 1] (0.5 = spherical).
  // Required only for moving-platform scans, whose pulses can't be triangulated
  // to derive G(theta) per cell. Ignored for static scans.
  gtheta?: number;
  // Direct G(theta) override (the third triangulation source). When set, it
  // selects the supplied-G(theta) inversion path and wins over `gtheta`.
  gtheta_spec?: GThetaOverrideSpec;
  // Terrain following: when true (with a DEM), each voxel column rides the DEM
  // surface. `safety_fraction` is the clearance between the surface and the lowest
  // cell, as a fraction of one cell's height. `dem` is required when enabled.
  terrain_follow?: boolean;
  safety_fraction?: number;
  dem?: LADDemRaster;
}

export interface LADVoxelResult {
  index: number;
  center: [number, number, number];
  size: [number, number, number];
  leaf_area: number;   // m²
  lad: number;         // m²/m³
  gtheta: number;      // G(theta)
  hit_count: number;
  // Pimont et al. (2018) per-voxel sampling uncertainty. null/absent when
  // undefined for the cell (unsolved voxel, or outside the validity range).
  beam_count?: number | null;
  relative_density_index?: number | null;
  mean_path_length?: number | null;
  lad_variance?: number | null;       // (1/m)²
  lad_std?: number | null;            // sqrt(lad_variance)
  ci_valid?: boolean | null;
  leaf_area_ci_lower?: number | null; // m² (only when ci_valid)
  leaf_area_ci_upper?: number | null; // m² (only when ci_valid)
}

export interface LADResponse {
  success: boolean;
  cells: LADVoxelResult[];
  nx: number;
  ny: number;
  nz: number;
  grid_center: number[];
  grid_size: number[];
  // Azimuthal rotation of the grid box about +z (degrees). Non-zero for a
  // rotated voxel grid; the renderer orients each result voxel cube by it so the
  // LAD grid aligns with the original (rotated) grid mesh. Omitted/0 = axis-aligned.
  grid_rotation?: number;
  bounds: number[][];          // [[lo...], [hi...]]
  is_multi_return: boolean;
  return_mode: string;         // "single" | "multi"
  total_leaf_area: number;
  method_used: string;
  // Group-scale LAD confidence interval (Pimont et al. 2018, Eq. 39) over solved
  // voxels — the recommended aggregate. group_ci_valid=false => not reported.
  group_ci_valid?: boolean | null;
  group_lad_mean?: number | null;       // m²/m³
  group_lad_ci_lower?: number | null;   // m²/m³
  group_lad_ci_upper?: number | null;   // m²/m³
  confidence_level?: number | null;     // e.g. 0.95
  element_width?: number | null;        // width used (m)
  // Resolved G(theta) per z-level when a vertical-profile override was used
  // (index 0 = lowest band). null/absent otherwise.
  gtheta_profile?: number[] | null;
  warnings: string[];
  error?: string;
}

/**
 * Compute per-voxel leaf area density via the PyHelios LiDAR plugin.
 * Mirrors heliosTriangulate: long timeout, and the StreamingResponse body is
 * leading PHP1 progress markers (reported via `onProgress`) followed by the JSON
 * result. See fetchJsonWithProgress.
 */
export async function computeLAD(
  request: LADRequest,
  signal?: AbortSignal,
  onProgress?: BinaryFrameProgress,
  onRunId?: (runId: string) => void,
  // When reusing a previously-run triangulation, the indexed mesh + per-triangle
  // scan ids to inject. The request is then sent as a PHB1 binary frame (request
  // fields in the header, mesh as raw buffers) so a 1M+ triangle mesh rides back
  // compactly and the backend injects it instead of re-triangulating.
  reuseMesh?: { vertices: Float32Array; indices: Uint32Array; scanIds: Int32Array } | null,
): Promise<LADResponse> {
  console.log('LAD compute - scans:', request.scans.length,
    'grid:', `${request.grid.nx}×${request.grid.ny}×${request.grid.nz}`,
    reuseMesh ? `(reuse ${reuseMesh.indices.length / 3} tris)` : '');
  try {
    if (reuseMesh) {
      // The PHB1 frame format carries f32/u32 buffers; scan ids are non-negative
      // small ints, so send them as u32 (the backend reads them back as int32).
      const frame = encodeBinaryFrame(request as unknown as Record<string, unknown>, [
        { name: 'mesh_vertices', data: reuseMesh.vertices },
        { name: 'mesh_indices', data: reuseMesh.indices },
        { name: 'mesh_scan_ids', data: new Uint32Array(reuseMesh.scanIds.buffer, reuseMesh.scanIds.byteOffset, reuseMesh.scanIds.length) },
      ]);
      return await fetchJsonWithProgress<LADResponse>(
        '/api/lad/compute', request, signal, 600000, onProgress, onRunId, frame);
    }
    return await fetchJsonWithProgress<LADResponse>(
      '/api/lad/compute', request, signal, 600000, onProgress, onRunId);
  } catch (error) {
    console.error('LAD computation failed:', error);
    throw error;
  }
}

// ==================== TRIANGULATION SPACING CHECK ====================

// Verdict from /api/triangulate/check-spacing — an opt-in cross-check of the
// auto-estimated Lmax against the actual in-grid point spacing. Offered as a
// button when the Otsu indicators (separation confidence / mode separation)
// aren't both High, because that's when the edge-based estimate can silently
// overshoot on a sparsely-sampled surface (bridging across the gaps), which
// corrupts the leaf normals and G(theta). Potentially expensive (a KD-tree over
// up to tens of millions of points), hence opt-in rather than automatic.
export interface SpacingCheckResult {
  success: boolean;
  medianSpacing?: number;    // median NN distance (m) of in-grid points
  lmax: number;              // the Lmax this verdict was checked against
  ratio?: number;            // lmax / medianSpacing
  nPoints: number;           // in-grid points the spacing was measured on
  likelyBridging: boolean;   // true when ratio is large enough to suspect bridging
  message?: string;
  error?: string;
}

/**
 * Cross-check a triangulation's Lmax against the real point spacing inside the
 * grid. Reuses the HeliosTriangulationRequest so the caller passes the exact
 * scans + grid + lmax it triangulated with. The backend streams keepalive
 * whitespace during the (possibly long) KD-tree pass; response.json() tolerates
 * the leading whitespace.
 */
export async function checkTriangulationSpacing(
  request: HeliosTriangulationRequest,
  signal?: AbortSignal,
): Promise<SpacingCheckResult> {
  const baseUrl = getBackendUrl();
  const response = await fetch(`${baseUrl}/api/triangulate/check-spacing`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(request),
    signal,
  });
  if (!response.ok) {
    const errorData = await response.json().catch(() => ({}));
    throw new Error(errorData.detail || `HTTP ${response.status}: ${response.statusText}`);
  }
  const r = await response.json();
  return {
    success: r.success,
    medianSpacing: r.median_spacing ?? undefined,
    lmax: r.lmax,
    ratio: r.ratio ?? undefined,
    nPoints: r.n_points ?? 0,
    likelyBridging: !!r.likely_bridging,
    message: r.message ?? undefined,
    error: r.error ?? undefined,
  };
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
  request: SkeletonRequest,
  signal?: AbortSignal
): Promise<SkeletonResponse> {
  return postSegment<SkeletonResponse>('/api/skeleton/extract', request, signal);
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
  const timeoutId = abortOnTimeout(controller, 300000, '/api/plant/generate'); // 5 minutes

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
  const timeoutId = abortOnTimeout(controller, 300000, '/api/plant/canopy/generate'); // 5 minutes

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
  onRunId?: (runId: string) => void,
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

        if (eventType === 'run_id') {
          const parsed = JSON.parse(data);
          if (parsed.run_id && onRunId) onRunId(parsed.run_id);
        } else if (eventType === 'progress') {
          const parsed = JSON.parse(data);
          onProgress(parsed.progress, parsed.message);
        } else if (eventType === 'result') {
          return JSON.parse(data) as PlantGenerationResponse;
        } else if (eventType === 'cancelled') {
          // The backend aborted the build and freed its memory — surface a typed
          // cancel so the caller treats it as a no-op, not a failure.
          throw new ScanCancelledError();
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
  const timeoutId = abortOnTimeout(controller, 60000, '/api/plant/session/create');

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
  const timeoutId = abortOnTimeout(controller, 60000, '/api/plant/session/:id/advance');

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
  const timeoutId = abortOnTimeout(controller, 300000, '/api/plant/morph'); // 5 minutes

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

// One textured material on a scan mesh. `texture_data` is a base64-encoded
// image (PNG/JPG); when it has an alpha channel, Helios uses that channel as a
// transparency mask during ray tracing (leaf-shaped cutouts), so the scan only
// returns hits where the leaf is opaque. `triangle_indices` are ordinals into
// the mesh's `triangles` array that use this material.
export interface LidarScanMaterial {
  name: string;
  texture_data: string;  // base64 PNG/JPG
  has_alpha: boolean;
  triangle_indices: number[];
}

// One mesh to load into the scannable scene (world-space coordinates — the
// renderer applies each mesh's scale/rotation/translation before sending).
export interface LidarScanMesh {
  vertices: number[][];  // [[x, y, z], ...]
  triangles: number[][];  // [[i, j, k], ...] - triangle vertex indices
  colors?: number[][];  // [[r, g, b], ...] - per-vertex colors (0-1 range)
  uv_coordinates?: number[][];  // [[u, v], ...] per-vertex (required when materials set)
  materials?: LidarScanMaterial[];  // textured material groups (alpha-masked leaves)
  // Per-triangle Helios organ-type code (parallel to `triangles`). Populated only
  // when the user opts into organ carry; lets the scan label each hit by organ.
  organ_codes?: number[];
}

// One scanner position + acquisition geometry (mirrors ScanParameters; angles
// stay in degrees and the backend converts to radians). `id` is the renderer's
// scan id — results come back keyed by it so each scanner's points attach to its
// own scan.
export interface LidarScanScanner {
  id: string;
  origin: number[];  // [x, y, z]
  // 'raster' (uniform Ntheta x Nphi grid), 'spinning_multibeam' (one channel per
  // beam_elevation_angles_deg entry; n_theta/theta_* are ignored), or
  // 'risley_prism' (Livox non-repeating rosette: a single beam through the
  // rotating `risley_prisms` wedge stack; n_theta/n_phi/theta_*/phi_* are ignored
  // — the FOV is emergent, and the scan is always trajectory-driven).
  scan_pattern: 'raster' | 'spinning_multibeam' | 'risley_prism';
  // Per-channel beam elevation angles, degrees above horizon (multibeam only).
  // The backend converts each to a zenith angle (zenith = 90 - elevation).
  beam_elevation_angles_deg?: number[];
  n_theta: number;
  n_phi: number;
  theta_min_deg: number;
  theta_max_deg: number;
  phi_min_deg: number;
  phi_max_deg: number;
  // How many returns the pulse reports (an instrument property):
  //   'single' — one return per pulse (return_selection picks which)
  //   'multi'  — all returns up to max_returns
  // For an idealized exact scan, send rays_per_pulse = 1 (a run option), which
  // collapses the beam cone to one ray for either mode.
  return_mode: 'single' | 'multi';
  max_returns?: number;                              // 'multi' only (cap on returns/pulse)
  return_selection?: 'strongest' | 'first' | 'last'; // 'single' only
  exit_diameter_m: number;     // beam cone optics (single + multi)
  beam_divergence_mrad: number;
  // Scanner tilt (degrees; backend converts to radians). A scan property, so
  // it's sent for every scan regardless of return type. 0/0 = level.
  tilt_roll_deg: number;
  tilt_pitch_deg: number;
  // Initial scanner heading (degrees). Applied by the backend synthetic-scan
  // generator (PyHelios addScan/addScanMultibeam scan_azimuth_offset, v0.1.23+).
  scan_azimuth_offset_deg: number;
  // Synthetic measurement-error model (0 disables). Applies to single + multi.
  range_noise_m: number;       // Gaussian along-beam range noise stddev (meters)
  angle_noise_mrad: number;    // Gaussian beam-pointing jitter stddev (mrad)
  // Moving-platform scan. When `trajectory` is set the backend drives the scan
  // with addScanMoving (the pose walks the trajectory over the sweep); `origin`
  // is then ignored and every hit records its own per-beam origin + timestamp.
  // `pulse_rate_hz` spaces pulses in time (required when trajectory is set).
  // Build the trajectory via poseStreamToWire(). Omit both for a static scan.
  trajectory?: unknown;
  pulse_rate_hz?: number;
  // Risley-prism (Livox rosette) only. The rotating wedge prisms in beam-traversal
  // order. Wedge angle is in DEGREES and rotor rate in Hz (datasheet units); the
  // backend converts to radians / rad-per-second at the addScanRisley call site.
  // A Risley scan always carries a trajectory (moving-only).
  risley_prisms?: {
    wedge_angle_deg: number;
    refractive_index: number;
    rotor_rate_hz: number;
    phase_deg?: number;
  }[];
  refractive_index_air?: number;  // medium index around the prisms (typically 1.0)
}

export interface LidarScanRequest {
  meshes: LidarScanMesh[];
  scanners: LidarScanScanner[];
  // Extra per-hit scalar fields to record beyond the always-read standard set.
  // Engine-produced optionals (deviation/nRaysHit) are just read; everything else
  // is a column-format label, so the scan samples that named primitive data onto
  // hits. The backend splits the two (see _ENGINE_OPTIONAL_FIELDS in main.py).
  extra_fields?: string[];
  // Which of the standard fields to keep on the resulting cloud. Used on the
  // misses-on (session) path so the color-by list matches the flat-cloud path.
  // Omitted => keep all standards.
  retained_standard_fields?: string[];
  // Beam-cone sampling: sub-rays fired per pulse across the cone, and the distance
  // (m) within which their hits merge into one return. rays_per_pulse=1 collapses
  // the cone to one exact ray per pulse (an idealized scan).
  rays_per_pulse?: number;
  pulse_distance_threshold?: number;
  // Synthetic-scan run options (from the Synthetic Scan Options popup):
  record_misses?: boolean;  // include sky/miss points (default backend = false)
  scan_grid_only?: boolean; // restrict ray-tracing to the supplied grid's cells
  grid?: HeliosGrid;        // voxel grid to crop to when scan_grid_only is set
  // Soft cap (MB) on the ray-tracing scratch buffers; omitted = Helios default.
  synthetic_scan_memory_budget_mb?: number;
}

// Per-scanner scan result, decoded from the binary frame as zero-copy typed
// arrays. `points`/`colors` are flat (xyz / rgb); `scalars` maps a field name
// (intensity, distance, timestamp, target_index, target_count, plus any
// extra_fields the engine recorded) to per-point values aligned with `points`.
export interface LidarScanResult {
  scannerId: string;
  points: Float32Array;        // flat xyz (numPoints*3)
  colors?: Float32Array;       // flat rgb (numPoints*3)
  scalars: Record<string, Float32Array>;
  numPoints: number;
  // When the scan recorded misses, the backend builds a cloud session (one per
  // scanner) so the existing session-based miss overlay + LAD work. Carries the
  // session id and miss summary; octree cache metadata is best-effort (absent if
  // PotreeConverter is unavailable — the synthetic cloud renders from its
  // in-memory points, so the octree isn't required for misses/LAD). Absent when
  // no session was created.
  session?: Partial<CloudSessionMetadata> & {
    session_id: string;
    has_misses?: boolean;
    miss_count?: number;
    scan_origin?: [number, number, number] | null;
  };
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
  request: LidarScanRequest,
  signal?: AbortSignal,
  onProgress?: BinaryFrameProgress,
  onRunId?: (runId: string) => void,
): Promise<LidarScanResponse> {
  // A high-resolution scan ray-traces Ntheta×Nphi rays per scanner; the points +
  // scalars come back as a PHB1 binary frame (5-min allowance for big scans).
  // When onProgress is supplied the backend streams PHP1 markers ahead of the
  // frame so the run button can show per-stage progress (mirrors triangulation/LAD).
  // onRunId captures the cancellation token so the user can stop a long scan.
  const { meta, buffers } = await fetchBinaryFrame('/api/lidar/scan', request, signal, 300000, onProgress, onRunId);
  if (!meta.success) {
    return { success: false, error: (meta.error as string) ?? 'LiDAR scan failed', results: [] };
  }
  const scanners = (meta.scanners as Array<{
    scanner_id: string; num_points: number; has_colors: boolean; scalar_fields: string[];
    session?: LidarScanResult['session'];
  }>) ?? [];
  const results: LidarScanResult[] = scanners.map((s, i) => {
    const scalars: Record<string, Float32Array> = {};
    s.scalar_fields.forEach((name, j) => {
      const buf = buffers[`s${i}.scalar${j}`];
      if (buf) scalars[name] = buf as Float32Array;
    });
    return {
      scannerId: s.scanner_id,
      points: (buffers[`s${i}.points`] as Float32Array) ?? new Float32Array(0),
      colors: s.has_colors ? (buffers[`s${i}.colors`] as Float32Array) : undefined,
      scalars,
      numPoints: s.num_points,
      session: s.session,
    };
  });
  return { success: true, results };
}

// Cancel an in-flight streaming op (synthetic scan / triangulation / LAD) by the
// run_id the backend emitted as its first PHP1 marker. Fire-and-forget: the
// backend flips the run's cancel flag, the C++ ray loop / stage checkpoints bail,
// and the memory is freed. Errors are swallowed — a failed cancel POST must not
// mask the abort the caller also performs on the fetch.
export async function cancelRun(runId: string): Promise<void> {
  try {
    await fetch(`${getBackendUrl()}/api/cancel/${encodeURIComponent(runId)}`, { method: 'POST' });
  } catch {
    // best-effort; the fetch abort still tears down the request
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
  // Absolute path for the backend to write directly. Always set this when a
  // destination is known: the base64-in-JSON alternative inflates the body ~1.8x,
  // so a 25 M-point cloud lands near 1 GB and `response.json()` dies on V8's
  // ~512 MB string cap ("Unexpected end of JSON input"). With dest_path the
  // response is ~100 bytes of metadata and `data` comes back null.
  dest_path?: string;
  // Ordered column slugs from the export modal's column picker, e.g.
  // ['x','y','z','reflectance','ground_class']. Applies to the TEXT formats
  // (xyz/txt/csv) and to PLY's property list; a slug this cloud doesn't carry is
  // dropped rather than written as zeros. Omit for the format's default layout.
  //
  // LAS/LAZ ignore it by design: the format has a fixed standard schema plus
  // named extra dimensions, so the backend writes EVERY available scalar as its
  // own extra dimension and the UI hides the picker for it.
  columns?: string[];
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
 * Export a point cloud via the backend (LAS/LAZ via laspy, text formats via the
 * vectorised formatter).
 *
 * Streams PHP1 progress markers ahead of its JSON tail, so `onProgress` gets a
 * real percentage rather than an indeterminate spinner: formatting a text export
 * is ~97% of its wall time and the backend reports it per chunk. `signal` +
 * `onRunId` make the export cancellable — POST /api/cancel/{runId} stops the
 * backend work, and aborting the signal tears down the fetch.
 *
 * 10 minute budget, matching the import: a 25 M-point cloud takes ~35 s to read,
 * format and write on a fast disk. fetchJsonWithProgress refreshes the deadline
 * on every chunk, so a slow-but-streaming export is never killed mid-write.
 */
export async function exportPointCloudLasLaz(
  request: PointCloudExportRequest,
  signal?: AbortSignal,
  onProgress?: BinaryFrameProgress,
  onRunId?: (runId: string) => void,
): Promise<PointCloudExportResponse> {
  console.log('Point cloud export -', request.points ? `${request.points.length} points` : `source:${request.source?.source_path}`, 'format:', request.format);
  const t0 = performance.now();
  try {
    return await fetchJsonWithProgress<PointCloudExportResponse>(
      '/api/pointcloud/export', request, signal, 600000, onProgress, onRunId);
  } catch (error) {
    console.error(`Point cloud export failed after ${Math.round(performance.now() - t0)} ms:`, error);
    throw describeBackendError(error, 'Export');
  }
}

// One scan to export to the Helios XML + per-scan ASCII bundle. Point source is
// EXACTLY one of session_id / points / file_path (resolved in that order,
// backend-side). A session-backed cloud sends session_id alone: a stale session
// is an error, never a fall-back to the pre-edit source file.
export interface ScanExportEntry {
  origin: [number, number, number];
  // Display name, used only for the export's progress messages ("Writing
  // plot_A…"). The backend ignores it everywhere else.
  label?: string;
  // 'raster' (default), 'spinning_multibeam', or 'risley_prism'. Multibeam scans
  // are exported via beam_elevation_angles_deg; n_theta/theta_* are ignored for
  // them. A Risley rosette can only be written to the DATA formats — the Helios
  // XML bundle and PTX both need a grid it doesn't have, and the backend rejects
  // it for the bundle with its own message.
  scan_pattern?: 'raster' | 'spinning_multibeam' | 'risley_prism';
  beam_elevation_angles_deg?: number[];  // degrees above horizon (multibeam only)
  n_theta?: number;
  n_phi?: number;
  theta_min?: number;
  theta_max?: number;
  phi_min?: number;
  phi_max?: number;
  beam_exit_diameter?: number;
  beam_divergence?: number;
  // Initial scanner heading (degrees). Round-trips into the XML: the backend
  // writes a <scanAzimuthOffset> tag via PyHelios exportScans (v0.1.23+) and
  // reads it back on import.
  scan_azimuth_offset?: number;
  // Scanner instrument id (ScannerModelId, e.g. 'riegl_vz400i'). Round-trips into
  // the XML: the backend injects a <scannerModel> tag and the renderer's XML
  // importer reads it back. 'generic'/undefined writes no tag.
  scanner_model?: import('../lib/scannerModels').ScannerModelId;
  // Precise pulse return mode. Helios scan XML has no native field for it and it
  // can't be inferred faithfully from columns/optics, so the backend injects
  // <returnMode>/<returnSelection>/<maxReturns> tags the renderer reads back on
  // import. Omitting return_mode writes no tags (importer falls back to its
  // legacy optics heuristic).
  return_mode?: 'single' | 'multi';
  return_selection?: 'strongest' | 'first' | 'last';  // single only
  max_returns?: number;                                // multi only
  session_id?: string;
  points?: number[][];
  scalar_columns?: Record<string, number[]>;
  file_path?: string;
  ascii_format?: string | null;
  // World-space offset applied to the points (viewer translation), or omitted.
  translation?: [number, number, number];
  // Ordered ASCII column slugs (x y z + kept scalars, in the chosen order).
  columns?: string[];
}

export interface ScanExportRequest {
  scans: ScanExportEntry[];
  base_name?: string;
  include_misses: boolean;
  // true → write the Helios XML + per-scan data (re-loadable bundle);
  // false → write only the per-scan data files (no XML), in `data_format`.
  write_xml: boolean;
  // Data-only output format (write_xml=false): las/laz/ply/xyz/csv/txt/obj/e57.
  // 'las' | 'laz' | 'ply' | 'xyz' | 'csv' | 'txt' | 'obj' | 'e57' | 'ptx'.
  data_format?: string;
  // Voxel-box grids to write as <grid> blocks (XML mode only). Omitted/empty →
  // no grid blocks. Lets a bundle like sphere.xml round-trip its grid.
  grids?: HeliosGrid[];
  // Absolute directory for the backend to write the bundle into. Always set this
  // when the destination is known: base64-in-JSON inflates each file ~1.33x and
  // this response carries EVERY scan at once, so exporting several scans (the LAZ
  // case especially) overruns V8's ~512 MB string cap in `response.json()` and
  // fails as "Unexpected end of JSON input". With dest_dir the backend writes the
  // files and returns names + sizes only.
  dest_dir?: string;
}

export interface ScanExportFile {
  name: string;
  // base64 file content — null when the backend wrote the file itself (dest_dir).
  data: string | null;
  is_xml: boolean;
  bytes?: number;    // size on disk
  written?: boolean; // true → already written by the backend; renderer must skip it
}

export interface ScanExportResponse {
  success: boolean;
  files?: ScanExportFile[];
  point_count?: number;
  scan_count?: number;
  error?: string;
}

/**
 * Export one or more objects: either a Helios XML metadata file + one ASCII data
 * file per scan (re-loadable via PyHelios loadXML), or one data file per object
 * in a chosen format. Preserves the `is_miss` flag and other per-hit scalar
 * columns, applies viewer translation, and honors session edits — so the bundle
 * round-trips losslessly back into Phytograph/Helios.
 *
 * Streams PHP1 progress markers ahead of its JSON tail, so `onProgress` gets a
 * real per-object percentage rather than an indeterminate spinner, and `signal`
 * + `onRunId` make it cancellable (POST /api/cancel/{runId} stops the backend
 * work; aborting the signal tears down the fetch).
 *
 * 10 minute budget, matching the point-cloud export: a multi-scan LAZ bundle is
 * tens of seconds of formatting. fetchJsonWithProgress refreshes the deadline on
 * every chunk, so a slow-but-streaming export is never killed mid-write.
 */
export async function exportScanXml(
  request: ScanExportRequest,
  signal?: AbortSignal,
  onProgress?: BinaryFrameProgress,
  onRunId?: (runId: string) => void,
): Promise<ScanExportResponse> {
  try {
    return await fetchJsonWithProgress<ScanExportResponse>(
      '/api/scan/export-xml', request, signal, 600000, onProgress, onRunId);
  } catch (error) {
    console.error('Scan export failed:', error);
    // Same treatment the point-cloud export gets: a raw fetch failure here is
    // almost always "the backend went away", which needs saying in those words.
    // A user cancel arrives as a reason-less AbortError; the caller checks its
    // own signal first, so wrapping it is harmless.
    throw describeBackendError(error, 'Scan export');
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
  // Whether the column's ROLE may be reassigned even though the layout is fixed
  // (LAS/LAZ extra dims, .riproject scalars). Orthogonal to `remappable`, which
  // is about column POSITION and is ASCII-only.
  role_assignable?: boolean;
}

export interface PointCloudPreviewResponse {
  kind: string;                   // ascii | ply | pcd | las
  delimiter: string | null;       // comma | whitespace | tab | semicolon | null
  has_header: boolean;
  columns: PreviewColumn[];
  sample_rows: string[][];
  warning?: string | null;
  // CloudCompare-style suggested global shift [x, y, z] = floor(min) per axis,
  // present only when the cloud's coordinates are large enough to lose float32
  // precision (any |axis min| > ~1e4). null otherwise. The wizard pre-fills its
  // shift fields from this (Z defaulted off). See _suggest_global_shift (backend).
  suggested_shift?: [number, number, number] | null;
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
  const timeoutId = abortOnTimeout(controller, 60000, '/api/pointcloud/preview');
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
  worldShift?: [number, number, number] | null,
  // Scalar slugs to leave out (wizard Import checkboxes), for formats whose
  // layout the file fixes. ASCII skips ride `columnPlan` as role 'skip'.
  droppedSlugs?: string[] | null,
): Promise<ImportPointCloudByPathResult> {
  const baseUrl = getBackendUrl();
  // 10 minute timeout: a multi-GB scan takes tens of seconds to parse and
  // additional time to stream back. Matches the triangulation budget.
  const controller = new AbortController();
  const timeoutId = abortOnTimeout(controller, 600000, '/api/pointcloud/import_by_path');
  try {
    const response = await fetch(`${baseUrl}/api/pointcloud/import_by_path`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        file_path: filePath,
        ascii_format: asciiFormat ?? null,
        column_plan: columnPlan ? columnPlanToPayload(columnPlan) : null,
        world_shift: worldShift ?? null,
        drop_slugs: droppedSlugs?.length ? droppedSlugs : null,
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

export interface MeshImportResult {
  success: boolean;
  data: MeshData;
  plantMaterials?: PlantMaterialDef[];
  filename?: string;
  hasTextures: boolean;
  error?: string;
}

/**
 * Import a mesh (OBJ + sibling MTL + texture images, or ASCII/binary PLY) from a
 * disk path. The backend resolves the MTL and image files relative to the OBJ and
 * returns geometry, real per-vertex UVs, and base64 textures.
 *
 * Transport is a PHB1 binary frame, not JSON: a scanner-grade mesh (millions of
 * triangles) serializes to a JSON body past V8's ~512 MB string cap, where
 * `response.json()` throws ERR_STRING_TOO_LONG regardless of timeout. The frame's
 * buffers become the returned MeshData's typed arrays with no per-element
 * repacking, so this also skips the number[][] round-trip entirely.
 */
export async function importTexturedMesh(filePath: string): Promise<MeshImportResult> {
  // 10 minutes: reading + normal-generating a multi-million-triangle mesh off
  // disk is tens of seconds, and the frame still has to cross the socket.
  const { meta, buffers } = await fetchBinaryFrame(
    '/api/mesh/import', { path: filePath }, undefined, 600000,
  );
  if (!meta.success) {
    throw new Error((meta.error as string) ?? 'Mesh import failed');
  }

  const materials = (meta.materials as PlantMaterial[] | null) ?? undefined;
  const materialGroups = (meta.material_groups as PlantMaterialGroup[] | null) ?? undefined;
  const textures = (meta.textures as Record<string, string> | null) ?? undefined;

  let plantMaterials: PlantMaterialDef[] | undefined;
  if (materials && materialGroups) {
    plantMaterials = materials.map((mat) => {
      const group = materialGroups.find((g) => g.material_name === mat.name);
      const textureData = mat.texture_name && textures ? textures[mat.texture_name] : undefined;
      return {
        name: mat.name,
        color: mat.color as [number, number, number] | undefined,
        textureData,
        hasAlpha: mat.has_alpha,
        triangleIndices: group?.triangle_indices ?? [],
      };
    });
  }

  return {
    success: true,
    data: {
      vertices: (buffers.vertices as Float32Array) ?? new Float32Array(0),
      indices: (buffers.indices as Uint32Array) ?? new Uint32Array(0),
      normals: buffers.normals as Float32Array | undefined,
      vertexColors: buffers.colors as Float32Array | undefined,
      uvCoordinates: buffers.uv_coordinates as Float32Array | undefined,
      vertexCount: meta.vertex_count as number,
      triangleCount: meta.triangle_count as number,
    },
    plantMaterials,
    filename: meta.filename as string | undefined,
    hasTextures: Boolean(meta.has_textures),
  };
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

// ==================== GENERIC BINARY FRAME (PHB1) ====================
// Decoder for the backend's PHB1 frame (see _bin_frame_bytes in main.py): a
// small JSON header (scalar metadata + buffer descriptors) followed by the
// typed-array buffers, concatenated. Large array responses use this instead of
// JSON — ~3-4x smaller, parsed as zero-copy typed-array views (no .flat() /
// JSON.parse), and immune to V8's ~512 MB string-length limit.

export type BinBuffer = Float32Array | Uint32Array;
export interface BinaryFrame {
  meta: Record<string, unknown>;
  buffers: Record<string, BinBuffer>;
}
const BIN_FRAME_MAGIC = 'PHB1';
const PROGRESS_MARKER_MAGIC = 'PHP1';

export interface ProgressMarker {
  progress: number | null;
  message: string;
  // The first marker of a cancellable streaming op carries its run_id (so the
  // renderer can POST /api/cancel/{run_id}); the terminal marker of a cancelled
  // run carries cancelled:true in place of a frame. Both optional on other markers.
  runId?: string;
  cancelled?: boolean;
  // The terminal marker of a FAILED run carries the error message in place of a
  // frame. These endpoints stream, so the backend has already sent `200 OK` and
  // its headers before the worker runs — a later exception cannot change the
  // status code, so the failure has to travel in-band. Without this the client
  // saw a 200 with a truncated body and reported a decode error instead of the
  // real cause.
  error?: string;
}

function isWhitespaceByte(b: number): boolean {
  return b === 0x20 || b === 0x09 || b === 0x0a || b === 0x0d;
}

function magicAt(bytes: Uint8Array, off: number, magic: string): boolean {
  if (off + 4 > bytes.length) return false;
  return (
    bytes[off] === magic.charCodeAt(0) &&
    bytes[off + 1] === magic.charCodeAt(1) &&
    bytes[off + 2] === magic.charCodeAt(2) &&
    bytes[off + 3] === magic.charCodeAt(3)
  );
}

/**
 * Parse leading PHP1 progress markers (and whitespace keepalives) from `bytes`
 * starting at `offset`. Returns the complete markers found and how many bytes
 * were consumed — stopping at the first PHB1 magic, or at an incomplete trailing
 * marker (so a marker split across stream reads is deferred to the next call).
 */
export function parseProgressMarkers(
  bytes: Uint8Array,
  offset: number,
): { markers: ProgressMarker[]; consumed: number } {
  const markers: ProgressMarker[] = [];
  let o = offset;
  for (;;) {
    while (o < bytes.length && isWhitespaceByte(bytes[o])) o++;
    if (!magicAt(bytes, o, PROGRESS_MARKER_MAGIC)) break; // PHB1 frame or no data yet
    if (o + 8 > bytes.length) break; // header not fully arrived
    const dv = new DataView(bytes.buffer, bytes.byteOffset + o + 4, 4);
    const jsonLen = dv.getUint32(0, true);
    if (o + 8 + jsonLen > bytes.length) break; // payload not fully arrived
    const json = new TextDecoder().decode(bytes.subarray(o + 8, o + 8 + jsonLen));
    try {
      const parsed = JSON.parse(json) as ProgressMarker & { run_id?: string };
      markers.push({
        progress: parsed.progress ?? null,
        message: parsed.message ?? '',
        runId: parsed.run_id,
        cancelled: parsed.cancelled,
        error: parsed.error,
      });
    } catch {
      // Ignore a malformed marker rather than wedging the stream.
    }
    o += 8 + jsonLen;
  }
  return { markers, consumed: o - offset };
}

/**
 * Throw if a buffered (non-streaming) response body carries a terminal
 * `cancelled` / `error` marker in place of its payload.
 *
 * The streaming readers check each marker as it arrives, but the buffered
 * fallbacks (`!onProgress` / `!response.body`) read the whole body at once and
 * would otherwise skip straight past a terminal marker to decode a payload that
 * was never written — turning a real backend error into a confusing "frame too
 * short" / JSON parse failure.
 */
function throwIfTerminalMarker(bytes: Uint8Array): void {
  const { markers } = parseProgressMarkers(bytes, 0);
  for (const m of markers) {
    if (m.cancelled) throw new ScanCancelledError();
    if (m.error) throw new Error(m.error);
  }
}

export function decodeBinaryFrame(buf: ArrayBuffer): BinaryFrame {
  const bytes = new Uint8Array(buf);
  // Skip the streaming keepalive (4-byte whitespace chunks) and any PHP1
  // progress markers that precede the frame on long-compute endpoints.
  let start = 0;
  for (;;) {
    while (start < bytes.length && isWhitespaceByte(bytes[start])) start++;
    if (!magicAt(bytes, start, PROGRESS_MARKER_MAGIC)) break;
    const dv = new DataView(buf, start + 4, 4);
    start += 8 + dv.getUint32(0, true);
  }
  if (bytes.length - start < 8) throw new Error('Binary frame too short');
  const magic = String.fromCharCode(bytes[start], bytes[start + 1], bytes[start + 2], bytes[start + 3]);
  if (magic !== BIN_FRAME_MAGIC) throw new Error(`Unexpected binary magic "${magic}"`);

  const dv = new DataView(buf);
  const headerLen = dv.getUint32(start + 4, true);
  const header = JSON.parse(new TextDecoder().decode(new Uint8Array(buf, start + 8, headerLen)));

  let payloadStart = start + 8 + headerLen;
  let src = buf;
  // Zero-copy views need a 4-byte-aligned offset; the protocol guarantees it
  // (8 + padded header, after a 4-byte-multiple of keepalive), but fall back to
  // a single aligned copy if anything upstream injected odd padding.
  if (payloadStart % 4 !== 0) { src = buf.slice(payloadStart); payloadStart = 0; }

  const buffers: Record<string, BinBuffer> = {};
  let o = payloadStart;
  for (const d of header.buffers as Array<{ name: string; dtype: string; length: number }>) {
    buffers[d.name] = d.dtype === 'f32'
      ? new Float32Array(src, o, d.length)
      : new Uint32Array(src, o, d.length);
    o += d.length * 4;
  }
  if (o > src.byteLength) throw new Error('Binary frame shorter than declared');
  return { meta: header.meta, buffers };
}

// Encode a PHB1 frame for sending in the REQUEST direction (the mirror of the
// backend's _bin_frame_bytes and of decodeBinaryFrame above). `meta` holds the
// scalar request fields; `buffers` are named typed arrays. Layout (little-endian):
// 'PHB1' + uint32 headerLen + JSON {meta, buffers:[{name,dtype,length}]} (space-
// padded to a 4-byte multiple so payloads stay aligned) + concatenated payloads.
export function encodeBinaryFrame(
  meta: Record<string, unknown>,
  buffers: Array<{ name: string; data: Float32Array | Uint32Array }>,
): Uint8Array {
  const descs = buffers.map(b => ({
    name: b.name,
    dtype: b.data instanceof Float32Array ? 'f32' : 'u32',
    length: b.data.length,
  }));
  let header = new TextEncoder().encode(JSON.stringify({ meta, buffers: descs }));
  const pad = (4 - (header.length % 4)) % 4;  // pad with spaces to a 4-byte multiple
  if (pad !== 0) header = concatBytes([header, new Uint8Array(pad).fill(0x20)]);

  const head = new Uint8Array(8 + header.length);
  head.set(new TextEncoder().encode(BIN_FRAME_MAGIC), 0);
  new DataView(head.buffer).setUint32(4, header.length, true);
  head.set(header, 8);

  const parts: Uint8Array[] = [head];
  for (const b of buffers) {
    parts.push(new Uint8Array(b.data.buffer, b.data.byteOffset, b.data.byteLength));
  }
  return concatBytes(parts);
}

// Normalize a Uint8Array (possibly a view into a larger buffer) to a tight
// ArrayBuffer suitable as a fetch body.
function toRequestBody(b: ArrayBuffer | Uint8Array): ArrayBuffer {
  if (b instanceof ArrayBuffer) return b;
  return b.byteOffset === 0 && b.byteLength === b.buffer.byteLength
    ? (b.buffer as ArrayBuffer)
    : b.slice().buffer;
}

// Reporter for per-stage progress streamed ahead of the PHB1 frame as PHP1
// markers (see _bin_frame_streaming_response in backend-api/main.py).
export type BinaryFrameProgress = (progress: number | null, message: string) => void;

// Cancellation + progress plumbing for a point-cloud import. Importing a
// multi-GB scan is a minute-scale operation the user must be able to abort, and
// the abort has to be REAL: `cancelRun(runId)` tells the backend to stop and
// free its memory (killing the PotreeConverter child), while `signal` tears down
// the fetch. See `cancelImport` in App.tsx for the ordering.
export interface ImportProgressOptions {
  signal?: AbortSignal;
  // Per-stage progress streamed as PHP1 markers ("Building octree…", 0.62).
  onProgress?: BinaryFrameProgress;
  // Fires once with the backend run id, which is what /api/cancel/{id} targets.
  onRunId?: (runId: string) => void;
}

// Thrown when the backend reports a cancelled run (a terminal PHP1 `cancelled`
// marker) instead of a frame. Callers catch this to treat the cancel as a
// no-op-success (UI returns to idle) rather than surfacing an error toast.
export class ScanCancelledError extends Error {
  constructor() {
    super('Operation cancelled');
    this.name = 'ScanCancelledError';
  }
}

// POST a JSON request and decode a PHB1 binary-frame response. Mirrors the JSON
// fetch helpers (10-min timeout, forwards an external abort signal).
//
// When `onProgress` is supplied the body is read incrementally: leading PHP1
// progress markers are parsed and reported as they arrive (and the timeout is
// refreshed on each chunk so an actively-streaming long compute isn't aborted),
// then the buffered PHB1 frame is decoded. Without `onProgress` the original
// one-shot arrayBuffer() path is used unchanged.
export async function fetchBinaryFrame(
  path: string,
  request: unknown,
  signal?: AbortSignal,
  timeoutMs = 600000,
  onProgress?: BinaryFrameProgress,
  onRunId?: (runId: string) => void,
): Promise<BinaryFrame> {
  const baseUrl = getBackendUrl();
  const controller = new AbortController();
  let timeoutId = abortOnTimeout(controller, timeoutMs, path);
  const refreshTimeout = () => {
    clearTimeout(timeoutId);
    timeoutId = abortOnTimeout(controller, timeoutMs, path);
  };
  if (signal) signal.addEventListener('abort', () => controller.abort());
  try {
    const response = await fetch(`${baseUrl}${path}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(request),
      signal: controller.signal,
    });
    if (!response.ok) {
      clearTimeout(timeoutId);
      const errorData = await response.json().catch(() => ({}));
      throw new Error(
        formatBackendDetail(errorData.detail)
          || `HTTP ${response.status}: ${response.statusText}`,
      );
    }
    if (!onProgress || !response.body) {
      clearTimeout(timeoutId);
      const buf = await response.arrayBuffer();
      throwIfTerminalMarker(new Uint8Array(buf));
      return decodeBinaryFrame(buf);
    }

    // Streaming path: accumulate bytes, draining leading PHP1 markers as they
    // arrive, then decode the PHB1 frame from the full buffer.
    const reader = response.body.getReader();
    const chunks: Uint8Array[] = [];
    let pending = new Uint8Array(0); // unparsed leading bytes (markers + tail)
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        refreshTimeout();
        chunks.push(value);
        // Parse any complete markers visible at the head of the stream so far.
        const merged = concatBytes([pending, value]);
        const { markers, consumed } = parseProgressMarkers(merged, 0);
        for (const m of markers) {
          if (m.runId && onRunId) onRunId(m.runId);
          // A `cancelled` marker means the backend aborted and freed its memory;
          // there is no frame to decode. Surface it as a typed abort so callers
          // can distinguish a user cancel from a real failure.
          if (m.cancelled) throw new ScanCancelledError();
          // An `error` marker means the worker raised after the 200 was already
          // committed. Throw the backend's own message rather than falling
          // through to decode a frame that was never written.
          if (m.error) throw new Error(m.error);
          onProgress(m.progress, m.message);
        }
        pending = merged.subarray(consumed);
      }
    } finally {
      reader.cancel().catch(() => {});
      clearTimeout(timeoutId);
    }
    const full = concatBytes(chunks);
    return decodeBinaryFrame(full.buffer.slice(full.byteOffset, full.byteOffset + full.byteLength));
  } catch (error) {
    clearTimeout(timeoutId);
    throw error;
  }
}

function concatBytes(parts: Uint8Array[]): Uint8Array {
  let total = 0;
  for (const p of parts) total += p.byteLength;
  const out = new Uint8Array(total);
  let o = 0;
  for (const p of parts) {
    out.set(p, o);
    o += p.byteLength;
  }
  return out;
}

// POST a JSON request to an endpoint whose body is leading PHP1 progress markers
// followed by a JSON payload (see _bin_frame_streaming_response in
// backend-api/main.py). The body is read incrementally: leading markers are
// parsed and reported via `onProgress` as they arrive (refreshing the abort
// timeout each chunk so an actively-streaming long compute isn't aborted), then
// the trailing JSON is parsed. Mirrors fetchBinaryFrame but returns parsed JSON
// instead of decoding a PHB1 frame. Always strips leading markers, so it works
// whether or not the caller supplies `onProgress`.
export async function fetchJsonWithProgress<T>(
  path: string,
  request: unknown,
  signal?: AbortSignal,
  timeoutMs = 600000,
  onProgress?: BinaryFrameProgress,
  onRunId?: (runId: string) => void,
  // When supplied, the request is sent as a raw binary body (octet-stream)
  // instead of JSON — e.g. a PHB1 frame carrying a large mesh. `request` is then
  // ignored for the body (still used by callers for logging). The response is
  // drained identically (leading PHP1 markers + JSON tail).
  binaryBody?: ArrayBuffer | Uint8Array,
): Promise<T> {
  const baseUrl = getBackendUrl();
  const controller = new AbortController();
  let timeoutId = abortOnTimeout(controller, timeoutMs, path);
  const refreshTimeout = () => {
    clearTimeout(timeoutId);
    timeoutId = abortOnTimeout(controller, timeoutMs, path);
  };
  if (signal) signal.addEventListener('abort', () => controller.abort());
  try {
    const response = await fetch(`${baseUrl}${path}`, {
      method: 'POST',
      headers: { 'Content-Type': binaryBody ? 'application/octet-stream' : 'application/json' },
      body: binaryBody ? toRequestBody(binaryBody) : JSON.stringify(request),
      signal: controller.signal,
    });
    if (!response.ok) {
      clearTimeout(timeoutId);
      const errorData = await response.json().catch(() => ({}));
      throw new Error(errorData.detail || `HTTP ${response.status}: ${response.statusText}`);
    }
    if (!response.body) {
      // No streaming body available — strip any leading markers/whitespace from
      // the buffered bytes, then parse the JSON tail.
      clearTimeout(timeoutId);
      const all = new Uint8Array(await response.arrayBuffer());
      throwIfTerminalMarker(all);
      const { consumed } = parseProgressMarkers(all, 0);
      return JSON.parse(new TextDecoder().decode(all.subarray(consumed))) as T;
    }

    // Streaming path: accumulate bytes, draining leading PHP1 markers as they
    // arrive; whatever remains after the leading markers is the JSON payload.
    const reader = response.body.getReader();
    let pending = new Uint8Array(0); // unparsed leading bytes (markers + JSON tail)
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        refreshTimeout();
        const merged = concatBytes([pending, value]);
        const { markers, consumed } = parseProgressMarkers(merged, 0);
        for (const m of markers) {
          if (m.runId && onRunId) onRunId(m.runId);
          if (m.cancelled) throw new ScanCancelledError();
          if (m.error) throw new Error(m.error);
          if (onProgress) onProgress(m.progress, m.message);
        }
        pending = merged.subarray(consumed);
      }
    } finally {
      reader.cancel().catch(() => {});
      clearTimeout(timeoutId);
    }
    return JSON.parse(new TextDecoder().decode(pending)) as T;
  } catch (error) {
    clearTimeout(timeoutId);
    throw error;
  }
}

/**
 * Import a LAS or LAZ file via the backend.
 * Uses laspy with lazrs for LAZ decompression.
 */
export async function importPointCloudLasLaz(
  file: File
): Promise<ImportPointCloudByPathResult> {
  const baseUrl = getBackendUrl();
  console.log('LAS/LAZ import - file:', file.name, 'size:', file.size);

  // Use AbortController for timeout
  const controller = new AbortController();
  const timeoutId = abortOnTimeout(controller, 120000, '/api/pointcloud/import'); // 2 minutes

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
      // Success is an octet-stream PHX1 frame; errors are JSON {detail}.
      const errorData = await response.json().catch(() => ({}));
      throw new Error(errorData.detail || `HTTP ${response.status}: ${response.statusText}`);
    }

    // The endpoint now streams the packed binary (PHX1) frame, decoded into
    // Float32Array views — no JSON point list, no V8 string-size ceiling.
    const buf = await response.arrayBuffer();
    return decodePointCloudBinary(buf);
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
  request: AlignmentDistanceRequest,
  signal?: AbortSignal,
  onProgress?: BinaryFrameProgress,
  onRunId?: (runId: string) => void,
): Promise<AlignmentDistanceResponse> {
  console.log('Alignment distance - points:', request.points ? request.points.length / 3 : `source:${request.source?.source_path}`, 'vertices:', request.mesh_vertices.length / 3);
  // The response streams PHP1 progress markers ahead of the JSON result so the
  // renderer shows a cancellable pill; fetchJsonWithProgress owns its own
  // per-chunk-refreshed timeout. See computeLAD for the template.
  try {
    return await fetchJsonWithProgress<AlignmentDistanceResponse>(
      '/api/c2m/distance', request, signal, 120000, onProgress, onRunId);
  } catch (error) {
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
  // RMSE as a fraction of the cloud's robust extent. Prefer this over `fitness`
  // when judging a result: fitness is the FRACTION of points that found a
  // correspondence within max_correspondence_distance, so it pins to 1.0 for a
  // badly wrong alignment whenever that distance is generous.
  rmse_ratio?: number;
  // Set when the fit converged but looks untrustworthy — show it instead of a
  // "Fitness: 100%" success message.
  quality_warning?: string | null;
}

/**
 * Perform ICP (Iterative Closest Point) registration to align a mesh to a point cloud.
 *
 * The point cloud is the TARGET (stays fixed), the mesh is the SOURCE (will be transformed).
 * Returns the transformation needed to "snap" the mesh to the cloud.
 * Uses Open3D's point-to-plane ICP for robust registration.
 */
export async function icpRegisterMeshToCloud(
  request: ICPRegistrationRequest,
  signal?: AbortSignal,
  onProgress?: BinaryFrameProgress,
  onRunId?: (runId: string) => void,
): Promise<ICPRegistrationResponse> {
  console.log('ICP registration - points:', request.points ? request.points.length / 3 : `source:${request.source?.source_path}`, 'mesh vertices:', request.mesh_vertices.length / 3);
  // Streams PHP1 progress markers ahead of the JSON result (cancellable pill).
  try {
    return await fetchJsonWithProgress<ICPRegistrationResponse>(
      '/api/c2m/icp-register', request, signal, 120000, onProgress, onRunId);
  } catch (error) {
    console.error('ICP registration failed:', error);
    throw error;
  }
}

// ==================== CLOUD-TO-CLOUD ICP REGISTRATION API ====================

export interface CloudToCloudICPRequest {
  // Each side is flat inline points OR an octree source descriptor, resolved
  // independently so a flat and an octree cloud can be mixed. Either side may
  // be octree-backed: a flat source is baked renderer-side, while an octree
  // source is transformed on its backend session and the octree rebuilt.
  target_points?: number[];     // Flattened [x, y, z, ...] target (stays fixed); omit when target_source is set
  source_points?: number[];     // Flattened [x, y, z, ...] source (to be moved); omit when source_source is set
  target_source?: BackendPointSource;  // octree-backed target read from disk
  source_source?: BackendPointSource;  // octree-backed source read from disk
  max_correspondence_distance?: number;  // Optional max correspondence distance
  max_iterations?: number;     // Optional max iterations (default 50)
  /**
   * Optional starting pose as a row-major flat 4x4 (16 numbers) — the same
   * layout `transformation_matrix` comes back in. Pass the result of
   * `globalRegisterCloudToCloud` here to refine a coarse alignment instead of
   * starting from identity. Omit for the default behaviour (identity init after
   * centroid pre-alignment).
   */
  init_transform?: number[];
}

/**
 * Perform ICP (Iterative Closest Point) registration to align one point cloud to another.
 *
 * The target cloud stays fixed, the source cloud will be transformed.
 * Returns the transformation needed to align the source to the target.
 */
export async function icpRegisterCloudToCloud(
  request: CloudToCloudICPRequest,
  signal?: AbortSignal,
  onProgress?: BinaryFrameProgress,
  onRunId?: (runId: string) => void,
): Promise<ICPRegistrationResponse> {
  console.log('Cloud-to-cloud ICP - target:', request.target_points ? `${request.target_points.length / 3} pts` : `source:${request.target_source?.source_path}`, 'source:', request.source_points ? `${request.source_points.length / 3} pts` : `source:${request.source_source?.source_path}`);
  // Streams PHP1 progress markers ahead of the JSON result (cancellable pill).
  try {
    return await fetchJsonWithProgress<ICPRegistrationResponse>(
      '/api/c2c/icp-register', request, signal, 120000, onProgress, onRunId);
  } catch (error) {
    console.error('Cloud-to-cloud ICP registration failed:', error);
    throw error;
  }
}

// ==================== GLOBAL (COARSE) REGISTRATION API ====================

/** Which per-plant landmark each cloud is reduced to before matching. */
export type AnchorMethod = 'crown' | 'trunk' | 'chm';
export type GlobalEstimator = 'correlation' | 'ransac_fpfh' | 'fgr';

/** What kind of scene this is. Not a preset: `urban` selects a structurally
 *  different algorithm (surface matching) because built scenes have no
 *  per-plant landmark to find. */
export type SceneType = 'agriculture' | 'natural' | 'urban';

export interface GlobalRegisterRequest {
  scene_type?: SceneType;
  /** Set after the user has dismissed a scene-type mismatch prompt, so the same
   *  warning cannot block them twice. */
  scene_type_confirmed?: boolean;
  target_points?: number[];
  source_points?: number[];
  target_source?: BackendPointSource;
  source_source?: BackendPointSource;
  anchor_method?: AnchorMethod;
  estimator?: GlobalEstimator;
  voxel_size?: number;
  refine_icp?: boolean;
  /** Scanner heading in degrees, when known (GNSS/IMU/compass). Constrains the
   *  coarse yaw search, and when present the backend prefers plain ICP
   *  refinement over a global search — measured as substantially more accurate
   *  on GNSS-seeded data. Omit when no heading is available. */
  yaw_prior_deg?: number | null;
  yaw_search_deg?: number;
  prefer_refine_with_prior?: boolean;
  confidence_threshold?: number;
}

export interface GlobalRegisterResponse extends ICPRegistrationResponse {
  /** False when the result should not be trusted without review — too few
   *  anchors were found, or the coarse match scored below threshold. A matrix
   *  is still returned; this flags that it may be wrong. */
  confident?: boolean;
  anchor_method_used?: AnchorMethod;
  num_anchors_target?: number;
  num_anchors_source?: number;
  /** Score of the coarse stage alone, before ICP refinement. */
  coarse_fitness?: number;
  /** Which algorithm actually ran: per-plant landmarks, or raw surface
   *  matching when too few plants were found. Never left implicit — a user
   *  judging a result needs to know which method produced it. */
  match_path?: 'pose-prior-refine' | 'raster-correlation' | 'plant-landmarks' | 'raw-surface';
  /** True when a rival pose scored nearly as well as the winner, i.e. the
   *  scene is too symmetric to tell them apart. This is the one failure a
   *  residual check cannot see: a 180°-flipped orchard is a genuinely good
   *  fit to the wrong answer. */
  ambiguous?: boolean;
  /** How far the winning pose beat the runner-up (0-1). */
  match_margin?: number | null;
  /** The heading prior actually used, if any. */
  yaw_prior_used?: number | null;
  /** The scene type the run actually used. */
  scene_type_used?: SceneType;
  /** A weak scene-type disagreement — worth showing, never worth blocking. */
  scene_advisory?: string | null;

  // --- Set INSTEAD of a result when the scene looks nothing like the chosen
  // type. The run stops before the expensive stage so the user can confirm or
  // switch; re-send with `scene_type_confirmed` to proceed regardless.
  needs_scene_confirmation?: boolean;
  observed_scene_type?: SceneType;
  chosen_scene_type?: SceneType;
  scene_message?: string;
  scene_planarity?: number | null;
}

/**
 * Coarse (global) cloud-to-cloud registration.
 *
 * Unlike `icpRegisterCloudToCloud`, this does NOT require the clouds to start
 * near each other: both are reduced to sparse per-plant anchors, those are
 * matched, and the winner is refined with the same point-to-plane ICP. Use it
 * when two scans are arbitrarily rotated/offset; use plain ICP to polish a pair
 * that is already roughly aligned.
 *
 * Longer timeout than plain ICP: the anchor stage may run ground/tree
 * segmentation over both clouds before any matching happens.
 */
/** Register a SET of scans together, cross-checked by loop closure.
 *
 *  Prefer this over repeated `globalRegisterCloudToCloud` calls whenever three
 *  or more overlapping scans are available. Pairwise registration cannot tell a
 *  correct pose from a wrong-but-well-fitting one on a repetitive planting — a
 *  row-shifted alignment lands plant on plant and scores BETTER on residual.
 *  Composing poses around a closed loop of scans exposes that: the error does
 *  not cancel around the cycle. */
export interface MultiScanRegisterRequest {
  scans?: BackendPointSource[];
  scan_points?: number[][];
  /** Index of the scan the others are registered onto; it does not move. */
  reference?: number;
  scene_type?: SceneType;
  scene_type_confirmed?: boolean;
  /** Try several matching settings and keep whichever yields a self-consistent
   *  set of alignments. The right setting differs by scene and cannot be picked
   *  from any single pair. */
  select_variant?: boolean;
  refine_icp?: boolean;
}

export interface MultiScanLoop {
  scans: number[];
  translation_error: number;
  rotation_error: number;
  closed: boolean;
}

export interface MultiScanRegisterResponse {
  success: boolean;
  error?: string;
  reference?: number;
  /** Scan index (as a string key) -> row-major 4x4. Scans that could not be
   *  placed consistently are ABSENT here and listed in `unresolved_scans`. */
  transformation_matrices?: Record<string, number[]>;
  unresolved_scans?: number[];
  loops?: MultiScanLoop[];
  loops_checked?: boolean;
  loops_consistent?: boolean;
  loops_localised?: boolean;
  suspect_pairs?: number[][];
  variant?: { cell: number | null; mode: string; worst_loop: number | null; tried?: unknown[] };
  /** False when there was no cycle to check (fewer than three scans), so the
   *  result carries exactly the trust of a pairwise one. */
  validated?: boolean;
}

export async function multiScanRegister(
  request: MultiScanRegisterRequest,
  signal?: AbortSignal,
  onProgress?: BinaryFrameProgress,
  onRunId?: (runId: string) => void,
): Promise<MultiScanRegisterResponse> {
  console.log('Multi-scan registration -', (request.scans?.length ?? request.scan_points?.length ?? 0), 'scans');
  // Every pair is registered, so this is markedly slower than a single pair.
  try {
    return await fetchJsonWithProgress<MultiScanRegisterResponse>(
      '/api/multi/register', request, signal, 1800000, onProgress, onRunId);
  } catch (error) {
    console.error('Multi-scan registration failed:', error);
    throw error;
  }
}

export async function globalRegisterCloudToCloud(
  request: GlobalRegisterRequest,
  signal?: AbortSignal,
  onProgress?: BinaryFrameProgress,
  onRunId?: (runId: string) => void,
): Promise<GlobalRegisterResponse> {
  console.log('Global registration - anchor method:', request.anchor_method ?? 'crown',
    'estimator:', request.estimator ?? 'ransac_fpfh');
  // Streams PHP1 progress markers ahead of the JSON result (cancellable pill).
  try {
    return await fetchJsonWithProgress<GlobalRegisterResponse>(
      '/api/c2c/global-register', request, signal, 300000, onProgress, onRunId);
  } catch (error) {
    console.error('Global registration failed:', error);
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
  request: MeshToMeshICPRequest,
  signal?: AbortSignal,
  onProgress?: BinaryFrameProgress,
  onRunId?: (runId: string) => void,
): Promise<ICPRegistrationResponse> {
  console.log('Mesh-to-mesh ICP - target vertices:', request.target_vertices.length / 3, 'source vertices:', request.source_vertices.length / 3);
  // Streams PHP1 progress markers ahead of the JSON result (cancellable pill).
  // 3-minute timeout (mesh sampling + ICP); fetchJsonWithProgress refreshes it
  // per streamed chunk so an actively-progressing run is never aborted.
  try {
    return await fetchJsonWithProgress<ICPRegistrationResponse>(
      '/api/m2m/icp-register', request, signal, 180000, onProgress, onRunId);
  } catch (error) {
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
  // The CloudCompare-style global shift [x, y, z] that was applied at import
  // (SUBTRACTED from every point, so world = stored + world_shift). null when no
  // shift was applied. The renderer persists it on the cloud's OctreeRef for
  // world-coord readouts/provenance; the backend restores world coords on read.
  world_shift?: [number, number, number] | null;
  // Sky/miss points (laser pulses that returned nothing) are kept in the
  // session for LAD but NOT in the octree (their ~20 km coords would poison the
  // bounding box). `has_misses` lets the renderer offer a "Show misses" toggle;
  // `scan_origin` (when the source carried it, e.g. an E57 pose) seeds the
  // scan's params.origin and the miss-overlay relocation.
  has_misses?: boolean;
  miss_count?: number;
  miss_slug?: string;
  scan_origin?: [number, number, number];
  // sha1 of the projected-miss octree the backend built alongside the hits
  // octree (null when the scan has no placeable misses). The renderer streams it
  // via app://octree/<id>/ with MissOctree, gated behind "Show misses".
  miss_octree_cache_id?: string | null;
  // Full scan-pattern parameters recovered from the source file (E57 pose +
  // angular sweep + grid resolution; PCD VIEWPOINT origin). Present only when
  // the format carried them; each field is independently optional. The renderer
  // turns this into a Scan's ScanParameters at import (XML-parity), filling any
  // missing field from the defaults. Angles are in degrees, origin in metres.
  scan_params?: ScanParamsFromFile;
  // Outlier-resistant ground level (a low Z percentile), in the same frame as
  // `tight_bounds` — i.e. post-world_shift. Computed once at import, where the
  // full point array is already in RAM.
  //
  // Use this, NOT `tight_bounds.min.z`, wherever "the ground" is meant: the raw
  // minimum is defined by a single point, so one erroneous low return (multipath,
  // a bird, a scanner artefact) sinks it arbitrarily far. null when the backend
  // could not compute one (empty/degenerate cloud) — fall back to the min then.
  ground_z?: number | null;
  // Outlier-resistant per-axis extent [dx, dy, dz] (see `_robust_extent` in
  // main.py). The viewer scales the camera's zoom limits from it so a handful of
  // stray returns hundreds of metres out can't make the scene un-navigable.
  // Cannot be derived from `tight_bounds`: rejecting the tail needs the points,
  // which only exist backend-side at import. null on a degenerate cloud.
  robust_extent?: [number, number, number] | null;
  // The percentile box `robust_extent` was measured across. Its CENTRE is the
  // content's centre — unlike `tight_bounds`', which far outliers drag into
  // empty space. null on a degenerate cloud.
  robust_bounds?: { min: [number, number, number]; max: [number, number, number] } | null;
}

// The wire shape of the backend `scan_params` dict. Canonically defined in
// scanParameters.ts (alongside the converter that turns it into ScanParameters)
// and re-exported here so backendApi consumers get it without a second import.
export type { ScanParamsFromFile } from '../lib/scanParameters';

/** Result of a Backfill Misses call. `backfilled` is how many sky/miss points
 * were recovered and persisted in the session; `already_had_misses` is true when
 * the scan already retained real misses (nothing to do). `error` is present (with
 * the other fields zeroed) when reconstruction failed — e.g. a grid too sparse to
 * gap-fill — so the caller surfaces it as a toast rather than treating it as a
 * success. */
export interface BackfillMissesResult {
  backfilled: number;
  miss_count: number;
  has_misses: boolean;
  scan_origin: [number, number, number];
  already_had_misses: boolean;
  error?: string;
  // sha1 of the rebuilt projected-miss octree (the newly recovered misses stream
  // in via MissOctree once the cloud's OctreeRef adopts it). Absent on the
  // no-op/error paths, where the existing miss octree is unchanged.
  miss_octree_cache_id?: string | null;
}

/** The angular raster of the scan being backfilled, forwarded to the backend so
 * the C++ gapfiller reconstructs misses over the scan's REAL grid (Ntheta/Nphi)
 * and sweep (theta/phi range) — not a point-count estimate. Mirrors the
 * LAD-relevant subset of the scan params (see buildLADRequest). When omitted the
 * backend falls back to its estimate, which silently mismatches the true grid and
 * over-fills misses (e.g. a full-360° ring of sky points). `beam_*` are only sent
 * for multi-return scans. */
export interface BackfillMissesRaster {
  n_theta?: number;
  n_phi?: number;
  theta_min?: number;        // degrees
  theta_max?: number;
  phi_min?: number;
  phi_max?: number;
  beam_exit_diameter?: number;  // meters (multi-return only)
  beam_divergence?: number;     // milliradians (multi-return only)
}

/**
 * Explicitly recover a session's sky/miss points (beams that returned nothing)
 * and persist them in the backend session, so they can be visualised via the
 * misses overlay and consumed by LAD (which no longer gapfills silently).
 *
 * `origin` is the scanner position (per-beam miss directions are reconstructed
 * from it). `raster` is the scan's angular grid/sweep — ALWAYS forward it when
 * the scan has params; without it the backend estimates the grid from point
 * count and assumes a full 0–180°/0–360° sweep, which mismatches the real
 * scanner and fabricates misses outside the scan pattern. `trajectory` (the
 * backend `PoseStream` wire shape, built via poseStreamToWire()) marks a
 * moving-platform scan. Eligible only when the scan carries a per-pulse timestamp
 * and/or scan-grid row/column indices; the backend 400s otherwise.
 *
 * The backend streams PHP1 progress markers ahead of the JSON tail (the build +
 * gapfill is slow for a dense scan), so this takes an optional `onProgress`
 * callback and an `AbortSignal` for cancellation — mirroring `computeLAD`.
 */
export async function backfillMisses(
  sessionId: string,
  origin: [number, number, number],
  raster?: BackfillMissesRaster,
  trajectory?: unknown,
  signal?: AbortSignal,
  onProgress?: BinaryFrameProgress,
): Promise<BackfillMissesResult> {
  return await fetchJsonWithProgress<BackfillMissesResult>(
    `/api/cloud/session/${sessionId}/backfill-misses`,
    { origin, ...(raster ?? {}), trajectory },
    signal,
    600000,
    onProgress,
  );
}

/** Result of a delete_region / reset_edits call — counts only (no rebuild). */
export interface CloudSessionEditResult {
  session_id: string;
  deleted_count: number;
  remaining_count: number;
  total_count: number;
  // True when this crop invalidated a SEPARATELY backfilled-miss buffer (it was
  // gap-filled against the pre-crop hits, so its ratio no longer matches). The
  // misses are kept; the renderer warns the user to re-run Backfill Misses.
  backfilled_misses_stale?: boolean;
}

/** Result of a bake — fresh octree metadata for the survivor set. `baked` is
 * false when there were no pending deletions (the octree is unchanged). */
export interface CloudSessionBakeResult extends OctreeMetadata {
  session_id: string;
  point_count: number;
  baked: boolean;
  // sha1 of the miss octree rebuilt from the baked survivors (null when no misses
  // survive). The renderer adopts it onto the cloud's OctreeRef so the miss shell
  // tracks the baked cloud.
  miss_octree_cache_id?: string | null;
  // Non-fatal advisories from the operation (e.g. wood/leaf connectivity warning
  // that the base looks like un-removed ground). Surfaced as a warning toast.
  warnings?: string[];
  // Tree segmentation only: number of distinct trees found (max tree id; 0 =
  // ground/miss). Drives the "split into one cloud per tree" fan-out.
  num_trees?: number;
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
  worldShift?: [number, number, number] | null,
  // Far-field distance (m) for miss auto-detection's distance fallback. Sourced
  // from AppSettings.missDistanceThreshold by the importer; null → backend's
  // 1001 m default. Only used when the scan has no is_miss/target_index signal.
  missDistanceThreshold?: number | null,
  // Scanner head position [x, y, z] in true-world coords, when known — e.g. the
  // <origin> of an imported Helios scan XML bundle. Lets the backend reproject
  // sky/miss points onto the thin display shell (the miss octree) instead of
  // leaving them at far-field, matching a fresh synthetic scan. null when the
  // source carries no scanner geometry.
  origin?: [number, number, number] | null,
  // Abort the import. Pair with `cancelRun(runId)` so the backend stops and
  // frees its memory rather than finishing the work into the void.
  signal?: AbortSignal,
  // Per-stage progress from the endpoint's PHP1 markers.
  onProgress?: BinaryFrameProgress,
  // Receives the backend run id (first marker) — the /api/cancel/{id} target.
  onRunId?: (runId: string) => void,
  // Scalar slugs the wizard's Import checkboxes excluded. Only meaningful for
  // in-file formats (LAS/LAZ/PLY/PCD/E57/PTX) — an ASCII skip travels inside
  // `columnPlan` as role 'skip' and never reaches here.
  droppedSlugs?: string[] | null,
  // Role reassignments from the wizard, `{source_slug: role}`. Only the columns
  // the user actually changed; an in-file format's auto-detection is otherwise
  // untouched. Empty/undefined → the previous behaviour exactly.
  roleOverrides?: Record<string, string> | null,
): Promise<CloudSessionMetadata> {
  try {
    // The endpoint streams PHP1 progress markers ahead of its JSON tail, so it
    // needs the streaming reader. That also replaces the old hand-rolled 300 s
    // timeout: fetchJsonWithProgress refreshes its timeout on every chunk, so a
    // legitimately slow (but actively streaming) import is no longer aborted
    // mid-flight the way a >5 min import used to be.
    const meta = await fetchJsonWithProgress<CloudSessionMetadata & { error?: string }>(
      '/api/cloud/session/create',
      {
        source_path: filePath,
        ascii_format: asciiFormat ?? null,
        column_plan: columnPlan ? columnPlanToPayload(columnPlan) : null,
        world_shift: worldShift ?? null,
        miss_distance_threshold: missDistanceThreshold ?? null,
        origin: origin ?? null,
        drop_slugs: droppedSlugs?.length ? droppedSlugs : null,
        role_overrides: roleOverrides && Object.keys(roleOverrides).length
          ? roleOverrides : null,
      },
      signal,
      600000,
      onProgress,
      onRunId,
    );
    // Failures raised after the response opened can't be an HTTP error status —
    // the backend reports them in the JSON tail instead (a truncated body would
    // otherwise surface as "Unexpected end of JSON input").
    if (meta.error) throw new Error(meta.error);
    return meta;
  } catch (error) {
    // A cancel is not a failure: rethrow it untouched so callers can identify it
    // by type. describeBackendError would mangle it into a generic backend
    // error and every cancel would raise an error toast.
    if (error instanceof ScanCancelledError) throw error;
    console.error('create_cloud_session failed:', error);
    throw describeBackendError(error, 'Import');
  }
}

/** One scan position of a multi-scan source, as returned by createCloudSessions. */
export interface CloudScanPosition {
  /** Index within the file (0-based). */
  scan_index: number;
  /** Display name — the file stem, suffixed with the position for multi-scan files. */
  name: string;
  /** Present unless this position failed; absent alongside `error`. */
  session?: CloudSessionMetadata;
  /** Why this one position failed. Its siblings still imported. */
  error?: string;
}

export interface CloudScanPositions {
  scans: CloudScanPosition[];
  scan_count: number;
}

/**
 * Import a source as one session PER SCAN POSITION.
 *
 * The plural sibling of {@link createCloudSession}. A multi-scan E57 or
 * multi-block PTX holds several genuinely separate acquisitions, and a scan is
 * defined by its pose — merging them leaves one origin standing in for all of
 * them, which breaks the LAD inversion (it takes a single scanner origin), puts
 * the sky/miss display shell around the wrong centre, and makes the per-scan
 * row/column rasters collide.
 *
 * Every other format comes back as a one-element list, so callers have a single
 * shape to handle rather than branching on the extension.
 */
export async function createCloudSessions(
  filePath: string,
  asciiFormat?: string | null,
  columnPlan?: ColumnPlan | null,
  worldShift?: [number, number, number] | null,
  missDistanceThreshold?: number | null,
  origin?: [number, number, number] | null,
  signal?: AbortSignal,
  onProgress?: BinaryFrameProgress,
  onRunId?: (runId: string) => void,
  // See createCloudSession: in-file formats only; ASCII skips ride the plan.
  droppedSlugs?: string[] | null,
): Promise<CloudScanPosition[]> {
  try {
    const res = await fetchJsonWithProgress<CloudScanPositions & { error?: string }>(
      '/api/cloud/session/create-multi',
      {
        source_path: filePath,
        ascii_format: asciiFormat ?? null,
        column_plan: columnPlan ? columnPlanToPayload(columnPlan) : null,
        world_shift: worldShift ?? null,
        miss_distance_threshold: missDistanceThreshold ?? null,
        origin: origin ?? null,
        drop_slugs: droppedSlugs?.length ? droppedSlugs : null,
      },
      signal,
      600000,
      onProgress,
      onRunId,
    );
    if (res.error) throw new Error(res.error);
    return res.scans ?? [];
  } catch (error) {
    if (error instanceof ScanCancelledError) throw error;
    console.error('create_multi_cloud_session failed:', error);
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

/** One replayable label edit. Mirrors LabelStroke in backend-api/main.py. */
export interface LabelStrokeRequest {
  region: CropOctreeRegion;
  to_class: number;
  /** Omit for "any visible" — no class gate. */
  from_classes?: number[];
  stroke_id: string;
}

export interface LabelStrokeResult {
  stroke_id: string;
  selected_count: number;
  changed_count: number;
}

export interface LabelRegionResult {
  session_id: string;
  slug: string;
  created_column: boolean;
  applied: LabelStrokeResult[];
  /** value -> count, over EDITABLE points only (no deleted rows, no misses). */
  class_counts: Record<string, number>;
  value_range: [number, number];
  /** Surviving history length — the renderer trims its stroke list to match. */
  label_edit_count: number;
}

/**
 * Repaint points. Instant: mutates the in-RAM label column with NO octree
 * rebuild, so the viewport relies on the renderer's client-side label overlay
 * until an explicit commit.
 *
 * Strokes are applied IN ORDER and atomically, so a whole brush drag goes in
 * one call rather than one request per stamp.
 */
export async function labelCloudRegion(
  sessionId: string,
  strokes: LabelStrokeRequest[],
  slug?: string,
  label?: string,
): Promise<LabelRegionResult> {
  const baseUrl = getBackendUrl();
  try {
    const response = await fetch(
      `${baseUrl}/api/cloud/session/${sessionId}/label_region`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ strokes, ...(slug ? { slug } : {}), ...(label ? { label } : {}) }),
      },
    );
    if (!response.ok) {
      const errorData = await response.json().catch(() => ({}));
      throw new Error(errorData.detail || `HTTP ${response.status}: ${response.statusText}`);
    }
    return (await response.json()) as LabelRegionResult;
  } catch (error) {
    console.error('label_cloud_region failed:', error);
    throw error;
  }
}

/**
 * Read the current per-class counts without changing anything. Used to populate
 * the class list the moment the labelling tool opens — the renderer cannot
 * derive these itself because they exclude deleted rows and sky/miss points.
 */
export async function getCloudLabelSummary(
  sessionId: string,
  slug?: string,
): Promise<Omit<LabelRegionResult, 'created_column' | 'applied'>> {
  const baseUrl = getBackendUrl();
  const q = slug ? `?slug=${encodeURIComponent(slug)}` : '';
  try {
    const response = await fetch(
      `${baseUrl}/api/cloud/session/${sessionId}/label_summary${q}`,
    );
    if (!response.ok) {
      const errorData = await response.json().catch(() => ({}));
      throw new Error(errorData.detail || `HTTP ${response.status}: ${response.statusText}`);
    }
    return await response.json();
  } catch (error) {
    console.error('get_cloud_label_summary failed:', error);
    throw error;
  }
}

/**
 * Undo: roll the label column back, keeping the first `editCount` edits. Omit
 * to clear all labelling on the slug. No rebuild.
 */
export async function resetCloudLabelEdits(
  sessionId: string,
  editCount?: number,
  slug?: string,
): Promise<Omit<LabelRegionResult, 'created_column' | 'applied'>> {
  const baseUrl = getBackendUrl();
  try {
    const response = await fetch(
      `${baseUrl}/api/cloud/session/${sessionId}/reset_label_edits`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          ...(editCount === undefined ? {} : { edit_count: editCount }),
          ...(slug ? { slug } : {}),
        }),
      },
    );
    if (!response.ok) {
      const errorData = await response.json().catch(() => ({}));
      throw new Error(errorData.detail || `HTTP ${response.status}: ${response.statusText}`);
    }
    return await response.json();
  } catch (error) {
    console.error('reset_cloud_label_edits failed:', error);
    throw error;
  }
}

/**
 * Bake the label column into the octree so it colours without the client-side
 * overlay. One PotreeConverter run — the slow step.
 *
 * DISPLAY ONLY: every backend op reads the in-RAM arrays, so split / filter /
 * extract / LAS export already see fresh labels with no commit. Do not call
 * this defensively before those.
 */
export async function commitCloudLabels(
  sessionId: string,
  slug?: string,
): Promise<OctreeMetadata & { slug: string; class_counts: Record<string, number> }> {
  const baseUrl = getBackendUrl();
  const controller = new AbortController();
  const timeoutId = abortOnTimeout(controller, 600000, '/api/cloud/session/commit_labels');
  try {
    const response = await fetch(
      `${baseUrl}/api/cloud/session/${sessionId}/commit_labels`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(slug ? { slug } : {}),
        signal: controller.signal,
      },
    );
    clearTimeout(timeoutId);
    if (!response.ok) {
      const errorData = await response.json().catch(() => ({}));
      throw new Error(errorData.detail || `HTTP ${response.status}: ${response.statusText}`);
    }
    return await response.json();
  } catch (error) {
    clearTimeout(timeoutId);
    console.error('commit_cloud_labels failed:', error);
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
  const timeoutId = abortOnTimeout(controller, 300000, '/api/cloud/session/:id/bake');
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
  const timeoutId = abortOnTimeout(controller, 300000, '/api/cloud/session/:id/filter');
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

/**
 * Apply a rigid 4x4 transform (ROW-MAJOR, world-frame — the layout an ICP
 * registration returns) to a session's geometry in place and rebuild its octree
 * (+ miss octree). Moves an octree-backed cloud whose points live in the backend
 * session, not in the renderer's (empty) in-RAM array — used by cloud-to-cloud
 * ICP to move a streamed SOURCE cloud onto the target.
 */
export async function sessionTransform(
  sessionId: string,
  matrix: number[],
): Promise<CloudSessionBakeResult> {
  const baseUrl = getBackendUrl();
  const controller = new AbortController();
  const timeoutId = abortOnTimeout(controller, 300000, '/api/cloud/session/:id/transform');
  try {
    const response = await fetch(`${baseUrl}/api/cloud/session/${sessionId}/transform`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ matrix }),
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
    console.error('session_transform failed:', error);
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
  const timeoutId = abortOnTimeout(controller, 300000, '/api/cloud/session/:id/split');
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
  const timeoutId = abortOnTimeout(controller, 300000, '/api/cloud/session/:id/extract');
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

/** Metadata for one child session produced by {@link sessionExtractByColumn}. */
export type SessionExtractChild = OctreeMetadata & {
  value: number;         // the distinct column value this child was sliced for (e.g. tree id)
  session_id: string;
  point_count: number;
  cache_id: string;
};

/** Split a categorical column into ONE child session per distinct value (parent
 * untouched) in a SINGLE backend call — the server slices every subset under one
 * lock and builds their octrees concurrently. This is the batch form of
 * {@link sessionExtract}: for a per-tree split of ~100 trees it replaces ~100
 * serial round-trips (one octree build each) with one call whose builds run in
 * parallel. `excludeValues` defaults to [0] (ground/miss/unassigned). */
export async function sessionExtractByColumn(
  sessionId: string,
  slug: string,
  options?: {
    excludeValues?: number[];
    signal?: AbortSignal;
    // Per-child build progress ("Building 7 of 42 clouds…"). The split is a
    // minute-scale op on a large plot, so the caller needs a status pill.
    onProgress?: BinaryFrameProgress;
    onRunId?: (runId: string) => void;
  },
): Promise<{ session_id: string; children: SessionExtractChild[] }> {
  try {
    const result = await fetchJsonWithProgress<
      { session_id: string; children: SessionExtractChild[]; error?: string }
    >(
      `/api/cloud/session/${sessionId}/extract_by_column`,
      { slug, exclude_values: options?.excludeValues ?? null },
      options?.signal,
      600000,
      options?.onProgress,
      options?.onRunId,
    );
    // A build that failed mid-stream reports in the JSON tail (the response is
    // already a 200 by then), so surface it as a real error rather than
    // silently returning zero children.
    if (result.error) throw new Error(result.error);
    return result;
  } catch (error) {
    console.error('session_extract_by_column failed:', error);
    throw error;
  }
}

/** Copy a session's surviving points into a NEW independent session (parent
 * untouched) and build its octree. The keep-everything case of extract — a pure
 * array copy, no source file read, so wizard customizations are preserved.
 * Returns the copy's octree metadata. */
export async function duplicateCloudSession(
  sessionId: string,
): Promise<{ session_id: string; duplicate: (OctreeMetadata & { session_id: string; point_count: number; cache_id: string }) | null }> {
  const baseUrl = getBackendUrl();
  const controller = new AbortController();
  const timeoutId = abortOnTimeout(controller, 300000, '/api/cloud/session/:id/duplicate');
  try {
    const response = await fetch(`${baseUrl}/api/cloud/session/${sessionId}/duplicate`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
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
    console.error('duplicate_cloud_session failed:', error);
    throw error;
  }
}

/** Concatenate the surviving points of >=2 cloud sessions into one NEW session
 * and build its octree (the "Stitch Clouds" merge). Reconciles differing global
 * shifts and unions scalar extra-dim columns server-side — no source file read,
 * and (critically) no reliance on the renderer's flat `positions`, which is empty
 * for octree-backed clouds. Returns the merged octree metadata. */
export async function sessionMerge(
  sessionIds: string[],
): Promise<{ merged: OctreeMetadata & { session_id: string; point_count: number; cache_id: string; world_shift?: [number, number, number] | null; has_misses?: boolean; miss_octree_cache_id?: string | null } }> {
  const baseUrl = getBackendUrl();
  const controller = new AbortController();
  const timeoutId = abortOnTimeout(controller, 300000, '/api/cloud/session/merge');
  try {
    const response = await fetch(`${baseUrl}/api/cloud/session/merge`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ session_ids: sessionIds }),
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
    console.error('session_merge failed:', error);
    throw error;
  }
}

/** Run CSF ground segmentation on the session's in-RAM points, append a
 * `ground_class` column, and rebuild the octree from the arrays (no file read). */
export async function sessionSegmentGround(
  sessionId: string,
  params: { cloth_resolution?: number; rigidness?: number; class_threshold?: number; iterations?: number; slope_smooth?: boolean; auto_class_threshold?: boolean },
  signal?: AbortSignal,
): Promise<CloudSessionBakeResult & { class_threshold_used?: number; class_threshold_method?: string }> {
  return postSegment<CloudSessionBakeResult & { class_threshold_used?: number; class_threshold_method?: string }>(
    `/api/cloud/session/${sessionId}/segment_ground`, params, signal);
}

/** Run wood/leaf segmentation on the session's in-RAM points, append a
 * `wood_class` column (1=wood, 2=leaf), and rebuild the octree from the arrays
 * (no file read). Pass segment_wood tuning params. */
export async function sessionSegmentWood(
  sessionId: string,
  params: { k_min?: number; k_max?: number; k_step?: number; wood_bias?: number; reg_k?: number; reg_iters?: number; min_speckle?: number; voxel_size?: number; method?: 'sota' | 'connectivity' | 'geometric'; backbone_support?: number; reflectance_weight_max?: number; scalar_slug?: string },
  signal?: AbortSignal,
): Promise<CloudSessionBakeResult> {
  return postSegment<CloudSessionBakeResult>(`/api/cloud/session/${sessionId}/segment_wood`, params, signal, 600000);
}

/** Run TreeIso on the session's in-RAM points, append a `tree_instance` column,
 * and rebuild the octree from the arrays (no file read). Pass TreeIso tuning. */
export async function sessionSegmentTrees(
  sessionId: string,
  // `acknowledge_cost` (boolean) confirms an expensive run after the backend
  // answered 409 with a cost advisory — hence the boolean in the index signature.
  params: { [k: string]: number | number[][] | boolean | undefined; seed_points?: number[][]; acknowledge_cost?: boolean },
  signal?: AbortSignal,
): Promise<CloudSessionBakeResult> {
  return postSegment<CloudSessionBakeResult>(`/api/cloud/session/${sessionId}/segment_trees`, params, signal, 600000);
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

// ==================== QSM (Quantitative Structure Model) API ====================

/**
 * Build a true QSM from a dormant-tree point cloud: connected cylinders with
 * radii + topology, continuous shoots classified by SHOOT RANK (trunk=0,
 * scaffolds=1, ...). Send inline `points` for flat clouds or a `source` for
 * octree-backed clouds. `twig_radius_mm` anchors the radius taper at the tips
 * (per-species; orchard cultivars are user-supplied).
 */
export interface QSMBuildRequest {
  points?: number[][];          // [[x, y, z], ...] — omit when `source` is set
  source?: BackendPointSource;  // octree-backed clouds read from disk
  // Aggregate build: several pre-registered scans fused into ONE QSM. Each is
  // read and concatenated server-side (the only way to fuse octree clouds,
  // whose display positions are empty client-side). Takes precedence over
  // points/source.
  sources?: BackendPointSource[];
  twig_radius_mm?: number;      // tip radius anchor, default 4.23 mm
  w_growthlength?: number;      // continuation weights; default (1, 0, 0)
  w_area?: number;
  w_colinear?: number;
}

export interface QSMCylinder {
  cyl_id: number;
  start: [number, number, number];
  end: [number, number, number];
  radius: number;               // meters
  parent_id: number;            // cyl_id of parent, or -1
  shoot_id: number;
  rank: number;                 // shoot rank with axis continuation (trunk = 0)
  surf_cov: number | null;      // surface coverage [0,1]; low => one-sided
  mad: number | null;           // mean abs point-to-surface distance, meters
}

export interface QSMShoot {
  shoot_id: number;
  rank: number;
  cylinder_ids: number[];       // ordered base->tip
  parent_shoot_id: number;
  parent_cyl_id: number;
  child_shoot_ids: number[];
}

export interface QSMRankMetrics {
  rank: number;
  n_shoots: number;
  total_length_m: number;
  mean_shoot_length_m: number;
  woody_volume_m3: number;
  mean_diameter_mm: number;
  mean_branch_angle_deg: number | null;
}

export interface QSMMetrics {
  tcsa_m2: number;
  trunk_diameter_mm: number;
  tree_height_m: number;
  n_scaffolds: number;
  n_shoots_total: number;
  max_rank: number;
  total_woody_volume_m3: number;
  stem_volume_m3: number;
  branch_volume_m3: number;
  total_length_m: number;
  canopy_width_m: number;
  canopy_height_m: number;
  per_rank: QSMRankMetrics[];
}

export interface QSMBuildResponse {
  success: boolean;
  cylinders: QSMCylinder[];
  shoots: QSMShoot[];
  metrics: QSMMetrics | null;
  n_cylinders: number;
  n_shoots: number;
  points_used: number;
  error?: string;
}

export async function buildQSM(
  request: QSMBuildRequest,
  signal?: AbortSignal,
  onProgress?: BinaryFrameProgress,
): Promise<QSMBuildResponse> {
  // The QSM pipeline (skeleton → segments → IRLS cylinder fit → radius correction
  // → metrics) is heavier than skeleton extraction, so the endpoint streams
  // per-stage PHP1 progress markers ahead of the JSON result (like triangulation /
  // backfill). fetchJsonWithProgress drains the markers (firing onProgress) and
  // parses the trailing JSON, and owns the 5-minute abort/timeout — otherwise a
  // large/pathological cloud leaves the UI stuck in qsmInProgress with no recovery.
  return await fetchJsonWithProgress<QSMBuildResponse>(
    '/api/qsm/build',
    request,
    signal,
    300000, // 5 minutes
    onProgress,
  );
}

/**
 * Import a QSM from a per-cylinder CSV on disk — the inverse of the CSV export in
 * lib/qsmExport.ts. The backend parses the table and recomputes the metrics (which
 * aren't in the file but are a pure function of the model), returning the same
 * QSMBuildResponse shape /api/qsm/build does, so a re-imported QSM needs no
 * separate data path in the renderer.
 *
 * Not streamed: parsing a cylinder table is milliseconds, unlike a QSM build.
 */
export async function importQSMCsv(filePath: string): Promise<QSMBuildResponse> {
  const baseUrl = getBackendUrl();
  const controller = new AbortController();
  const timeoutId = abortOnTimeout(controller, 120000, '/api/qsm/import');
  try {
    const response = await fetch(`${baseUrl}/api/qsm/import`, {
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
    console.error('QSM CSV import failed:', error);
    throw error;
  }
}

// ==================== CROWN FITTING ====================

// Per-crown metrics computed by /api/fit/crown. Coordinates are WORLD-frame
// (the renderer re-applies the source cloud's worldShift like other meshes).
export interface CrownMetrics {
  tree_height_m: number;      // crown top minus the ground baseline
  crown_volume_m3: number;
  crown_center: [number, number, number];
  crown_dims_m: [number, number, number];  // world-axis-aligned width/depth/height
  crown_base_z: number;
  crown_top_z: number;
  surface_area_m2: number;
  num_points_used: number;
  // Mesh size. Fixed for the parametric shapes; data-dependent for an alpha hull,
  // where it's the only honest measure of how big the exported mesh is.
  num_vertices?: number;
  num_triangles?: number;
}

/**
 * The parameters that DEFINE a fitted crown — what it takes to rebuild the solid,
 * as opposed to the summary statistics in CrownMetrics. Keys are shape-dependent:
 *
 * - ellipsoid / prism: `a_m`/`b_m`/`c_m`, the semi-extent along x/y/z (the
 *   ellipsoid's semi-axes, the prism's half-extents) — the same meaning in both.
 * - cone: `base_radius_m` + `height_m`.
 * - alpha: `alpha_m` (auto-grown unless the user overrode it, hence `alpha_auto`)
 *   and `watertight`. A concave hull has NO analytic parameters, so these describe
 *   the fit but can't reproduce it — the mesh has to travel with the table.
 *
 * The shape's center is deliberately absent: for all three parametric shapes it is
 * exactly `metrics.crown_center` (the fitted mesh's AABB center).
 *
 * Optional so a backend that predates it degrades to blank columns, not a crash.
 */
export interface CrownFitParams {
  a_m?: number;
  b_m?: number;
  c_m?: number;
  base_radius_m?: number;
  height_m?: number;
  alpha_m?: number;
  alpha_auto?: boolean;
  watertight?: boolean;
}

export interface CrownFitCrown {
  tree_instance_id: number;   // 0 when the whole cloud was treated as one tree
  shape: string;              // 'ellipsoid' | 'prism' | 'cone' | 'alpha'
  vertices: number[];         // flat xyz
  triangles: number[];        // flat indices
  normals: number[];          // flat per-vertex xyz
  metrics: CrownMetrics;
  params?: CrownFitParams;    // shape-dependent; see CrownFitParams
}

export interface CrownFitRequest {
  source: BackendPointSource;
  shape: string;              // 'ellipsoid' | 'prism' | 'cone' | 'alpha'
  strictness: number;         // 0..1 fuzzy trim
  use_leaf_only: boolean;
  tree_instance_ids?: number[] | null;
  ground_baseline: 'ground_class' | 'min_z';
  alpha?: number | null;
}

export interface CrownFitResponse {
  success: boolean;
  crowns: CrownFitCrown[];
  warnings: string[];
  error?: string;
}

// Fit crown shapes + metrics for one scan's points (one crown per tree). The
// endpoint streams PHP1 progress markers then a JSON tail; fetchJsonWithProgress
// drains the markers (firing onProgress + onRunId) and parses the JSON, owning
// the abort/timeout so a heavy alpha fit can't wedge the UI.
export async function fitCrown(
  request: CrownFitRequest,
  signal?: AbortSignal,
  onProgress?: BinaryFrameProgress,
  onRunId?: (runId: string) => void,
): Promise<CrownFitResponse> {
  return await fetchJsonWithProgress<CrownFitResponse>(
    '/api/fit/crown',
    request,
    signal,
    300000, // 5 minutes
    onProgress,
    onRunId,
  );
}

// ==================== QSM LEAF RECONSTRUCTION (Phase 1) ====================
// Procedurally add leaves to a built QSM. The response mirrors the plant/mesh
// shape (PlantMeshResponseLike) so plantResponseToMeshData() consumes it and
// TexturedPlantMesh renders the leaves with alpha-cutout textures.

// Curated tree-leaf subset of the Helios plantarchitecture textures, surfaced in
// the Add Leaves picker. Authoritative list comes from GET /api/qsm/leaf-textures;
// this is the fallback / default ordering. (No annual-crop leaves.)
export const CURATED_LEAF_TEXTURES: string[] = [
  'AlmondLeaf.png',
  'AppleLeaf.png',
  'WalnutLeaf.png',
  'PistachioLeaf.png',
  'OliveLeaf_upper.png',
  'GrapeLeaf.png',
  'RedbudLeaf.png',
];

export interface QSMPhyllotaxisResponse {
  success: boolean;
  angle_deg: number;
  pattern: string;            // opposite | spiral | decussate | alternate
  leaves_per_node: number;
  confidence: number;         // [0,1]; 0 when no multi-child parent exists
  n_parents_sampled: number;
  error?: string;
}

export interface QSMLeavesRequest {
  cylinders: QSMCylinder[];   // round-tripped from the QSMEntry
  shoots: QSMShoot[];
  leaf_spacing: number;       // m between nodes along a shoot
  leaf_pitch_deg: number;     // leaf angle from the shoot axis
  leaf_size_m: number;        // leaf length
  phyllotaxis_deg: number;    // azimuth increment between nodes
  leaves_per_node: number;
  builtin_texture_name?: string;  // e.g. "AlmondLeaf.png"
  texture_path?: string;          // uploaded PNG path
  obj_path?: string;              // uploaded OBJ path
  max_leaves?: number;
}

// Mirrors PlantMeshResponseLike (+ leaf_count/success/error) so it flows straight
// into plantResponseToMeshData().
export interface QSMLeavesResponse {
  success: boolean;
  vertices: number[][];
  indices: number[][];
  normals?: number[][] | null;
  uv_coordinates?: number[][] | null;
  materials?: { name: string; color?: number[]; texture_name?: string; has_alpha: boolean }[] | null;
  material_groups?: { material_name: string; triangle_indices: number[] }[] | null;
  textures?: Record<string, string> | null;
  vertex_count: number;
  triangle_count: number;
  leaf_count: number;
  error?: string;
}

export async function detectPhyllotaxis(
  cylinders: QSMCylinder[],
  shoots: QSMShoot[],
): Promise<QSMPhyllotaxisResponse> {
  const baseUrl = getBackendUrl();
  const controller = new AbortController();
  const timeoutId = abortOnTimeout(controller, 60000, '/api/qsm/phyllotaxis'); // 1 minute
  try {
    const response = await fetch(`${baseUrl}/api/qsm/phyllotaxis`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ cylinders, shoots }),
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
    console.error('Phyllotaxis detection failed:', error);
    throw error;
  }
}

export async function addQSMLeaves(request: QSMLeavesRequest): Promise<QSMLeavesResponse> {
  const baseUrl = getBackendUrl();
  const controller = new AbortController();
  const timeoutId = abortOnTimeout(controller, 300000, '/api/qsm/leaves'); // 5 minutes
  try {
    const response = await fetch(`${baseUrl}/api/qsm/leaves`, {
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
    console.error('Add QSM leaves request failed:', error);
    throw error;
  }
}

export async function getLeafTextures(): Promise<string[]> {
  const baseUrl = getBackendUrl();
  try {
    const response = await fetch(`${baseUrl}/api/qsm/leaf-textures`);
    if (!response.ok) return CURATED_LEAF_TEXTURES;
    const body = await response.json();
    return Array.isArray(body.textures) && body.textures.length ? body.textures : CURATED_LEAF_TEXTURES;
  } catch {
    return CURATED_LEAF_TEXTURES;
  }
}

// ==================== QSM BARK TEXTURES ====================
// Bark images for the QSM viewer's "Color by > Texture" mode. The renderer can't
// read the PyInstaller bundle directly, so the backend resolves and base64s them.
// Authoritative list comes from GET /api/qsm/bark-textures; this is the fallback.
export const CURATED_BARK_TEXTURES: string[] = [
  'AlmondBark.jpg',
  'AppleBark.jpg',
  'GrapeBark.jpg',
  'OliveBark.jpg',
  'WesternRedbudBark.jpg',
];

export interface QSMBarkTextureResponse {
  success: boolean;
  name?: string;
  data_base64?: string;
  mime?: string;
  error?: string;
}

export async function getBarkTextures(): Promise<string[]> {
  const baseUrl = getBackendUrl();
  try {
    const response = await fetch(`${baseUrl}/api/qsm/bark-textures`);
    if (!response.ok) return CURATED_BARK_TEXTURES;
    const body = await response.json();
    return Array.isArray(body.textures) && body.textures.length ? body.textures : CURATED_BARK_TEXTURES;
  } catch {
    return CURATED_BARK_TEXTURES;
  }
}

/** Fetch one bark image as base64, from the builtin library or an uploaded path. */
export async function getBarkTexture(
  source: { builtinName: string } | { texturePath: string }
): Promise<QSMBarkTextureResponse> {
  const baseUrl = getBackendUrl();
  const body =
    'builtinName' in source
      ? { builtin_name: source.builtinName }
      : { texture_path: source.texturePath };
  try {
    const response = await fetch(`${baseUrl}/api/qsm/bark-texture`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    if (!response.ok) {
      return { success: false, error: `HTTP ${response.status}: ${response.statusText}` };
    }
    return await response.json();
  } catch (error) {
    return { success: false, error: error instanceof Error ? error.message : String(error) };
  }
}

// ==================== QSM LEAF-ANGLE ADJUSTMENT (Phase 2) ====================
// Rotate a QSM's procedurally-placed leaves so each voxel cell's leaf-angle
// distribution matches a target measured from a leaf-on Helios triangulation.

export interface QSMGrid {
  center: [number, number, number];
  size: [number, number, number];
  nx: number;
  ny: number;
  nz: number;
}

// A leaf-on Helios triangulation overlapping the QSM (flat arrays from MeshData).
export interface QSMTriangulationInput {
  vertices: number[];            // flat x,y,z
  indices: number[];             // flat triangle vertex indices
  triangle_cell_ids: number[];   // per-triangle grid cell (-1/0xffffffff = outside)
  triangle_scan_ids?: number[];  // per-triangle source scan (azimuth orientation)
  scan_origins?: number[];       // flat per-scan x,y,z origins
  grid: QSMGrid;
}

// A precomputed per-cell target (escape hatch; the backend normally fits these).
export interface QSMCellTarget {
  cell_id: number;
  beta_mu: number;
  beta_nu: number;
  ecc: number;
  phi0_deg: number;
  n_measured?: number;
}

// Extends the Phase-1 leaf request (so leaves regenerate identically) with the
// measured-distribution inputs. Exactly one of triangulation / cell_targets.
export interface QSMAdjustLeafAnglesRequest extends QSMLeavesRequest {
  triangulation?: QSMTriangulationInput;
  cell_targets?: QSMCellTarget[];
  grid?: QSMGrid;       // required when using cell_targets
  seed?: number;
  max_cell_leaves?: number;
}

export async function adjustQSMLeafAngles(
  request: QSMAdjustLeafAnglesRequest,
): Promise<QSMLeavesResponse> {
  const baseUrl = getBackendUrl();
  const controller = new AbortController();
  const timeoutId = abortOnTimeout(controller, 300000, '/api/qsm/adjust-leaf-angles'); // 5 minutes
  try {
    const response = await fetch(`${baseUrl}/api/qsm/adjust-leaf-angles`, {
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
    console.error('Adjust QSM leaf angles request failed:', error);
    throw error;
  }
}

