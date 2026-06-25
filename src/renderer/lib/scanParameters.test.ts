import { describe, it, expect } from 'vitest';
import {
  DEFAULT_SCAN_PARAMETERS,
  applyTrajectoryToParams,
  makeDefaultScanParameters,
  migrateScanReturnFields,
  scanParametersFromFile,
  type ScanParamsFromFile,
} from './scanParameters';
import type { PoseStream } from './poseStream';

// A minimal two-pose PoseStream for the trajectory-attach tests: the platform
// moves from x=-1 to x=1 at z=5, identity attitude.
function makeTrajectory(): PoseStream {
  return {
    poses: [
      { t: 0, x: -1, y: 0, z: 5, qx: 0, qy: 0, qz: 0, qw: 1 },
      { t: 2, x: 1, y: 0, z: 5, qx: 0, qy: 0, qz: 0, qw: 1 },
    ],
    frame: { crs: null, upAxis: 'z', bodyConvention: 'FLU', timeRef: 'gps' },
    leverArm: [0, 0, 0],
    boresightRpy: [0, 0, 0],
    sourceFormat: 'pose_csv',
    label: 'pass.csv',
  };
}

// scanParametersFromFile turns the partial scan-pattern metadata a point-cloud
// FILE carried (E57 pose + angular sweep + grid; PCD VIEWPOINT origin) into a
// full ScanParameters, filling any field the file omitted from the defaults.
// This is the non-XML import equivalent of parsing a Helios <scan>: whatever the
// format records is populated, the rest stays at its sensible default.

