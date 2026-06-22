// Parameters describing the physical scanner that produced (or will produce)
// a point cloud: where it sat, how widely it swept, and what kind of returns
// it captured. These eventually drive a pyhelios scan definition. Today they
// also place a ScannerMarker in the viewer scene.
//
// A Scan (see ./scan) may carry these parameters or not — some pre-merged
// clouds have no single defined origin. Analyses that need pulse directions
// (e.g. Helios triangulation) are gated on presence of params.

import { poseStreamFromWire } from './poseStream';

// How many returns a pulse reports — a property of the real instrument, not of
// the simulation. The helios-core lidar engine fires `raysPerPulse` sub-rays
// across the beam cone (exit diameter + divergence) and resolves the analytic
// waveform into returns:
//   - 'single': at most one return per pulse (RETURN_MODE_SINGLE, maxReturns=1),
//               chosen by `returnSelection` (strongest/first/last). Models
//               single-return TLS (Leica, FARO) and single-return-configured
//               spinning sensors (Velodyne).
//   - 'multi' : all detected returns reported up to `maxReturns`
//               (RETURN_MODE_MULTI). Models full-waveform / multi-echo
//               instruments (RIEGL VZ-400i, miniVUX) that penetrate foliage.
//
// For an idealized, exact-intersection scan (no beam-footprint spread), set
// `raysPerPulse` to 1 in the Synthetic Scan Options — that is a simulation knob,
// not a scan property, so it is NOT a return mode here.
export type PulseReturnMode = 'single' | 'multi';

// Which return a single-return pulse keeps when its beam cone resolves several.
// Maps to helios-core SingleReturnSelection (STRONGEST/FIRST/LAST).
export type SingleReturnSelection = 'strongest' | 'first' | 'last';

// Acquisition geometry of the scan.
//   - 'raster'            : uniform Ntheta x Nphi angular grid (the classic
//                           gimbal/dome sweep). Zenith is `zenithPoints` samples
//                           across the [zenithMin, zenithMax] sweep.
//   - 'spinning_multibeam': a rotating multi-channel sensor (Velodyne/Ouster/
//                           Hesai). Each laser channel fires at a fixed zenith
//                           angle taken from `beamElevationAnglesDeg`, so Ntheta
//                           is the number of channels and there is no zenith
//                           sweep. Azimuth (azimuthPoints = Nphi, azimuth
//                           sweep = phi range) is shared with raster.
export type ScanPattern = 'raster' | 'spinning_multibeam';

