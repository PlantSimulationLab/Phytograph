// Miss exclusion is a CHOKEPOINT, not a per-tool responsibility.
//
// Sky/miss points are rays that hit nothing, projected ~1 km out along the beam.
// Feeding them to any gridding / KD-tree / CSF / triangulation tool inflates the
// extent ~1000x, which makes the algorithm HANG rather than error. The `source`
// branch is filtered server-side by `_read_points_from_source(include_misses=
// False)`; the INLINE branch has no such guard -- the backend passes an inline
// `points` array through verbatim, so the renderer is the only defense.
//
// Leaving each call site to filter `data.positions` itself made this something
// every new tool had to REMEMBER, and it was repeatedly forgotten: an audit
// found eight tools shipping raw positions, six of them the unfiltered twin of a
// correctly-filtered sibling in the same file (ground seg vs tree seg, QSM vs
// skeleton, c2m vs c2c ICP, wood-aggregate vs wood-per-scan).
//
// So `buildPointSource` filters ONCE and hands every consumer `hits`. These
// tests pin that arrangement at the source level: the guarantee lives in a
// 30k-line React component that cannot be mounted in a unit test, and each of
// these properties is a one-line revert away from silently regressing.
import { describe, expect, it } from 'vitest';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

const VIEWER = join(process.cwd(), 'src/renderer/components/PointCloudViewer.tsx');
const TYPES = join(process.cwd(), 'src/renderer/lib/pointCloudTypes.ts');

async function viewerSource(): Promise<string> {
  // NOTE: App.tsx-adjacent renderer sources have carried NUL bytes; read as
  // utf8 and strip them so the regexes below behave.
  return (await readFile(VIEWER, 'utf8')).replace(/\0/g, '');
}

describe('buildPointSource is the miss-exclusion chokepoint', () => {
  it('filters misses in the inline branch', async () => {
    const src = await viewerSource();
    const start = src.indexOf('const buildPointSource = useCallback');
    expect(start).toBeGreaterThan(-1);
    const block = src.slice(start, src.indexOf('}, [getEditState, getDisplayData]);', start));

    // The inline return must carry pre-filtered hits, not just raw data.
    expect(block).toMatch(/kind:\s*'inline',\s*hits:\s*collectHitPoints\(data\)/);
  });

  it('the payload TYPE forces the inline branch to carry hits', async () => {
    // Belt and braces: if `hits` were optional, a new call site could omit it
    // and reintroduce the bug without a compile error.
    const types = await readFile(TYPES, 'utf8');
    const start = types.indexOf('export type PointSourcePayload');
    const block = types.slice(start, types.indexOf(';', types.indexOf('session_id', start)));
    expect(block).toContain("kind: 'inline'");
    expect(block).toMatch(/hits:\s*HitPoints;/);   // required, not `hits?:`
  });
});

describe('no compute path serializes raw positions', () => {
  it('cloud-to-mesh distance and mesh ICP send hit points', async () => {
    const src = await viewerSource();
    // These two were the P0: misses inflated the robust diagonal 2,192x
    // (29 m -> 64 km), so the 5% correspondence distance became 3,210 m instead
    // of 1.47 m and the ICP centroid sat 5 km off in Z -- confident wrong
    // answers rather than a hang.
    expect(src).not.toContain('points: Array.from(ps.data.positions)');
    const hitSends = src.match(/points:\s*ps\.hits\.points\.flat\(\)/g) ?? [];
    expect(hitSends.length).toBe(2);
  });

  it('QSM decimates HITS, not the raw array', async () => {
    const src = await viewerSource();
    // The compounding defect: striding the raw array spent the budget on the
    // miss shell -- on a 61%-miss scan a 60k budget kept ~37k misses and
    // decimated the actual tree to ~23k.
    expect(src).toMatch(/collectHitPointsCapped\(ps\.data,\s*MAX_QSM_POINTS\)/);
  });

  it('triangulation decimates HITS', async () => {
    const src = await viewerSource();
    const start = src.indexOf('const flatPointsCapped = useCallback');
    expect(start).toBeGreaterThan(-1);
    const block = src.slice(start, src.indexOf('}, [triangulateMaxPoints]);', start));
    expect(block).toContain('collectHitPointsCapped');
    expect(block).not.toContain('data.positions[');
  });

  it('ground segmentation sends hits and scatters its labels back', async () => {
    const src = await viewerSource();
    const start = src.indexOf('--- Flat cloud: classify in memory, write scalarFields.');
    expect(start).toBeGreaterThan(-1);
    const block = src.slice(start, start + 4000);

    expect(block).toContain('ps.hits');
    // The write-back half: the backend labels the HIT subset, so a direct write
    // mislabels every point after the first miss.
    expect(block).toMatch(/scatterToFullLength\(response\.labels,\s*hitIndices,\s*count\)/);
    // ...and the split loop must read the SCATTERED labels.
    expect(block).toMatch(/Math\.round\(labels\[i\]\)/);
    expect(block).not.toMatch(/Math\.round\(response\.labels\[i\]\)/);
  });

  it('wood aggregate slices by hit count and scatters back to full length', async () => {
    const src = await viewerSource();
    const start = src.indexOf('Concatenate every cloud');
    expect(start).toBeGreaterThan(-1);
    const block = src.slice(start, start + 5000);

    // Slicing by the cloud's full count would BOTH mis-slice every cloud after
    // the first and mislabel points after each cloud's first miss.
    expect(block).toMatch(/labels\.slice\(cursor,\s*cursor \+ o\.hitCount\)/);
    expect(block).toMatch(/scatterToFullLength\(slice,\s*o\.hitIndices,\s*o\.fullCount\)/);
  });

  it('DEM uses the shared helper rather than a hand-rolled miss loop', async () => {
    const src = await viewerSource();
    const start = src.indexOf('--- Flat cloud: EXCLUDE sky/miss points');
    expect(start).toBeGreaterThan(-1);
    const block = src.slice(start, start + 2500);
    // A local copy of the filter is how the twins drifted apart in the first
    // place; DEM was correct but duplicated.
    expect(block).toContain('collectHitPoints(displayData');
    expect(block).not.toMatch(/if \(!isHit\(i\)\) continue/);
  });
});

