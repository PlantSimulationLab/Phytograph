import { describe, it, expect, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { resolveStitchSessions, StitchCanceledError, type StitchInput } from './stitchSessions';

const live = (scanId: string, sessionId: string): StitchInput => ({
  scanId, sessionId, recreate: vi.fn(async () => { throw new Error('must not re-create a live scan'); }),
});
const gone = (scanId: string, newId: string): StitchInput => ({
  scanId, sessionId: null, recreate: vi.fn(async () => newId),
});

describe('resolveStitchSessions', () => {
  it('uses live sessions as they are and re-creates only the missing ones, in order', async () => {
    const inputs = [live('a', 'sa'), gone('b', 'sb-new'), live('c', 'sc')];
    const recreated: Record<string, string> = {};
    const ids = await resolveStitchSessions(inputs, recreated, new AbortController().signal);
    expect(ids).toEqual(['sa', 'sb-new', 'sc']);
    expect(recreated).toEqual({ b: 'sb-new' });
    expect(inputs[0].recreate).not.toHaveBeenCalled();
  });

  it('reuses a session an earlier attempt re-created instead of importing it again', async () => {
    // The cost prompt: attempt 1 re-created b, the backend asked for
    // confirmation, and "Stitch anyway" is attempt 2.
    const inputs = [live('a', 'sa'), gone('b', 'sb-second')];
    const recreated: Record<string, string> = {};
    const ids = await resolveStitchSessions(
      inputs, recreated, new AbortController().signal, { b: 'sb-first' });
    expect(ids).toEqual(['sa', 'sb-first']);
    expect(inputs[1].recreate).not.toHaveBeenCalled();
    // Still tracked, so the caller frees it when this attempt ends.
    expect(recreated).toEqual({ b: 'sb-first' });
  });

  it('stops at a cancel instead of going on to the merge', async () => {
    const abort = new AbortController();
    const first = gone('a', 'sa-new');
    first.recreate = vi.fn(async () => { abort.abort(); return 'sa-new'; });  // cancel lands mid re-create
    const second = gone('b', 'sb-new');
    const recreated: Record<string, string> = {};
    await expect(resolveStitchSessions([first, second], recreated, abort.signal))
      .rejects.toBeInstanceOf(StitchCanceledError);
    expect(second.recreate).not.toHaveBeenCalled();
    // What was created before the cancel is known to the caller, to be freed.
    expect(recreated).toEqual({ a: 'sa-new' });
  });

  it('a cancel during the LAST re-create still cancels', async () => {
    const abort = new AbortController();
    const only = gone('a', 'sa-new');
    only.recreate = vi.fn(async () => { abort.abort(); return 'sa-new'; });
    await expect(resolveStitchSessions([only], {}, abort.signal))
      .rejects.toBeInstanceOf(StitchCanceledError);
  });

  it('tracks an adopted session even when a later input fails', async () => {
    const bad = gone('c', 'never');
    bad.recreate = vi.fn(async () => { throw new Error('edited since import'); });
    const recreated: Record<string, string> = {};
    await expect(resolveStitchSessions(
      [bad, gone('b', 'unused')], recreated, new AbortController().signal, { b: 'sb-first' }))
      .rejects.toThrow('edited since import');
    expect(recreated).toEqual({ b: 'sb-first' });
  });
});

describe('the stitch handler is wired to it', () => {
  // The helper is only worth its tests if App actually goes through it, frees
  // what it re-created on every exit but the cost prompt, and hands those
  // sessions to the prompt for the retry.
  const app = readFileSync(join(__dirname, '..', 'App.tsx'), 'utf-8');
  const start = app.indexOf('const handleStitchScans = useCallback');
  const handler = app.slice(start, app.indexOf('const handleSavePointCloud', start));

  it('resolves its inputs through resolveStitchSessions with the abort signal and the reuse map', () => {
    expect(handler).toMatch(/resolveStitchSessions\(\s*inputs,\s*recreated,\s*abort\.signal,\s*reuse/);
    expect(handler).not.toMatch(/sessionIds\.push\(/);
  });

  it('frees re-created sessions on success, failure and cancel, and keeps them across the cost prompt', () => {
    expect(handler).toMatch(/handedToPrompt = true/);
    expect(handler).toMatch(/if \(!handedToPrompt\) freeStitchSessions\(recreated\)/);
    expect(handler).not.toMatch(/if \(!committed\)/);
  });

  it('the prompt frees them when dismissed and passes them on when confirmed', () => {
    const prompt = app.slice(app.indexOf('data-testid="stitch-cost-dialog"'));
    const body = prompt.slice(0, prompt.indexOf('data-testid="stitch-cost-confirm"') + 400);
    expect(body).toMatch(/stitch-cost-cancel[\s\S]*?freeStitchSessions\(stitchCostPrompt\.recreated\)/);
    expect(body.match(/handleStitchScans\(ids, \{[^}]*\}, recreated\)/g)?.length).toBe(2);
  });
});

describe('stitchRemoveActions', () => {
  const scan = (id: string, cacheId: string, sessionId: string | null = `s-${id}`) =>
    ({ id, data: { octree: { sessionId, cacheId } } });

  it('records each input as the scene has it NOW, not as it was when the stitch began', async () => {
    const { stitchRemoveActions } = await import('./stitchSessions');
    // At the click the scene was [a(octree A1), b]; while the stitch ran, a
    // display refresh gave `a` a new octree and another cloud was added in front.
    const live = {
      scans: [scan('new', 'N'), scan('a', 'A2'), scan('b', 'B')],
      editStates: new Map([['a', { moved: true }]]),
      cloudFilters: new Map([['b', ['f']]]),
    };
    const actions = stitchRemoveActions(live, ['a', 'b']);
    expect(actions.map((x) => [x.id, x.index])).toEqual([['a', 1], ['b', 2]]);
    // Undo restores THIS object: the refreshed octree, not the replaced one.
    expect(actions[0].object.data.octree.cacheId).toBe('A2');
    expect(actions[0].editState).toEqual({ moved: true });
    expect(actions[1].filters).toEqual(['f']);
    expect(actions[0].sessionId).toBe('s-a');
  });

  it('skips an input that is no longer in the scene', async () => {
    const { stitchRemoveActions } = await import('./stitchSessions');
    const live = { scans: [scan('b', 'B')], editStates: new Map(), cloudFilters: new Map() };
    expect(stitchRemoveActions(live, ['a', 'b']).map((x) => x.id)).toEqual(['b']);
  });

  it('is what the stitch commit uses, on the live scene', () => {
    const app = readFileSync(join(__dirname, '..', 'App.tsx'), 'utf-8');
    const start = app.indexOf('const commitStitch = (newData: PointCloudData) => {');
    const body = app.slice(start, app.indexOf('showToast({', start));
    expect(body).toMatch(/stitchRemoveActions\(\s*sceneRef\.current\.state/);
    expect(body).toMatch(/sceneRef\.current\.commit\(/);
    expect(body).not.toMatch(/scene\.state\./);
  });
});
