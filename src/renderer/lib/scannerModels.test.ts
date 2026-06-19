import { describe, it, expect } from 'vitest';
import {
  SCANNER_MODELS,
  getScannerModel,
  DEFAULT_SCANNER_MODEL,
  type ScannerModelId,
} from './scannerModels';

describe('scannerModels catalog', () => {
  it('exposes generic plus the seven bundled instruments', () => {
    const ids = SCANNER_MODELS.map(m => m.id);
    expect(ids).toEqual([
      'generic',
      'riegl_vz400i',
      'leica_p40',
      'leica_blk360',
      'leica_blk360_g2',
      'faro_focus_s350',
      'velodyne_hdl32e',
      'riegl_minivux3uav',
    ]);
  });

  it('every model has a mesh, a positive real-world height, and matching format', () => {
    for (const m of SCANNER_MODELS) {
      expect(m.meshUrl).toBeTruthy();
      expect(m.heightMeters).toBeGreaterThan(0);
      expect(['ply', 'obj']).toContain(m.meshFormat);
    }
  });

  it('generic is the default and renders the sphere with an empty preset', () => {
    expect(DEFAULT_SCANNER_MODEL).toBe('generic');
    const generic = getScannerModel('generic');
    expect(generic.meshFormat).toBe('ply');
    expect(generic.preset).toEqual({});
  });

  it('falls back to generic for unknown or undefined ids', () => {
    expect(getScannerModel(undefined).id).toBe('generic');
    expect(getScannerModel('nope' as ScannerModelId).id).toBe('generic');
  });

  it('instruments use OBJ meshes', () => {
    for (const m of SCANNER_MODELS.filter(m => m.id !== 'generic')) {
      expect(m.meshFormat).toBe('obj');
    }
  });

  it('carries datasheet beam optics and vertical sweep for the terrestrial scanners', () => {
    // RIEGL: vertical (line) scan total 100° (+60°/−40°) → zenith 30–130°.
    // The datasheet quotes only divergence, so no exit aperture is preset.
    const riegl = getScannerModel('riegl_vz400i').preset;
    expect(riegl.beamDivergenceMrad).toBeCloseTo(0.35);
    expect(riegl.pattern).toBe('raster');
    // Full-waveform multi-return, up to ~15 targets/pulse (datasheet).
    expect(riegl.returnMode).toBe('multi');
    expect(riegl.maxReturns).toBe(15);
    expect(riegl.zenithMinDeg).toBe(30);
    expect(riegl.zenithMaxDeg).toBe(130);
    expect(riegl.beamExitDiameterM).toBeUndefined();

    // Leica P40: 290° vertical FOV → mirror reaches zenith 0–145° (a ~70° blind
    // cone under the tripod), NOT the full 0–180°.
    const leica = getScannerModel('leica_p40').preset;
    expect(leica.beamDivergenceMrad).toBeCloseTo(0.23);
    expect(leica.beamExitDiameterM).toBeCloseTo(0.0035);
    expect(leica.returnMode).toBe('single');
    expect(leica.zenithMinDeg).toBe(0);
    expect(leica.zenithMaxDeg).toBe(145);

    // Leica BLK360 (G1): 0.4 mrad FWHM divergence, ⌀ 2.25 mm at front window;
    // 300° vertical FOV → mirror reaches zenith 0–150°; single-return, 360 kHz.
    const blk = getScannerModel('leica_blk360').preset;
    expect(blk.beamDivergenceMrad).toBeCloseTo(0.4);
    expect(blk.beamExitDiameterM).toBeCloseTo(0.00225);
    expect(blk.returnMode).toBe('single');
    expect(blk.zenithMinDeg).toBe(0);
    expect(blk.zenithMaxDeg).toBe(150);
    expect(blk.pulseRateHz).toBe(360000);

    // Leica BLK360 (G2): same laser front-end as the G1 (identical beam optics +
    // single return), but the detector redesign ~doubles the point rate to
    // 680 kHz AND the vertical FOV narrows to 270° → zenith 0–135° (vs the G1's
    // 300° → 0–150°). Those two are the preset values distinguishing it.
    const blk2 = getScannerModel('leica_blk360_g2').preset;
    expect(blk2.beamDivergenceMrad).toBeCloseTo(0.4);
    expect(blk2.beamExitDiameterM).toBeCloseTo(0.00225);
    expect(blk2.returnMode).toBe('single');
    expect(blk2.zenithMinDeg).toBe(0);
    expect(blk2.zenithMaxDeg).toBe(135);
    expect(blk2.pulseRateHz).toBe(680000);

    // FARO S350: 300° vertical FOV given as 2×150° → zenith 0–150°.
    const faro = getScannerModel('faro_focus_s350').preset;
    expect(faro.beamDivergenceMrad).toBeCloseTo(0.3);
    expect(faro.beamExitDiameterM).toBeCloseTo(0.00212);
    expect(faro.zenithMinDeg).toBe(0);
    expect(faro.zenithMaxDeg).toBe(150);
  });

  it('models the Velodyne HDL-32E as a 32-channel spinning multibeam', () => {
    const v = getScannerModel('velodyne_hdl32e').preset;
    expect(v.pattern).toBe('spinning_multibeam');
    // Datasheet offers single OR strongest+last dual return — no full-waveform
    // multi-return — and Helios has no dual mode, so single is the faithful default.
    expect(v.returnMode).toBe('single');
    expect(v.beamElevationAnglesDeg).toHaveLength(32);
    // Rectangular emitter ~1/2″ wide at the source → 12.7 mm on the wide axis.
    expect(v.beamExitDiameterM).toBeCloseTo(0.0127);
    // Channels span +10.67° (top) to −30.67° (bottom), monotonically decreasing.
    const angles = v.beamElevationAnglesDeg!;
    expect(angles[0]).toBeCloseTo(10.67, 1);
    expect(angles[31]).toBeCloseTo(-30.67, 1);
    for (let i = 1; i < angles.length; i++) {
      expect(angles[i]).toBeLessThan(angles[i - 1]);
    }
    expect(v.azimuthMinDeg).toBe(0);
    expect(v.azimuthMaxDeg).toBe(360);
  });

  it('models the RIEGL miniVUX-3UAV as a single-channel spinning multibeam', () => {
    const m = getScannerModel('riegl_minivux3uav').preset;
    // One laser through a rotating mirror = the one-channel multibeam case:
    // a single 0°-elevation beam whose azimuth sweep is the mirror rotation.
    expect(m.pattern).toBe('spinning_multibeam');
    expect(m.beamElevationAnglesDeg).toEqual([0]);
    // Waveform LiDAR, up to 5 echoes/pulse → full-waveform multi-return.
    expect(m.returnMode).toBe('multi');
    expect(m.maxReturns).toBe(5);
    // 1.6 × 0.5 mrad divergence → scalar field takes the wide axis, as the
    // HDL-32E does. Datasheet quotes a footprint, not an exit aperture, so —
    // like the VZ-400i — no beam diameter is preset.
    expect(m.beamDivergenceMrad).toBeCloseTo(1.6);
    expect(m.beamExitDiameterM).toBeUndefined();
    // 100 kHz PRR mode → full 360° azimuth FOV.
    expect(m.azimuthMinDeg).toBe(0);
    expect(m.azimuthMaxDeg).toBe(360);
    expect(m.pulseRateHz).toBe(100000);
    // Δφ 0.018°–0.36° selectable → 1,000–20,000 pts/rev; preset the ~0.1° mid.
    expect(m.azimuthPoints).toBe(3600);
  });

  it('presets a datasheet-faithful azimuth resolution for both spinning sensors', () => {
    // Spinning sensors pin a per-revolution angular step, so unlike the
    // terrestrial rasters they preset points/revolution (still editable).
    const velo = getScannerModel('velodyne_hdl32e').preset;
    expect(velo.azimuthPoints).toBe(1800); // 10 Hz ≈ 0.2° setting (0.1°–0.4° range)
    const minivux = getScannerModel('riegl_minivux3uav').preset;
    expect(minivux.azimuthPoints).toBe(3600); // ~0.1° step
    // The terrestrial rasters leave resolution to the user — no azimuthPoints.
    expect(getScannerModel('riegl_vz400i').preset.azimuthPoints).toBeUndefined();
    expect(getScannerModel('leica_p40').preset.azimuthPoints).toBeUndefined();
  });
});