export interface ScanParameters {
  origin: { x: number; y: number; z: number };
  // Which scanner instrument this scan represents. Drives the marker mesh and
  // (at selection time) auto-fills the instrument-fixed acquisition parameters
  // below. 'generic' is an unknown/custom scanner drawn as a plain sphere.
  // Optional + defaulted so scans persisted before this field existed (and
  // file-header / XML imports, which never name a model) read back as generic.
  // See ./scannerModels for the catalog and presets.
  scannerModel?: import('./scannerModels').ScannerModelId;
  pattern: ScanPattern;
  // Number of sample rays in each angular direction. For spinning_multibeam,
  // `zenithPoints` and the zenith sweep are unused (Ntheta = number of channels);
  // `azimuthPoints` is still Nphi.
  zenithPoints: number;
  azimuthPoints: number;
  // Angular sweep boundaries, in degrees. Min/max positions define the sweep
  // explicitly (the range is max - min), allowing asymmetric sweeps. These map
  // to Helios theta_min/theta_max (zenith) and phi_min/phi_max (azimuth).
  zenithMinDeg: number;
  zenithMaxDeg: number;
  azimuthMinDeg: number;
  azimuthMaxDeg: number;
  // How many returns the pulse reports (single / multi).
  returnMode: PulseReturnMode;
  // Multi-return only: the maximum number of returns reported per pulse (the
  // engine's maxReturns). Ignored by 'single' (capped at 1).
  maxReturns: number;
  // Single-return only: which return to keep when the beam cone resolves several
  // (strongest / first / last). Ignored by 'multi'.
  returnSelection: SingleReturnSelection;
  // Beam exit diameter in meters and divergence in milliradians (the units
  // pyhelios uses). Define the beam cone sampled by both single- and multi-return
  // scans (a wider cone footprint hits more surfaces near edges). At rays-per-pulse
  // = 1 the cone collapses to one exact ray and these are effectively ignored.
  beamExitDiameterM: number;
  beamDivergenceMrad: number;
  // Residual scanner tilt away from plumb, in degrees — a real property of the
  // physical instrument (a dual-axis inclinometer reports two angles), not a
  // synthetic-only knob. Roll is applied first (about the body lateral axis),
  // then pitch (about the forward / azimuth-zero axis). 0/0 = perfectly level.
  // Maps to Helios <scanTilt> "roll pitch" (degrees) and pyhelios
  // scan_tilt_roll/scan_tilt_pitch (radians).
  tiltRollDeg: number;
  tiltPitchDeg: number;
  // Initial scanner heading in the world XY plane, in degrees — the azimuth the
  // scanner's forward axis points along before the sweep begins. CCW-from-+X
  // positive (0 = +X). A real property of how the instrument was set up on the
  // tripod, independent of the azimuth *sweep* bounds below. Maps to Helios
  // <scanAzimuthOffset> (degrees) and pyhelios scan_azimuth_offset (radians,
  // v0.1.23+). 0 = default heading. Also orients the scanner marker mesh in
  // the viewer.
  azimuthOffsetDeg: number;
  // Spinning-multibeam only. Per-channel beam elevation angles in degrees above
  // the horizon — the manufacturer-spec convention (positive = above horizon).
  // Length sets Ntheta. Maps to Helios <beamElevationAngles>; the backend
  // converts each to a zenith angle (zenith = 90 - elevation) for pyhelios.
  beamElevationAnglesDeg: number[];
  // Moving-platform trajectory. When set, this scan is a moving-platform
  // acquisition (drone / robot / tractor): `origin` is only a fallback anchor
  // (it should equal the first pose's position), and leaf-area inversion uses a
  // PER-BEAM origin reconstructed by joining each return's timestamp to this
  // trajectory. Undefined ⇒ a static (tripod) scan, unchanged. Imported from a
  // trajectory file; see ./poseStream.
  trajectory?: import('./poseStream').PoseStream;
  // Pulse repetition rate in Hz — pulses fired per second. Used ONLY by a
  // synthetic MOVING scan to space pulses in time along the trajectory
  // (t = t0 + ordinal / pulseRateHz), which determines how far the platform
  // moves between pulses and thus how much of the flight the Ntheta×Nphi sweep
  // covers. Auto-filled from the scanner model preset; editable. Ignored by
  // static scans and by leaf-area inversion.
  pulseRateHz?: number;
}

// A scan is a moving-platform acquisition iff it carries a trajectory.
export function isMovingScan(p: ScanParameters): boolean {
  return p.trajectory != null;
}

export const DEFAULT_SCAN_PARAMETERS: ScanParameters = {
  origin: { x: 0, y: 0, z: 0 },
  scannerModel: 'generic',
  pattern: 'raster',
  zenithPoints: 100,
  azimuthPoints: 360,
  zenithMinDeg: 0,
  zenithMaxDeg: 180,
  azimuthMinDeg: 0,
  azimuthMaxDeg: 360,
  returnMode: 'single',
  maxReturns: 5,
  returnSelection: 'strongest',
  beamExitDiameterM: 0.01,
  beamDivergenceMrad: 0.5,
  tiltRollDeg: 0,
  tiltPitchDeg: 0,
  azimuthOffsetDeg: 0,
  // A generic 8-channel elevation spread; only used when pattern is multibeam.
  beamElevationAnglesDeg: [15, 10, 5, 0, -5, -10, -15, -20],
  // Generic moving-scan pulse rate (300 kHz); model presets override it. Only
  // used by a synthetic moving scan.
  pulseRateHz: 300000,
};

// Migrate a persisted scan-params blob to the current shape. Older scans (and
// electron-store entries) carried `returnType: 'single' | 'multi'` and no
// maxReturns / returnSelection. Map the old field onto `returnMode` and fill the
// new fields from defaults so a stale persisted scan never loads with an invalid
// or missing return mode.
export function migrateScanReturnFields(
  raw: Record<string, unknown>,
): Pick<ScanParameters, 'returnMode' | 'maxReturns' | 'returnSelection'> {
  const legacy = raw.returnType;
  const current = raw.returnMode;
  let returnMode: PulseReturnMode;
  if (current === 'single' || current === 'multi') {
    returnMode = current;
  } else if (legacy === 'multi') {
    returnMode = 'multi';
  } else if (legacy === 'single') {
    returnMode = 'single';
  } else {
    returnMode = DEFAULT_SCAN_PARAMETERS.returnMode;
  }
  const rawMax = raw.maxReturns;
  const maxReturns =
    typeof rawMax === 'number' && Number.isFinite(rawMax) && rawMax >= 1
      ? Math.round(rawMax)
      : DEFAULT_SCAN_PARAMETERS.maxReturns;
  const rawSel = raw.returnSelection;
  const returnSelection: SingleReturnSelection =
    rawSel === 'strongest' || rawSel === 'first' || rawSel === 'last'
      ? rawSel
      : DEFAULT_SCAN_PARAMETERS.returnSelection;
  return { returnMode, maxReturns, returnSelection };
}

