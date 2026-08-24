// The octree-frame guarantees are CHOKEPOINTS, not per-tool responsibilities.
//
// A committed transform now moves the session geometry immediately but leaves
// the octree in its old frame, drawn through a stored pose (`storedPose`). That
// is safe because potree composes the octree object's matrix through rendering,
// LOD, picking and GPU clipping — tile scene nodes are its children.
//
// Two things are NOT safe by construction, and each gets a chokepoint here:
//
//  1. Compute reading a cloud whose rendered pose and session geometry disagree.
//     `buildPointSource` is async and settles the bake queue first. Nothing
//     defers geometry any more, so this is a no-op safety net — but the seam and
//     its enforcement (async ⇒ an un-awaited call site fails to compile) are kept
//     so future deferred work is covered by default.
//
//  2. SCREEN-SPACE regions (lasso crop, erase brush, label brush). These freeze
//     the camera that was looking at the POSED octree and the backend replays it
//     against session positions, so the frames must agree first —
//     `ensureOctreeFrameCurrent`.
//
// Pinned at the SOURCE level, the way missExclusionChokepoint.test.ts is: the
// guarantee lives in a 30k-line React component that cannot be mounted in a unit
// test, and every property here is a one-line revert away from regressing.
import { describe, expect, it } from 'vitest';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

const VIEWER = join(process.cwd(), 'src/renderer/components/PointCloudViewer.tsx');

async function viewerSource(): Promise<string> {
  // NOTE: App.tsx-adjacent renderer sources have carried NUL bytes; read as
  // utf8 and strip them so the regexes below behave.
  return (await readFile(VIEWER, 'utf8')).replace(/\0/g, '');
}

function buildPointSourceBlock(src: string): string {
  const start = src.indexOf('const buildPointSource = useCallback');
  expect(start).toBeGreaterThan(-1);
  const end = src.indexOf('}, [getEditState, getDisplayData]);', start);
  expect(end).toBeGreaterThan(start);
  return src.slice(start, end);
}

