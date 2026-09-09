/**
 * Confirmation before an app close that would destroy work.
 *
 * Nothing in a Phytograph session is auto-persisted. A cloud's source file is
 * read exactly once, at import; every later edit (crop, erase, filter, bake,
 * split, segment, label) mutates in-RAM session arrays and nothing writes them
 * back. Meshes, skeletons, plant models and analysis results are only ever in
 * RAM. So closing the window is unconditionally destructive whenever the scene
 * holds anything, and until now it happened on a single stray click with no
 * warning at all.
 *
 * Deliberately electron-free apart from the injected dialog function, so the
 * decision logic is unit-testable without booting an app.
 */

import type { SceneDirtyPayload } from '../shared/ipc.js';

/** The scene state main last heard about. Starts clean: a window closed before
 *  the renderer ever reported (splash still up, backend failed) has nothing to
 *  lose, and prompting there would be pure obstruction. */
const CLEAN: SceneDirtyPayload = { dirty: false, strokes: 0 };

let sceneState: SceneDirtyPayload = { ...CLEAN };

/** Record the renderer's latest report of whether closing would lose work. */
export function setSceneDirty(payload: SceneDirtyPayload): void {
  sceneState = {
    dirty: !!payload?.dirty,
    strokes: Number.isFinite(payload?.strokes) ? Math.max(0, Math.trunc(payload.strokes)) : 0,
  };
}

/** The last reported scene state. Exported for the confirm path and tests. */
export function currentSceneDirty(): SceneDirtyPayload {
  return sceneState;
}

/** Reset to clean. Called when the window goes away (nothing left to lose) so a
 *  later quit — macOS keeps the app alive windowless — never prompts about a
 *  scene that no longer exists. */
export function resetSceneDirty(): void {
  sceneState = { ...CLEAN };
}

/** Text of the confirmation, split out so a test can assert the strokes line
 *  appears exactly when there are uncommitted strokes. */
export function confirmDetail(state: SceneDirtyPayload): string {
  const base =
    'Everything in this session — point clouds, meshes, skeletons, plant models, ' +
    'scans, and analysis results — is held in memory and is not saved anywhere. ' +
    'Closing discards it, including any edits made since import. Export anything ' +
    'you want to keep first.';
  if (state.strokes > 0) {
    // Hand-made labels are the one thing that cannot be recomputed by
    // re-importing the source file, so name them specifically — the same
    // reasoning as the File → New confirmation.
    return (
      `${base}\n\nYou also have ${state.strokes} uncommitted labelling ` +
      `stroke(s), which cannot be recreated by re-importing.`
    );
  }
  return base;
}

/** A synchronous native message box. Injected so tests never open one. */
export type ConfirmFn = (opts: {
  type: 'question';
  title: string;
  message: string;
  detail: string;
  buttons: string[];
  defaultId: number;
  cancelId: number;
  noLink: boolean;
}) => number;

/**
 * Should the close proceed?
 *
 * Returns true to let the close through, false to cancel it. Must be
 * synchronous: Electron's 'close' and 'before-quit' handlers decide by
 * `event.preventDefault()` during the callback, so an awaited dialog would let
 * the window close first and prompt over the wreckage.
 */
export function shouldAllowClose(confirm: ConfirmFn): boolean {
  const state = currentSceneDirty();
  // An empty scene has nothing to lose — never make the user click twice to
  // close an app they just opened.
  if (!state.dirty) return true;
  const choice = confirm({
    type: 'question',
    title: 'Close Phytograph?',
    message: 'Close Phytograph and discard this session?',
    detail: confirmDetail(state),
    // Cancel first so Return/Escape (defaultId/cancelId both 0) are the safe
    // answer — the whole point is that a stray input must not destroy work.
    buttons: ['Cancel', 'Discard and Close'],
    defaultId: 0,
    cancelId: 0,
    noLink: true,
  });
  return choice === 1;
}
