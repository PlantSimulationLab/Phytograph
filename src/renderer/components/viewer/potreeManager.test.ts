import { beforeEach, describe, expect, it, vi } from 'vitest';

// The frame registry's whole reason to exist is the "disco flicker" regression:
// potree's point budget and node LRU are global to the shared manager, so
// updating clouds one at a time made each claim the full budget and evict the
// others' nodes, cycling clouds in and out every frame. These tests pin the
// invariant that fixes it — ONE call per frame carrying EVERY active octree.

const updatePointClouds = vi.fn();
vi.mock('potree-core', () => ({
  Potree: class {
    pointBudget = 0;
    updatePointClouds = (...args: unknown[]) => updatePointClouds(...args);
  },
}));

const { registerOctreeForFrame, updateAllPointClouds } = await import('./potreeManager');

// Minimal stand-in — the registry only ever reads `disposed` off the octree.
function makeOctree(name: string) {
  return { name, disposed: false } as never;
}

const camera = {} as never;
const renderer = {} as never;

// Registered octrees persist in a module-level map, so each test cleans up after
// itself via the returned unregister functions.
let cleanups: Array<() => void> = [];
function register(entry: Parameters<typeof registerOctreeForFrame>[0]) {
  cleanups.push(registerOctreeForFrame(entry));
}

beforeEach(() => {
  for (const fn of cleanups) fn();
  cleanups = [];
  updatePointClouds.mockClear();
});

describe('updateAllPointClouds', () => {
  it('updates every registered octree in a single call', () => {
    const a = makeOctree('a');
    const b = makeOctree('b');
    const c = makeOctree('c');
    register({ octree: a });
    register({ octree: b });
    register({ octree: c });

    updateAllPointClouds(camera, renderer);

    // The regression: three separate calls instead of one batch.
    expect(updatePointClouds).toHaveBeenCalledTimes(1);
    expect(updatePointClouds.mock.calls[0][0]).toEqual([a, b, c]);
    expect(updatePointClouds.mock.calls[0][1]).toBe(camera);
    expect(updatePointClouds.mock.calls[0][2]).toBe(renderer);
  });

  it('omits skipped clouds but still batches the rest', () => {
    const a = makeOctree('a');
    const b = makeOctree('b');
    register({ octree: a, shouldSkip: () => true });
    register({ octree: b });

    updateAllPointClouds(camera, renderer);

    expect(updatePointClouds).toHaveBeenCalledTimes(1);
    expect(updatePointClouds.mock.calls[0][0]).toEqual([b]);
  });

  it('omits disposed clouds, which linger a frame before unregistering', () => {
    const live = makeOctree('live');
    const dead = makeOctree('dead') as unknown as { disposed: boolean };
    dead.disposed = true;
    register({ octree: live });
    register({ octree: dead as never });

    updateAllPointClouds(camera, renderer);

    expect(updatePointClouds.mock.calls[0][0]).toEqual([live]);
  });

  it('does not call potree at all when every cloud is skipped', () => {
    register({ octree: makeOctree('a'), shouldSkip: () => true });

    updateAllPointClouds(camera, renderer);

    // An empty array would make potree fill the budget from nothing.
    expect(updatePointClouds).not.toHaveBeenCalled();
  });

  it('runs afterUpdate hooks only after the shared update', () => {
    const order: string[] = [];
    updatePointClouds.mockImplementation(() => order.push('update'));
    register({ octree: makeOctree('a'), afterUpdate: () => order.push('after:a') });
    register({ octree: makeOctree('b'), afterUpdate: () => order.push('after:b') });

    updateAllPointClouds(camera, renderer);

    // Hooks read visibleNodes, so they must not interleave with the update.
    expect(order).toEqual(['update', 'after:a', 'after:b']);
    updatePointClouds.mockImplementation(() => {});
  });

  it('skips afterUpdate for clouds excluded this frame', () => {
    const afterSkipped = vi.fn();
    register({ octree: makeOctree('a'), shouldSkip: () => true, afterUpdate: afterSkipped });

    updateAllPointClouds(camera, renderer);

    expect(afterSkipped).not.toHaveBeenCalled();
  });

  it('drops a cloud from the batch once it unregisters', () => {
    const a = makeOctree('a');
    const b = makeOctree('b');
    register({ octree: a });
    const unregisterB = registerOctreeForFrame({ octree: b });

    unregisterB();
    updateAllPointClouds(camera, renderer);

    expect(updatePointClouds.mock.calls[0][0]).toEqual([a]);
  });

  it('is a no-op with nothing registered', () => {
    updateAllPointClouds(camera, renderer);
    expect(updatePointClouds).not.toHaveBeenCalled();
  });
});
