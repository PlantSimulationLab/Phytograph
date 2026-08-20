import { describe, expect, it } from 'vitest';
import { isRieglProjectPath, parseRieglProgress } from './rieglProject';

describe('isRieglProjectPath', () => {
  it('matches a project directory, with or without a trailing slash', () => {
    expect(isRieglProjectPath('/data/2018-02-23.002.riproject')).toBe(true);
    expect(isRieglProjectPath('/data/2018-02-23.002.riproject/')).toBe(true);
    expect(isRieglProjectPath('/data/SCAN.RIPROJECT')).toBe(true);
  });

  it('matches a .PROJ from a newer instrument', () => {
    // Newer instruments (VZ-2000i and friends) write .PROJ, conventionally
    // upper-case on disk.
    expect(isRieglProjectPath('/data/2024-07-18.PROJ')).toBe(true);
    expect(isRieglProjectPath('/data/2024-07-18.PROJ/')).toBe(true);
    expect(isRieglProjectPath('/data/2024-07-18.proj')).toBe(true);
  });

  it('does NOT match files inside a .PROJ', () => {
    // A .PROJ nests its scans TWO levels deep, so there is more inside it to be
    // mistaken for the project than there was in a .riproject.
    expect(
      isRieglProjectPath('/p.PROJ/ScanPos001.SCNPOS/scans/240718_102357.rxp'),
    ).toBe(false);
    expect(
      isRieglProjectPath('/p.PROJ/ScanPos001.SCNPOS/scans/240718_102357.rdbx'),
    ).toBe(false);
    expect(isRieglProjectPath('/p.PROJ/ScanPos001.SCNPOS')).toBe(false);
    expect(isRieglProjectPath('/p.PROJ/project.json')).toBe(false);
    expect(isRieglProjectPath('/p.PROJ/Voxels1.VPP/VPP.vop')).toBe(false);
  });

  it('does NOT match files inside the project', () => {
    // THE REPORTED BUG: dropping the folder expanded it into ~100 files, each
    // rejected by the generic importer ("Unsupported file format: .ppm").
    // Anchoring to the end of the path is what keeps the project distinct from
    // its contents.
    expect(isRieglProjectPath('/p.riproject/ScanPos001/180223_145028.rxp')).toBe(false);
    expect(isRieglProjectPath('/p.riproject/ScanPos001/180223_145028.pat')).toBe(false);
    expect(isRieglProjectPath('/p.riproject/ScanPos001/img.thumb.ppm')).toBe(false);
    expect(isRieglProjectPath('/p.riproject/poslog_0.rxp')).toBe(false);
  });

  it('does not match unrelated point clouds', () => {
    expect(isRieglProjectPath('/data/cloud.las')).toBe(false);
    expect(isRieglProjectPath('/data/riproject.las')).toBe(false);
    expect(isRieglProjectPath('/data/proj.las')).toBe(false);
    // ".proj" is a common enough word that a substring match would be a real
    // hazard; only a genuine suffix counts.
    expect(isRieglProjectPath('/data/myproject')).toBe(false);
    expect(isRieglProjectPath('/data/cloud.projected.las')).toBe(false);
  });

  it('is safe on empty input', () => {
    expect(isRieglProjectPath(undefined)).toBe(false);
    expect(isRieglProjectPath(null)).toBe(false);
    expect(isRieglProjectPath('')).toBe(false);
  });
});

describe('parseRieglProgress', () => {
  it('advances the counter from the [N/M] prefix', () => {
    // THE BUG: the backend builds every position itself, so the renderer had no
    // view of progress. It set current:1 once and never moved it — the dialog
    // read "1 of 6" for an entire six-position import and finished around 20%.
    expect(parseRieglProgress('[1/6] Building ScanPos001 (20,601,737 points)…'))
      .toEqual({ current: 1, total: 6, label: 'Building ScanPos001 (20,601,737 points)…' });
    expect(parseRieglProgress('[4/6] Finished ScanPos004'))
      .toEqual({ current: 4, total: 6, label: 'Finished ScanPos004' });
  });

  it('returns null for messages with no prefix', () => {
    // The metadata phase precedes any position work; it must not reset the
    // counter to something misleading.
    expect(parseRieglProgress('Reading project metadata (6 positions)…')).toBeNull();
    expect(parseRieglProgress('Extraction complete.')).toBeNull();
    expect(parseRieglProgress('')).toBeNull();
  });
});
