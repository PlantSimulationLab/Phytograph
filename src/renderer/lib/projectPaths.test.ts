import { describe, it, expect } from 'vitest';
import { splitProjectPaths } from './projectPaths';

describe('splitProjectPaths', () => {
  it('passes plain imports through', () => {
    expect(splitProjectPaths(['/a/x.las', '/a/y.obj'])).toEqual(
      { project: null, imports: ['/a/x.las', '/a/y.obj'], skipped: [] });
  });

  it('opens a project instead of importing it', () => {
    expect(splitProjectPaths(['/a/plot.PHYTO'])).toEqual({ project: '/a/plot.PHYTO', imports: [], skipped: [] });
  });

  it('opens the first project and sets everything else aside', () => {
    expect(splitProjectPaths(['/a/x.las', '/a/one.phyto', '/a/two.phyto'])).toEqual({
      project: '/a/one.phyto', imports: [], skipped: ['/a/x.las', '/a/two.phyto'],
    });
  });
});