describe('scanParametersFromFile', () => {
  it('populates every field when the file carried a full E57 scan record', () => {
    const src: ScanParamsFromFile = {
      origin: [1, 2, 3],
      n_theta: 100,
      n_phi: 360,
      theta_min: 0,
      theta_max: 180,
      phi_min: 0,
      phi_max: 360,
    };
    const p = scanParametersFromFile(src);
    expect(p.origin).toEqual({ x: 1, y: 2, z: 3 });
    expect(p.zenithPoints).toBe(100);
    expect(p.azimuthPoints).toBe(360);
    expect(p.zenithMinDeg).toBe(0);
    expect(p.zenithMaxDeg).toBe(180);
    expect(p.azimuthMinDeg).toBe(0);
    expect(p.azimuthMaxDeg).toBe(360);
  });

  it('fills omitted fields from the defaults (PCD: origin only)', () => {
    // A PCD VIEWPOINT carries only the origin; the angular sweep and grid stay
    // at the defaults — "not in the file" continues to mean "left blank".
    const p = scanParametersFromFile({ origin: [5, 6, 7] });
    expect(p.origin).toEqual({ x: 5, y: 6, z: 7 });
    expect(p.zenithPoints).toBe(DEFAULT_SCAN_PARAMETERS.zenithPoints);
    expect(p.azimuthPoints).toBe(DEFAULT_SCAN_PARAMETERS.azimuthPoints);
    expect(p.zenithMinDeg).toBe(DEFAULT_SCAN_PARAMETERS.zenithMinDeg);
    expect(p.zenithMaxDeg).toBe(DEFAULT_SCAN_PARAMETERS.zenithMaxDeg);
    expect(p.azimuthMinDeg).toBe(DEFAULT_SCAN_PARAMETERS.azimuthMinDeg);
    expect(p.azimuthMaxDeg).toBe(DEFAULT_SCAN_PARAMETERS.azimuthMaxDeg);
    // Return mode + beam fields are never recovered from a file header.
    expect(p.returnMode).toBe('single');
    expect(p.beamExitDiameterM).toBe(DEFAULT_SCAN_PARAMETERS.beamExitDiameterM);
  });

  it('honors a partial angular sweep without grid counts', () => {
    // E57 with sphericalBounds but no indexBounds: angles populated, counts not.
    const p = scanParametersFromFile({
      origin: [0, 0, 0],
      theta_min: 30,
      theta_max: 60,
      phi_min: 90,
      phi_max: 180,
    });
    expect(p.zenithMinDeg).toBe(30);
    expect(p.zenithMaxDeg).toBe(60);
    expect(p.azimuthMinDeg).toBe(90);
    expect(p.azimuthMaxDeg).toBe(180);
    expect(p.zenithPoints).toBe(DEFAULT_SCAN_PARAMETERS.zenithPoints);
    expect(p.azimuthPoints).toBe(DEFAULT_SCAN_PARAMETERS.azimuthPoints);
  });

  it('does not mutate DEFAULT_SCAN_PARAMETERS', () => {
    const before = JSON.stringify(DEFAULT_SCAN_PARAMETERS);
    const p = scanParametersFromFile({ origin: [9, 9, 9], n_theta: 7 });
    p.origin.x = 999;
    p.zenithPoints = 1;
    expect(JSON.stringify(DEFAULT_SCAN_PARAMETERS)).toBe(before);
  });

  it('defaults to the raster pattern with a non-empty elevation list', () => {
    // pattern defaults to 'raster' so existing scans/imports are unchanged; the
    // elevation list is only consulted for multibeam but must be a sane default.
    expect(DEFAULT_SCAN_PARAMETERS.pattern).toBe('raster');
    expect(DEFAULT_SCAN_PARAMETERS.beamElevationAnglesDeg.length).toBeGreaterThan(0);
    // File-header imports never describe a multibeam sensor → always raster.
    expect(scanParametersFromFile({ origin: [0, 0, 0] }).pattern).toBe('raster');
  });

  it('defaults tilt to level (0/0) and honors a file-carried tilt', () => {
    // Tilt is a scan property: absent → level; present → carried through.
    expect(DEFAULT_SCAN_PARAMETERS.tiltRollDeg).toBe(0);
    expect(DEFAULT_SCAN_PARAMETERS.tiltPitchDeg).toBe(0);

    const level = scanParametersFromFile({ origin: [0, 0, 0] });
    expect(level.tiltRollDeg).toBe(0);
    expect(level.tiltPitchDeg).toBe(0);

    const tilted = scanParametersFromFile({ origin: [0, 0, 0], tilt_roll_deg: 5, tilt_pitch_deg: -3 });
    expect(tilted.tiltRollDeg).toBe(5);
    expect(tilted.tiltPitchDeg).toBe(-3);
  });

  it('attaches a reconstructed trajectory and zeroes static tilt', () => {
    // A LAS with per-pulse beam-origin ExtraBytes surfaces a reconstructed
    // trajectory wire dict; the imported scan becomes moving with its tilt zeroed.
    const p = scanParametersFromFile({
      origin: [0, 0, 10],
      tilt_roll_deg: 5,  // would normally carry through — but a moving scan zeroes it
      trajectory: {
        poses: [
          { t: 0, x: 0, y: 0, z: 10, qx: 0, qy: 0, qz: 0, qw: 1 },
          { t: 1, x: 2, y: 0, z: 10, qx: 0, qy: 0, qz: 0, qw: 1 },
        ],
        frame: { crs: null, up_axis: 'z', body_convention: 'FLU', time_ref: 'gps' },
        lever_arm: [0, 0, 0],
        boresight_rpy: [0, 0, 0],
        source_format: 'las_extrabytes',
      },
    });
    expect(p.trajectory).toBeDefined();
    expect(p.trajectory!.poses).toHaveLength(2);
    expect(p.trajectory!.sourceFormat).toBe('las_extrabytes');
    expect(p.tiltRollDeg).toBe(0);  // zeroed for a moving scan
    expect(p.tiltPitchDeg).toBe(0);
    expect(p.azimuthOffsetDeg).toBe(0);
  });

  it('stays static if the reconstructed trajectory is malformed', () => {
    const p = scanParametersFromFile({ origin: [1, 2, 3], trajectory: { poses: [] } });
    expect(p.trajectory).toBeUndefined();
    expect(p.origin).toEqual({ x: 1, y: 2, z: 3 });
  });

  it('defaults heading (azimuth offset) to 0 and honors a file-carried value', () => {
    // Initial scanner heading is a scan property: absent → 0; present → carried.
    expect(DEFAULT_SCAN_PARAMETERS.azimuthOffsetDeg).toBe(0);

    const noHeading = scanParametersFromFile({ origin: [0, 0, 0] });
    expect(noHeading.azimuthOffsetDeg).toBe(0);

    const headed = scanParametersFromFile({ origin: [0, 0, 0], azimuth_offset_deg: 45 });
    expect(headed.azimuthOffsetDeg).toBe(45);
  });
});

