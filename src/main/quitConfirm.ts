/**
 * Confirmation before an app close that would destroy work.
 *
 * Nothing in a Phytograph session is auto-persisted. A cloud's source file is
 * read exactly once, at import; every later edit (crop, erase, filter, bake,
 * split, segment, label) mutates in-RAM session arrays and nothing writes them
 * back. Meshes, skeletons, plant models and analysis results are only ever in
 * RAM. The one thing that keeps them is File → Save Project, so closing is
 * destructive whenever the scene holds anything not saved in a project, and
 * the renderer reports exactly that (`dirty`: content, and not unchanged since
 * the last project save or open).
 *
 * Deliberately electron-free apart from the injected dialog function, so the
 * decision logic is unit-testable without booting an app.
 */

import type { SceneDirtyPayload } from '../shared/ipc.js';

/** The scene state main last heard about. Starts clean: a window closed before
 *  the renderer ever reported (splash still up, backend failed) has nothing to
 *  lose, and prompting there would be pure obstruction. */
const CLEAN: SceneDirtyPayload = { dirty: false, unexportedLabelClouds: 0 };

let sceneState: SceneDirtyPayload = { ...CLEAN };

/** Record the renderer's latest report of whether closing would lose work. */
export function setSceneDirty(payload: SceneDirtyPayload): void {
  sceneState = {
    dirty: !!payload?.dirty,
    unexportedLabelClouds: Number.isFinite(payload?.unexportedLabelClouds)
      ? Math.max(0, Math.trunc(payload.unexportedLabelClouds)) : 0,
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

/** Text of the confirmation, split out so a test can assert the labels line
 *  appears exactly when some cloud has unexported labels. */
export function confirmDetail(state: SceneDirtyPayload): string {
  const base =
    'This session has changes that are not saved in a project. Point clouds and ' +
    'their edits, meshes, skeletons, plant models and analysis results are held ' +
    'in memory until you save them with File > Save Project; closing discards ' +
    'everything since the last save.';
  const n = state.unexportedLabelClouds;
  if (n > 0) {
    // Hand-made labels are the one thing that cannot be recomputed by
    // re-importing the source file, so name them specifically — the same
    // reasoning as the File → New confirmation.
    return (
      `${base}\n\n${n === 1
        ? '1 point cloud has hand labels changed since it was last exported'
        : `${n} point clouds have hand labels changed since they were last exported`}` +
      ', which cannot be recreated by re-importing.'
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

/** The confirmation's button order. Cancel is 0 so Return/Escape are safe;
 *  Discard stays 1 (E2E answers by index). */
export const QUIT_BUTTONS = ['Cancel', 'Discard and Close', 'Save Project…'] as const;

/**
 * Should the close proceed?
 *
 * Returns true to let the close through, false to cancel it. Must be
 * synchronous: Electron's 'close' and 'before-quit' handlers decide by
 * `event.preventDefault()` during the callback, so an awaited dialog would let
 * the window close first and prompt over the wreckage. For the same reason
 * "Save Project…" cannot save-then-close here: it cancels the close and calls
 * `onSave`, which starts the save; once it succeeds the scene is clean and the
 * next close goes through without asking.
 */
export function shouldAllowClose(confirm: ConfirmFn, onSave?: () => void): boolean {
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
    buttons: onSave ? [...QUIT_BUTTONS] : QUIT_BUTTONS.slice(0, 2),
    defaultId: 0,
    cancelId: 0,
    noLink: true,
  });
  if (choice === 2 && onSave) {
    onSave();
    return false;
  }
  return choice === 1;
}
