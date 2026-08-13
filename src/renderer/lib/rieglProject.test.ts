import { describe, expect, it } from 'vitest';
import { isRieglProjectPath } from './rieglProject';

describe('isRieglProjectPath', () => {
  it('matches a project directory, with or without a trailing slash', () => {
    expect(isRieglProjectPath('/data/2018-02-23.002.riproject')).toBe(true);
    expect(isRieglProjectPath('/data/2018-02-23.002.riproject/')).toBe(true);
    expect(isRieglProjectPath('/data/SCAN.RIPROJECT')).toBe(true);
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
  });

  it('is safe on empty input', () => {
    expect(isRieglProjectPath(undefined)).toBe(false);
    expect(isRieglProjectPath(null)).toBe(false);
    expect(isRieglProjectPath('')).toBe(false);
  });
});
