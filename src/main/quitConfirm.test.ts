import { describe, it, expect, beforeEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import {
  setSceneDirty,
  resetSceneDirty,
  currentSceneDirty,
  confirmDetail,
  shouldAllowClose,
  type ConfirmFn,
} from './quitConfirm.js';

/** A confirm that records its options and returns a scripted button index. */
function stubConfirm(choice: number): ConfirmFn & { calls: Parameters<ConfirmFn>[0][] } {
  const calls: Parameters<ConfirmFn>[0][] = [];
  const fn = ((opts) => {
    calls.push(opts);
    return choice;
  }) as ConfirmFn & { calls: Parameters<ConfirmFn>[0][] };
  fn.calls = calls;
  return fn;
}

describe('quit confirmation', () => {
  beforeEach(() => resetSceneDirty());

  it('never prompts on an empty scene', () => {
    const confirm = stubConfirm(0);
    expect(shouldAllowClose(confirm)).toBe(true);
    expect(confirm.calls).toHaveLength(0);
  });

  it('starts clean, so a close before the renderer ever reports does not prompt', () => {
    // A window closed while the splash is still up (backend failed, user gave
    // up) has nothing to lose; prompting there is pure obstruction.
    const confirm = stubConfirm(0);
    expect(currentSceneDirty()).toEqual({ dirty: false, strokes: 0 });
    expect(shouldAllowClose(confirm)).toBe(true);
    expect(confirm.calls).toHaveLength(0);
  });

  it('prompts once the scene holds something, and CANCELS the close by default', () => {
    setSceneDirty({ dirty: true, strokes: 0 });
    // Button 0 is Cancel — what Return and Escape both select.
    const confirm = stubConfirm(0);
    expect(shouldAllowClose(confirm)).toBe(false);
    expect(confirm.calls).toHaveLength(1);
  });

  it('allows the close only when the discard button is chosen', () => {
    setSceneDirty({ dirty: true, strokes: 0 });
    expect(shouldAllowClose(stubConfirm(1))).toBe(true);
  });

  it('makes the safe answer the default and the cancel action', () => {
    setSceneDirty({ dirty: true, strokes: 0 });
    const confirm = stubConfirm(0);
    shouldAllowClose(confirm);
    const opts = confirm.calls[0];
    // The whole point is that a stray Return/Escape must not destroy work, so
    // both must resolve to the Cancel button, and Cancel must be index 0.
    expect(opts.buttons[0]).toMatch(/cancel/i);
    expect(opts.defaultId).toBe(0);
    expect(opts.cancelId).toBe(0);
    expect(opts.buttons[1]).toMatch(/discard|close/i);
  });

  it('calls out uncommitted labelling strokes, which cannot be recomputed', () => {
    setSceneDirty({ dirty: true, strokes: 7 });
    expect(confirmDetail(currentSceneDirty())).toContain('7 uncommitted labelling');
  });

  it('omits the stroke line when there are none', () => {
    setSceneDirty({ dirty: true, strokes: 0 });
    expect(confirmDetail(currentSceneDirty())).not.toMatch(/labelling/i);
  });

  it('says the session is unsaved, since that is the reason to warn at all', () => {
    setSceneDirty({ dirty: true, strokes: 0 });
    const detail = confirmDetail(currentSceneDirty());
    expect(detail).toMatch(/not saved|memory/i);
    expect(detail).toMatch(/export/i);
  });

  it('reverts to clean when the window goes away', () => {
    setSceneDirty({ dirty: true, strokes: 3 });
    resetSceneDirty();
    expect(currentSceneDirty()).toEqual({ dirty: false, strokes: 0 });
    // A macOS app that outlives its window must not prompt about a scene that
    // no longer exists.
    expect(shouldAllowClose(stubConfirm(0))).toBe(true);
  });

  it('tolerates a malformed payload rather than prompting on garbage', () => {
    setSceneDirty({ dirty: true, strokes: Number.NaN } as never);
    expect(currentSceneDirty().strokes).toBe(0);
    setSceneDirty(undefined as never);
    expect(currentSceneDirty()).toEqual({ dirty: false, strokes: 0 });
  });
});

describe('quit confirmation wiring', () => {
  // The logic above is worthless if main.ts stops calling it, and a
  // native-dialog path cannot be exercised by the E2E suite (it is suppressed
  // there by design). Assert the seams at the source, the way the octree
  // cache-root contract test does.
  const src = () => readFileSync(resolve(__dirname, 'main.ts'), 'utf8');

  it('guards BOTH window close and before-quit', () => {
    const s = src();
    // Two distinct gestures that never share a code path: on macOS a window
    // close does not quit the app, and off-darwin Cmd+Q runs before-quit
    // without any window close.
    expect(s).toMatch(/on\('close'/);
    expect(s).toMatch(/on\('before-quit'/);
    expect(s.match(/shouldAllowClose\(/g)?.length).toBeGreaterThanOrEqual(2);
  });

  it('confirms before before-quit tears the backend down', () => {
    const s = src();
    // Strip comments first: the handler's own explanation NAMES stopBackend(),
    // and matching that prose would compare the wrong two positions.
    const handler = s
      .slice(s.indexOf("app.on('before-quit'"))
      .replace(/\/\/[^\n]*/g, '');
    const confirmAt = handler.indexOf('shouldAllowClose');
    const stopAt = handler.indexOf('stopBackend()');
    expect(confirmAt).toBeGreaterThan(-1);
    expect(stopAt).toBeGreaterThan(-1);
    // Cancelling a quit must leave a WORKING app. stopBackend() first would
    // kill the sidecar holding every cloud session, so "cancel" would hand the
    // user a live window over a dead backend.
    expect(confirmAt).toBeLessThan(stopAt);
  });

  it('suppresses the native dialog under E2E unless a spec opts in', () => {
    const s = src();
    // A native modal has no driver to dismiss it; a previous beforeunload-based
    // attempt hung Playwright teardown for the full 180 s timeout. So the guard
    // is armed only outside E2E, or when a spec explicitly asks for it via
    // PHYTOGRAPH_E2E_QUIT_CONFIRM (which answers it without opening a dialog).
    expect(s).toMatch(/const quitConfirmArmed = !isE2E \|\| !!e2eQuitAnswer;/);
    // Both close paths must consult that flag, not isE2E directly — otherwise
    // tests/e2e/quit-confirm.spec.ts could never drive the real handler.
    expect(s).toMatch(/if \(quitConfirmArmed\)\s*\{\s*mainWindow\.on\('close'/);
    expect(s).toMatch(/quitConfirmArmed && !quitConfirmed/);
  });
});
