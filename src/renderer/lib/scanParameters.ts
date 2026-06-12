// Parameters describing the physical scanner that produced (or will produce)
// a point cloud: where it sat, how widely it swept, and what kind of returns
// it captured. These eventually drive a pyhelios scan definition. Today they
// also place a ScannerMarker in the viewer scene.
//
// A Scan (see ./scan) may carry these parameters or not — some pre-merged
// clouds have no single defined origin. Analyses that need pulse directions
// (e.g. Helios triangulation) are gated on presence of params.

export type ReturnType = 'single' | 'multi';

export interface ScanParameters {
  origin: { x: number; y: number; z: number };
  // Number of sample rays in each angular direction.
  zenithPoints: number;
  azimuthPoints: number;
  // Angular sweep boundaries, in degrees. Min/max positions define the sweep
  // explicitly (the range is max - min), allowing asymmetric sweeps. These map
  // to Helios theta_min/theta_max (zenith) and phi_min/phi_max (azimuth).
  zenithMinDeg: number;
  zenithMaxDeg: number;
  azimuthMinDeg: number;
  azimuthMaxDeg: number;
  returnType: ReturnType;
  // Multi-return only. Beam exit diameter in meters and divergence in
  // milliradians (the units pyhelios uses).
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
}

export const DEFAULT_SCAN_PARAMETERS: ScanParameters = {
  origin: { x: 0, y: 0, z: 0 },
  zenithPoints: 100,
  azimuthPoints: 360,
  zenithMinDeg: 0,
  zenithMaxDeg: 180,
  azimuthMinDeg: 0,
  azimuthMaxDeg: 360,
  returnType: 'single',
  beamExitDiameterM: 0.01,
  beamDivergenceMrad: 0.5,
  tiltRollDeg: 0,
  tiltPitchDeg: 0,
};

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
}

// Build ScanParameters from the partial set a file header carried, filling any
// field the file omitted from DEFAULT_SCAN_PARAMETERS. This is the non-XML
// import equivalent of parsing a Helios <scan>: whatever the format records
// (always origin, plus angular sweep + grid for E57) is populated, and the rest
// stays at the sensible default — so "not in the file" continues to mean
// "left blank" exactly as it does today.
export function scanParametersFromFile(src: ScanParamsFromFile): ScanParameters {
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
  return p;
}
