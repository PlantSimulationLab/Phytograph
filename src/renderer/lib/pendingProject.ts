// A project the backend has opened, waiting for the scene to be reset.
//
// Opening a project reuses File → New's reset (App.handleResetToNew), which
// frees the old sessions and REMOUNTS the app so no per-view state of the old
// scene survives. The opened project has to outlive that remount, so it waits
// here, module-level, and the fresh viewer takes it on mount.

export interface PendingProject {
  path: string;
  doc: { scene: Record<string, unknown>; viewer: Record<string, unknown> };
  sessionMap: Record<string, string>;
}

let pending: PendingProject | null = null;

export function setPendingProject(p: PendingProject | null): void {
  pending = p;
}

/** Take (and clear) the pending project, if any. */
export function takePendingProject(): PendingProject | null {
  const p = pending;
  pending = null;
  return p;
}
