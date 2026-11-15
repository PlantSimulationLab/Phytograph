// Which backend session each stitch input is read from.
//
// Most inputs already have a live session. One whose session is gone (backend
// restart, idle eviction) is re-created from its source file, and that
// re-created session belongs to no scan: nothing else will ever free it. Three
// things follow, and each was a bug in the first cut of the cancelable stitch:
//
//   - they must be freed when the stitch ends, WHETHER OR NOT it succeeded (the
//     merged cloud is its own copy of the points);
//   - they must survive a cost prompt, or "Stitch anyway" re-imports every one
//     of them from disk a second time (`reuse`);
//   - re-creating can take minutes, so a Cancel during it has to stop the loop
//     rather than be noticed only after the merge has run and committed.

export interface StitchInput {
  scanId: string;
  // The scan's live session, if it has one.
  sessionId?: string | null;
  // Re-create a session for this scan from its source file. May throw (an
  // edited cloud cannot be rebuilt from its file); the error propagates.
  recreate: (signal: AbortSignal) => Promise<string>;
}

/** Thrown when the stitch was canceled while its inputs were being prepared. */
export class StitchCanceledError extends Error {
  constructor() {
    super('Stitch canceled');
    this.name = 'StitchCanceledError';
  }
}

/**
 * Session ids for `inputs`, in order. Sessions this call (or an earlier attempt,
 * via `reuse`) had to re-create are recorded in `recreated`, keyed by scan id.
 * `recreated` is the CALLER's object and is filled as the loop goes, so the
 * caller can free what exists even when this throws partway.
 */
export async function resolveStitchSessions(
  inputs: StitchInput[],
  recreated: Record<string, string>,
  signal: AbortSignal,
  reuse: Record<string, string> = {},
): Promise<string[]> {
  // Adopt the earlier attempt's sessions first, so they are tracked (and freed)
  // even if this attempt stops before reaching them.
  for (const input of inputs) {
    if (!input.sessionId && reuse[input.scanId]) recreated[input.scanId] = reuse[input.scanId];
  }
  const sessionIds: string[] = [];
  for (const input of inputs) {
    if (signal.aborted) throw new StitchCanceledError();
    if (input.sessionId) {
      sessionIds.push(input.sessionId);
    } else if (recreated[input.scanId]) {
      sessionIds.push(recreated[input.scanId]);
    } else {
      const sid = await input.recreate(signal);
      recreated[input.scanId] = sid;
      sessionIds.push(sid);
    }
  }
  if (signal.aborted) throw new StitchCanceledError();
  return sessionIds;
}

// ── Committing the stitch ────────────────────────────────────────────────────

interface LiveScene<S, E, F> {
  scans: S[];
  editStates: Map<string, E>;
  cloudFilters: Map<string, F>;
}

/**
 * The `remove` actions for a stitch's inputs, built from the scene AS IT IS NOW.
 *
 * A stitch can run for minutes, and the handler that started it closed over the
 * scene of that moment. Building these from that snapshot recorded each input
 * as it was at the click: a display refresh that finished meanwhile had given
 * the cloud a new octree, so Undo restored a scan pointing at an octree that
 * had been replaced (and, on a full cache, deleted), and at a stale position in
 * the list. Inputs that no longer exist (an undo during the stitch removed
 * them) are skipped rather than "removed" a second time.
 */
export function stitchRemoveActions<
  S extends { id: string; data?: { octree?: { sessionId?: string | null } | null } | null },
  E, F,
>(live: LiveScene<S, E, F>, inputIds: string[]) {
  const actions: Array<{
    t: 'remove'; kind: 'scan'; id: string; index: number; object: S;
    editState: E | undefined; filters: F | undefined; sessionId: string | null;
  }> = [];
  for (const id of inputIds) {
    const index = live.scans.findIndex((x) => x.id === id);
    if (index < 0) continue;
    const object = live.scans[index];
    actions.push({
      t: 'remove', kind: 'scan', id, index, object,
      editState: live.editStates.get(id),
      filters: live.cloudFilters.get(id),
      sessionId: object.data?.octree?.sessionId ?? null,
    });
  }
  return actions;
}