describe('absolute-distance parameters are seeded from a hits-only extent', () => {
  // `bounds.size` is set by the most extreme point on each axis, so one ~1km
  // miss defines it. Seeding CSF's cloth resolution or the DEM cell size from
  // that gives defaults ~1000x too coarse -- not a crash, just silently useless
  // numbers the user has to discover and fix by hand. Flat clouds were the ones
  // exposed: `robustExtent` (the backend's percentile span) exists only on
  // session/octree clouds, so flat clouds fell straight through to bounds.size.
  it('CSF cloth resolution', async () => {
    const src = await viewerSource();
    const i = src.indexOf('if (showGroundSegmentPanel && !groundPanelWasOpen.current)');
    expect(i).toBeGreaterThan(-1);
    const block = src.slice(i, i + 1200);
    expect(block).toContain('extentForParameterSeeding(sel.data)');
    expect(block).not.toContain('sel?.data.bounds?.size');
  });

  it('DEM cell size', async () => {
    const src = await viewerSource();
    const i = src.indexOf('if (showDEMPanel && !demPanelWasOpen.current)');
    expect(i).toBeGreaterThan(-1);
    const block = src.slice(i, i + 800);
    expect(block).toContain('extentForParameterSeeding(sel.data)');
    expect(block).not.toContain('sel?.data.bounds?.size');
  });

  it('TreeIso decimation + gap distances', async () => {
    const src = await viewerSource();
    const i = src.indexOf('if (showTreeSegmentPanel && !treePanelWasOpen.current)');
    expect(i).toBeGreaterThan(-1);
    const block = src.slice(i, i + 1600);
    expect(block).toContain('extentForParameterSeeding(sel.data)');
    expect(block).not.toContain('sel?.data.bounds?.size');
  });

  // The three `it`s above are ANCHORED: each names a call site that was already
  // known to be wrong. That shape cannot catch the NEXT tool -- it has no anchor,
  // so no assertion fires and the suite stays green. Tree segmentation proved it:
  // it was the third consumer of a *DefaultsForExtent helper, was left on
  // bounds.size when its two siblings were fixed, and this file passed anyway
  // (it even asserts `not.toContain('sel?.data.bounds?.size')` -- but only inside
  // the two windows it knew to open). The assertions below are anchor-free and
  // hold over the WHOLE file, so a newly added seed site is covered by default.
  it('NO *DefaultsForExtent call is fed from a raw bounds extent', async () => {
    const src = await viewerSource();
    // Every helper that turns an extent into absolute metric parameters.
    const calls = [...src.matchAll(/(\w*DefaultsForExtent)\(/g)];
    expect(calls.length, 'expected to find the extent-seeded default helpers')
      .toBeGreaterThan(0);
    for (const m of calls) {
      // These are all called as f(Math.max(size.x, size.y), ...) -- the extent
      // arrives via a local, so checking the argument text alone proves nothing
      // (that is exactly how tree segmentation passed while broken). Walk BACK
      // to where that local was assigned and check its source instead.
      const head = src.slice(Math.max(0, m.index! - 900), m.index!);
      const assign = [...head.matchAll(/const (\w+) = ([^;]+);/g)].pop();
      expect(assign, `${m[1]}: could not find the extent local it is called with`)
        .toBeTruthy();
      expect(assign![2], `${m[1]} is seeded from a raw bounds extent (via ${assign![1]})`)
        .not.toMatch(/bounds[?.]*\.size/);
    }
  });

  it('NO extent handed to a panel or a world-space brush comes from bounds.size', async () => {
    const src = await viewerSource();
    // A raw extent reaching a panel is the same bug one layer out: DEMPanel
    // divides extentX/extentY by the cell size, compares against DEM_MAX_CELLS
    // and DISABLES Generate, so a miss-set extent locked the user out entirely.
    // The erase brush is the same shape again -- both the seeded size and the
    // slider min/max derive from the cloud diagonal.
    expect(src).not.toMatch(/extent[XY]=\{[^}]*bounds[?.]*\.size/);
    expect(src).not.toMatch(/const diag = \w+\.data\.bounds\.size\.length\(\)/);
  });
});

describe('the deliberate exceptions stay deliberate', () => {
  it('export keeps misses, and says why', async () => {
    const src = await viewerSource();
    // A miss is real recorded information; the exporter writes it as `is_miss`,
    // and LAD needs it as the Beer's-law transmission denominator. Round-tripping
    // a scan must not silently drop ~60% of the file.
    const i = src.indexOf('export deliberately KEEPS sky/miss points');
    expect(i).toBeGreaterThan(-1);
    expect(src.slice(i, i + 600)).toContain('const data = ps.data;');
  });
});
