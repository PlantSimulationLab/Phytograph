// Turns a raw QSM-build error (from the backend or a thrown fetch error) into a
// message that's actionable for the user.
//
// The case that matters: a QSM build referencing a backend cloud SESSION can
// fail with "Cloud session not found" when the backend restarted (a
// version-locked respawn, an update, or a crash) since the scan was imported —
// the renderer still holds the now-dead session id. We deliberately do NOT fall
// back to re-reading the source file on disk: the import wizard may have applied
// non-default column mapping / scale / offset that live only in the session, so
// a silent re-read could yield a WRONG QSM while reporting success. Failing with
// a clear remedy is safer than a plausible-but-garbage result.
export function prettifyQSMError(raw: string): string {
  if (/session not found/i.test(raw)) {
    return 'the backend restarted since this scan was imported, so its data is no longer loaded. Re-import the scan and build again.';
  }
  return raw;
}