describe('buildPointSource is the compute barrier', () => {
  it('is async, so an un-awaited call site cannot compile', async () => {
    const block = buildPointSourceBlock(await viewerSource());
    expect(block).toMatch(/const buildPointSource = useCallback\(async \(/);
    expect(block).toMatch(/Promise<PointSourcePayload>/);
  });

  it('settles the queue BEFORE reading the cloud', async () => {
    const block = buildPointSourceBlock(await viewerSource());
    const settle = block.indexOf('bakeQueueRef.current?.settle(cloud.id)');
    expect(settle).toBeGreaterThan(-1);
    expect(block.slice(0, settle)).toMatch(/await\s*$/);
    // Order matters: settling after resolving the octree would read the cloud's
    // pre-bake state and hand it straight to a tool.
    const readsOctree = block.indexOf('const octree = cloud.data.octree');
    expect(readsOctree).toBeGreaterThan(-1);
    expect(settle).toBeLessThan(readsOctree);
  });

  it('every compute call site resolves the promise', async () => {
    const src = await viewerSource();
    const calls = [...src.matchAll(/\bbuildPointSource\(/g)].filter(m => {
      const before = src.slice(Math.max(0, m.index! - 40), m.index!);
      return !before.includes('const buildPointSource = ');
    });
    expect(calls.length).toBeGreaterThanOrEqual(14);
    const unresolved = calls.filter(m => {
      const before = src.slice(Math.max(0, m.index! - 120), m.index!);
      if (/await\s+$/.test(before)) return false;
      return !/await\s+Promise\.all\([^;]*$/.test(before);
    });
    expect(unresolved.map(m => src.slice(m.index!, m.index! + 60))).toEqual([]);
  });
});

describe('screen-space regions refresh the octree first', () => {
  it('ensureOctreeFrameCurrent is async and reports failure', async () => {
    const src = await viewerSource();
    expect(src).toMatch(/const ensureOctreeFrameCurrent = useCallback\(async \(cloudId: string\): Promise<boolean>/);
    // A refresh that FAILED must report false so the caller aborts rather than
    // shipping a region into a mismatched frame. Scoped to the function body —
    // `/return false;/` against the whole file matches anything, anywhere.
    const at = src.indexOf('const ensureOctreeFrameCurrent = useCallback');
    const body = src.slice(at, src.indexOf('ensureOctreeFrameCurrentRef', at));
    expect(body).toMatch(/catch \(err\)[\s\S]{0,600}?return false;/);
  });

  it('guards the crop, erase-brush and label-brush region paths', async () => {
    const src = await viewerSource();
    const guards = [...src.matchAll(/await ensureOctreeFrameCurrentRef\.current\(/g)];
    // crop apply + erase instant-delete + label stroke.
    expect(guards.length).toBeGreaterThanOrEqual(3);
  });

  it('re-reads the cloud after a frame refresh, never writing back the snapshot', async () => {
    const src = await viewerSource();
    // `ensureOctreeFrameCurrent` re-tiles and installs a NEW cacheId and bounds
    // via onUpdateCloud. A caller that then writes back its pre-refresh snapshot
    // reverts all of that — and because handleUpdateScanData replaces `data`
    // wholesale, the viewer re-mounts the un-posed original octree while the
    // session geometry stays moved. Silent, and the cloud visibly snaps back.
    const at = src.indexOf('await backfillMisses(');
    expect(at).toBeGreaterThan(-1);
    const after = src.slice(at, at + 2500);
    expect(after, 'backfill must re-read the cloud after the refresh')
      .toMatch(/cloudsRef\.current\.find\(c => c\.id === cloud\.id\)/);
    // And the write-back must use the re-read value, not the closure.
    expect(after).toMatch(/\.\.\.liveCloud\.data/);
    expect(after).toMatch(/\.\.\.liveOct/);
  });

  it('guards Backfill Misses — the one rebuild the cacheId gate cannot see', async () => {
    const src = await viewerSource();
    // Backfill rebuilds the MISS octree from already-moved session positions but
    // leaves the HITS cacheId untouched — and the stored pose is gated on that
    // hits id. Without this guard the shell keeps being posed on top of geometry
    // that already carries the transform, drawing it at DOUBLE the rotation
    // (hundreds of metres off, on a scan whose misses sit ~1 km out).
    const at = src.indexOf('await backfillMisses(');
    expect(at).toBeGreaterThan(-1);
    const before = src.slice(Math.max(0, at - 1500), at);
    expect(before, 'backfill must refresh the octree frame first')
      .toMatch(/await ensureOctreeFrameCurrentRef\.current\(/);
  });

  it('each region call is preceded by the guard, not followed by it', async () => {
    const src = await viewerSource();
    // The erase brush's squares_union and the label stroke both carry a frozen
    // camera; assert the guard is upstream of the request in each case.
    for (const call of ['deleteCloudRegion(sessionId, deleteRegion as CropOctreeRegion)',
                        'labelCloudRegion(sessionId, [{']) {
      const at = src.indexOf(call);
      expect(at, `missing call site: ${call}`).toBeGreaterThan(-1);
      const before = src.slice(Math.max(0, at - 1200), at);
      expect(before, `guard missing before ${call}`)
        .toMatch(/await ensureOctreeFrameCurrentRef\.current\(/);
    }
  });
});

describe('a committed transform keeps render pose and geometry in step', () => {
  it('awaits the session write, then poses only when the octree was left alone', async () => {
    const src = await viewerSource();
    // The GEOMETRY is never deferred — that is what makes compute correct at once.
    expect(src).toMatch(/await sessionTransform\([^;]*'pose'\)/);
    expect(src).toMatch(/if \(result\.octree_posed\)/);
  });

  it('records the pose against the cache id it was measured on', async () => {
    const src = await viewerSource();
    // The cacheId stamp is what lets ~10 rebuild paths stay ignorant of this
    // feature: a rebuild yields a new id, the stamp stops matching, and the pose
    // is dropped instead of double-applying.
    expect(src).toMatch(/storedPose: \{[\s\S]{0,400}?cacheId: result\.cache_id,/);
  });

  it('consumes the draft into the stored pose rather than leaving both', async () => {
    const src = await viewerSource();
    // Leaving the draft up alongside the stored pose would apply the move twice.
    const at = src.indexOf('storedPose: {');
    expect(at).toBeGreaterThan(-1);
    const before = src.slice(Math.max(0, at - 700), at);
    expect(before).toMatch(/translation: \{ x: 0, y: 0, z: 0 \}/);
    expect(before).toMatch(/rotation: \{ x: 0, y: 0, z: 0 \}/);
  });

  it('COMPOSES onto an existing pose rather than replacing it', async () => {
    const src = await viewerSource();
    // Each commit moves the geometry again, so the pose must describe the TOTAL
    // displacement from the octree's frame. Writing just the latest draft
    // silently discards every earlier one — caught in E2E as two 30 degree
    // rotations rendering as 30, not 60.
    const writes = [...src.matchAll(/storedPose: \{/g)];
    expect(writes.length).toBeGreaterThanOrEqual(2);
    for (const w of writes) {
      const after = src.slice(w.index!, w.index! + 400);
      expect(after, 'a storedPose write must compose the previous pose')
        .toMatch(/composeCloudPose\(/);
      expect(after).toMatch(/storedPose: (st|state)\.storedPose/);
    }
  });

  it('moves data.bounds at commit, since the geometry really moved', async () => {
    const src = await viewerSource();
    // Framing, zoom-to-selection, displayOffset and the scene origin all read
    // data.bounds; leaving it behind would describe where the cloud used to be.
    expect(src).toMatch(/transformBoundsAabb\(cloud\.data\.bounds/);
    expect(src).toMatch(/transformBoundsAabb\(\s*sourceCloud\.data\.bounds/);
  });

  it('renders hits octree and miss shell from ONE composed pose', async () => {
    const src = await viewerSource();
    // Two independent computations here is how the shell drifts off the tree.
    expect(src).toMatch(/translation=\{hasResamplePreview \? undefined : cloudPose\.translation\}/);
    expect(src).toMatch(/translation=\{cloudPose\.translation\}/);
    expect(src).toMatch(/const cloudPose = getCloudPose\(cloud\);/);
  });

  it('the E2E bounds attribute adds the DRAFT only, never the stored pose', async () => {
    const src = await viewerSource();
    const at = src.indexOf('data-scan-bounds={(() => {');
    expect(at).toBeGreaterThan(-1);
    const block = src.slice(at, at + 1600);
    // `storedPose` maps the OCTREE frame to the world; `data.bounds` is already
    // in the world (moved at every commit). Composing the pose here applies a
    // committed transform TWICE — measured as a 5.8 m error against the
    // registration fixtures before this was corrected.
    expect(block).not.toMatch(/composeCloudPose\(/);
    expect(block).toMatch(/transformBoundsAabb\(/);
    expect(block).toMatch(/st\?\.translation/);
  });

  it('marks the cloud diverged from source at every storedPose write', async () => {
    const src = await viewerSource();
    // `handleOctreeMissing` refuses to rebuild-from-source only when the cloud is
    // diverged; a posed cloud that was NOT marked would be silently restored to
    // its original pose, discarding the transform. The invariant is
    // "storedPose ⟹ divergedFromSource", so check it at each write rather than
    // asserting the string exists somewhere in a 20k-line file.
    const writes = [...src.matchAll(/storedPose: \{/g)];
    expect(writes.length).toBeGreaterThanOrEqual(2);
    for (const w of writes) {
      // The onUpdateCloud that installs the octree precedes the setEditStates
      // that installs the pose, in both commit paths.
      const before = src.slice(Math.max(0, w.index! - 2500), w.index!);
      expect(before, 'a storedPose write must be paired with divergedFromSource')
        .toMatch(/divergedFromSource: true/);
    }
  });
});
