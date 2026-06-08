import { describe, it, expect } from 'vitest';
import {
  DEFAULT_SCAN_PARAMETERS,
  scanParametersFromFile,
  type ScanParamsFromFile,
} from './scanParameters';

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
    // Multi-return-only fields are never recovered from a file header.
    expect(p.returnType).toBe('single');
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
});
