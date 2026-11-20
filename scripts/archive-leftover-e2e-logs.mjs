// Archive the logs of E2E sessions that never reached launchApp's close().
//
// close() copies a session's logs/ into PHYTOGRAPH_E2E_LOG_ARCHIVE (which CI
// uploads) and then deletes the session's profile. A test that launches its
// own app and times out never gets there: its `finally` does not run, so the
// one session that failed left no logs at all (import-grid-xml on CI run
// 44776945162, issue #9). Its profile is still in the temp dir, though, since
// only close() removes it. So whatever `phyto-userdata-*` folder is left at
// the end of a run belongs to a session that ended abnormally, and the
// Playwright globalTeardown (tests/e2e/helpers/globalTeardown.ts) copies its
// logs/ beside the others.
//
// Pure apart from the filesystem it is pointed at, so a unit test can run it
// on a fake temp tree. Same platform rule as close(): off macOS only, where
// the logs live inside the profile (macOS keeps them in ~/Library/Logs).

import { cp, readdir, stat } from 'node:fs/promises';
import { join } from 'node:path';

export const SESSION_PREFIX = 'phyto-userdata-';

/**
 * Copy each session folder's logs/ (`<tmpRoot>/phyto-userdata-XXXX/logs`) to
 * `<archiveDir>/<that folder name>` for every session folder that still exists and is not already archived.
 * Returns the folder names it copied. Never throws for one bad folder: a
 * failed copy is reported in `errors` and the rest carry on.
 */
export async function archiveLeftoverSessionLogs({ tmpRoot, archiveDir, platform = process.platform }) {
  const result = { copied: [], skipped: [], errors: [] };
  if (!archiveDir || platform === 'darwin') return result;
  let entries;
  try {
    entries = await readdir(tmpRoot, { withFileTypes: true });
  } catch (err) {
    result.errors.push(`${tmpRoot}: ${err.message}`);
    return result;
  }
  let archived = new Set();
  try {
    archived = new Set(await readdir(archiveDir));
  } catch {
    // No archive yet: nothing was archived by close() either.
  }
  for (const e of entries) {
    if (!e.isDirectory() || !e.name.startsWith(SESSION_PREFIX)) continue;
    const logs = join(tmpRoot, e.name, 'logs');
    try {
      if (!(await stat(logs)).isDirectory()) continue;
    } catch {
      continue; // a profile that never wrote a log
    }
    if (archived.has(e.name)) {
      result.skipped.push(e.name); // close() got as far as the copy
      continue;
    }
    try {
      await cp(logs, join(archiveDir, e.name), { recursive: true });
      result.copied.push(e.name);
    } catch (err) {
      result.errors.push(`${e.name}: ${err.message}`);
    }
  }
  return result;
}