export function makeDefaultScanParameters(
  originGuess?: { x: number; y: number; z: number },
): ScanParameters {
  return {
    ...DEFAULT_SCAN_PARAMETERS,
    origin: originGuess
      ? { x: originGuess.x, y: originGuess.y, z: originGuess.z }
      : { ...DEFAULT_SCAN_PARAMETERS.origin },
  };
}

// Scan-pattern parameters as recovered from a point-cloud FILE header (E57 pose
// + angular sweep + grid resolution; PCD VIEWPOINT origin). Every field but
// `origin` is optional — formats carry different subsets. Mirrors the backend
// `scan_params` dict surfaced by create_cloud_session.
export interface ScanParamsFromFile {
  origin: [number, number, number];
  n_theta?: number;
  n_phi?: number;
  theta_min?: number;
  theta_max?: number;
  phi_min?: number;
  phi_max?: number;
  tilt_roll_deg?: number;
  tilt_pitch_deg?: number;
  azimuth_offset_deg?: number;
  // A reconstructed platform trajectory (canonical PoseStream wire shape) when the
  // file describes a MOVING-platform scan — e.g. a LAS carrying per-pulse beam-origin
  // ExtraBytes, from which the backend rebuilds a decimated path. Mapped through
  // poseStreamFromWire so the imported scan is auto-flagged moving with its path drawn.
  trajectory?: unknown;
}

// Build ScanParameters from the partial set a file header carried, filling any
// field the file omitted from DEFAULT_SCAN_PARAMETERS. This is the non-XML
// import equivalent of parsing a Helios <scan>: whatever the format records
// (always origin, plus angular sweep + grid for E57) is populated, and the rest
// stays at the sensible default — so "not in the file" continues to mean
// "left blank" exactly as it does today.
export function scanParametersFromFile(src: ScanParamsFromFile): ScanParameters {
  // File-header imports (E57 pose / PCD VIEWPOINT) never describe a multibeam
  // sensor, so pattern stays 'raster' (from DEFAULT_SCAN_PARAMETERS) here.
  const p: ScanParameters = {
    ...DEFAULT_SCAN_PARAMETERS,
    origin: { x: src.origin[0], y: src.origin[1], z: src.origin[2] },
  };
  if (typeof src.n_theta === 'number') p.zenithPoints = src.n_theta;
  if (typeof src.n_phi === 'number') p.azimuthPoints = src.n_phi;
  if (typeof src.theta_min === 'number') p.zenithMinDeg = src.theta_min;
  if (typeof src.theta_max === 'number') p.zenithMaxDeg = src.theta_max;
  if (typeof src.phi_min === 'number') p.azimuthMinDeg = src.phi_min;
  if (typeof src.phi_max === 'number') p.azimuthMaxDeg = src.phi_max;
  if (typeof src.tilt_roll_deg === 'number') p.tiltRollDeg = src.tilt_roll_deg;
  if (typeof src.tilt_pitch_deg === 'number') p.tiltPitchDeg = src.tilt_pitch_deg;
  if (typeof src.azimuth_offset_deg === 'number') p.azimuthOffsetDeg = src.azimuth_offset_deg;
  // A moving-platform file (reconstructed trajectory) → attach the PoseStream and
  // zero the static tilt/heading, exactly as the trajectory-file importer does (a
  // moving scan's attitude comes from the trajectory; the backend rejects a static
  // tilt on a moving scan). poseStreamFromWire throws on a malformed payload, so a
  // bad trajectory simply leaves the scan static rather than failing the import.
  if (src.trajectory != null) {
    try {
      p.trajectory = poseStreamFromWire(src.trajectory);
      p.tiltRollDeg = 0;
      p.tiltPitchDeg = 0;
      p.azimuthOffsetDeg = 0;
    } catch {
      // Leave the scan static if the reconstructed trajectory can't be mapped.
    }
  }
  return p;
}