// applyTrajectoryToParams attaches an imported platform trajectory to a scan,
// marking it a moving-platform acquisition. Used by the Scan Parameters popup and
// the import wizard's trajectory upload.
describe('applyTrajectoryToParams', () => {
  it('attaches the trajectory, anchors origin to the first pose, and zeros tilt/heading', () => {
    const base = makeDefaultScanParameters();
    base.tiltRollDeg = 5;
    base.tiltPitchDeg = -3;
    base.azimuthOffsetDeg = 45;
    const p = applyTrajectoryToParams(base, makeTrajectory());
    expect(p.trajectory?.poses).toHaveLength(2);
    expect(p.origin).toEqual({ x: -1, y: 0, z: 5 }); // first pose
    expect(p.tiltRollDeg).toBe(0);
    expect(p.tiltPitchDeg).toBe(0);
    expect(p.azimuthOffsetDeg).toBe(0);
  });

  it('synthesizes default params when the scan had none (plain XYZ/LAS import)', () => {
    const p = applyTrajectoryToParams(undefined, makeTrajectory());
    expect(p.trajectory).toBeDefined();
    expect(p.origin).toEqual({ x: -1, y: 0, z: 5 });
    // Untouched fields come from the defaults.
    expect(p.zenithPoints).toBe(DEFAULT_SCAN_PARAMETERS.zenithPoints);
    expect(p.returnMode).toBe(DEFAULT_SCAN_PARAMETERS.returnMode);
  });

  it('preserves the rest of the existing params', () => {
    const base = makeDefaultScanParameters();
    base.pattern = 'spinning_multibeam';
    base.azimuthPoints = 720;
    const p = applyTrajectoryToParams(base, makeTrajectory());
    expect(p.pattern).toBe('spinning_multibeam');
    expect(p.azimuthPoints).toBe(720);
  });

  it('does not mutate the input params', () => {
    const base = makeDefaultScanParameters();
    const before = JSON.stringify(base);
    applyTrajectoryToParams(base, makeTrajectory());
    expect(JSON.stringify(base)).toBe(before);
  });
});

// migrateScanReturnFields maps a persisted (possibly older-shape) scan-params blob
// onto the current { returnMode, maxReturns, returnSelection } fields. Older scans
// carried `returnType: 'single' | 'multi'` and none of the new fields.
describe('migrateScanReturnFields', () => {
  it('maps legacy returnType "multi" to the multi mode', () => {
    const m = migrateScanReturnFields({ returnType: 'multi' });
    expect(m.returnMode).toBe('multi');
  });

  it('maps legacy returnType "single" to the single mode', () => {
    const m = migrateScanReturnFields({ returnType: 'single' });
    expect(m.returnMode).toBe('single');
  });

  it('honors a present returnMode over a legacy returnType', () => {
    const m = migrateScanReturnFields({ returnMode: 'single', returnType: 'multi' });
    expect(m.returnMode).toBe('single');
  });

  it('passes through each current mode', () => {
    expect(migrateScanReturnFields({ returnMode: 'single' }).returnMode).toBe('single');
    expect(migrateScanReturnFields({ returnMode: 'multi' }).returnMode).toBe('multi');
  });

  it('falls back to the default mode when neither field is present or valid', () => {
    expect(migrateScanReturnFields({}).returnMode).toBe(DEFAULT_SCAN_PARAMETERS.returnMode);
    expect(migrateScanReturnFields({ returnMode: 'bogus' }).returnMode)
      .toBe(DEFAULT_SCAN_PARAMETERS.returnMode);
  });

  it('clamps maxReturns to an integer >= 1 and defaults otherwise', () => {
    expect(migrateScanReturnFields({ maxReturns: 7 }).maxReturns).toBe(7);
    expect(migrateScanReturnFields({ maxReturns: 3.9 }).maxReturns).toBe(4);
    expect(migrateScanReturnFields({ maxReturns: 0 }).maxReturns)
      .toBe(DEFAULT_SCAN_PARAMETERS.maxReturns);
    expect(migrateScanReturnFields({}).maxReturns)
      .toBe(DEFAULT_SCAN_PARAMETERS.maxReturns);
  });

  it('accepts a valid returnSelection and defaults an invalid one', () => {
    expect(migrateScanReturnFields({ returnSelection: 'last' }).returnSelection).toBe('last');
    expect(migrateScanReturnFields({ returnSelection: 'bogus' }).returnSelection)
      .toBe(DEFAULT_SCAN_PARAMETERS.returnSelection);
  });
});
