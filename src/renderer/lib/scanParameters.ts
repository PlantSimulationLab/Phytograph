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
  // Angular sweep, in degrees, centered around the scanner's local axis.
  zenithRangeDeg: number;
  azimuthRangeDeg: number;
  returnType: ReturnType;
  // Multi-return only. Beam exit diameter in meters and divergence in
  // milliradians (the units pyhelios uses).
  beamExitDiameterM: number;
  beamDivergenceMrad: number;
}

export const DEFAULT_SCAN_PARAMETERS: ScanParameters = {
  origin: { x: 0, y: 0, z: 0 },
  zenithPoints: 100,
  azimuthPoints: 360,
  zenithRangeDeg: 180,
  azimuthRangeDeg: 360,
  returnType: 'single',
  beamExitDiameterM: 0.01,
  beamDivergenceMrad: 0.5,
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
