/**
 * The scan-origin FRAME contract.
 *
 * Session points are stored world - worldShift. But `params.origin` and
 * `octree.scanOrigin` are WORLD-frame: both are recovered from the source
 * file's own header, and App.tsx subtracts worldShift from a wizard-chosen
 * TRAJECTORY while deliberately leaving `baseParams` (which carries origin)
 * alone. So every request that pairs an origin with STORED points must shift
 * the origin itself.
 *
 * `buildLADRequest` has always done this. `buildScanExportEntry` did not, and
 * the mismatch was invisible in tests because the PTX fixtures put the scanner
 * at (0,0,0) -- where the stored origin and the world origin are the same three
 * zeros. On a georeferenced cloud it made PTX `local = xyz - origin` wrong by
 * the whole shift (local radii in thousands of km rather than metres) and
 * double-shifted the absolute header pose, because the writer re-adds
 * worldShift to an origin it assumes is stored-frame.
 *
 * `buildHeliosTriangulationRequest` is the deliberate EXCEPTION and is pinned
 * here as one: it feeds the backend's world-frame reader and shifts its GRID
 * into world to match, so a raw world-frame origin is correct there.
 *
 * Source-level because PointCloudViewer.tsx is E2E-covered rather than
 * unit-mounted; the numeric behaviour is asserted in
 * backend-api/tests/test_ptx_export.py.
 */
import { describe, it, expect } from 'vitest';
import { readFile } from 'fs/promises';
import { join } from 'path';

const VIEWER = join(process.cwd(), 'src/renderer/components/PointCloudViewer.tsx');
const HELPERS = join(process.cwd(), 'src/renderer/lib/pointCloudHelpers.ts');

async function source(p: string): Promise<string> {
  // Renderer sources here have carried NUL bytes; strip so the matches behave.
  return (await readFile(p, 'utf8')).replace(/\0/g, '');
}

/** The body of `name`'s useCallback/function block, from its declaration to `end`. */
function block(src: string, start: string, end: string): string {
  const i = src.indexOf(start);
  expect(i, `anchor not found: ${start}`).toBeGreaterThan(-1);
  const j = src.indexOf(end, i);
  expect(j, `end anchor not found after ${start}: ${end}`).toBeGreaterThan(-1);
  return src.slice(i, j);
}

describe('an origin sent with STORED points is shifted into the stored frame', () => {
  it('buildScanExportEntry shifts both of its origin sources', async () => {
    const src = await source(VIEWER);
    const b = block(src,
      'const buildScanExportEntry = useCallback',
      'return attachScanExportSource(entry, cloud);\n  }, [clouds, scans, attachScanExportSource]);');

    // It must read the cloud's shift and define the conversion.
    expect(b).toMatch(/const ws = cloud\.data\.octree\?\.worldShift \?\? \[0, 0, 0\]/);
    expect(b).toMatch(/o\[0\] - ws\[0\], o\[1\] - ws\[1\], o\[2\] - ws\[2\]/);

    // BOTH branches -- the params-less scanOrigin fallback and the full
    // ScanParameters entry -- must go through it. A raw spread or a raw
    // params.origin triple is the bug this file exists to catch.
    expect(b).toContain('origin: scanOrigin ? toStored(scanOrigin) : [0, 0, 0]');
    expect(b).toContain('origin: toStored([params.origin.x, params.origin.y, params.origin.z])');
    expect(b).not.toContain('origin: scanOrigin ? [...scanOrigin]');
    expect(b).not.toContain('origin: [params.origin.x, params.origin.y, params.origin.z]');
  });

  it('buildLADRequest still shifts its origin (the reference pattern)', async () => {
    const src = await source(HELPERS);
    const b = block(src, 'export function buildLADRequest', '\nexport ');
    expect(b).toContain('origin: [p.origin.x - ws[0], p.origin.y - ws[1], p.origin.z - ws[2]]');
  });

  it('Helios triangulation stays WORLD-frame on purpose', async () => {
    // Not an oversight: this request feeds the backend's world-frame reader and
    // shifts the grid INTO world, so the origin must stay unshifted. Pinned so a
    // future "consistency" pass does not subtract the shift here too.
    const src = await source(HELPERS);
    const b = block(src, 'export function buildHeliosTriangulationRequest', '\nexport ');
    expect(b).toContain('origin: [p.origin.x, p.origin.y, p.origin.z]');
    expect(b).toMatch(/center: \[g\.center\[0\] \+ ws\[0\]/);
  });
});
