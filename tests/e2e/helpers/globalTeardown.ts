// Runs once after the whole E2E run. Archives the logs of any session that
// never reached launchApp's close(), typically a test that launched its own
// app and timed out. See scripts/archive-leftover-e2e-logs.mjs.
import { tmpdir } from 'node:os';
import { archiveLeftoverSessionLogs } from '../../../scripts/archive-leftover-e2e-logs.mjs';

export default async function globalTeardown(): Promise<void> {
  const archiveDir = process.env.PHYTOGRAPH_E2E_LOG_ARCHIVE;
  if (!archiveDir) return;
  const r = await archiveLeftoverSessionLogs({ tmpRoot: tmpdir(), archiveDir });
  if (r.copied.length) {
    console.log(`[e2e] archived logs of ${r.copied.length} session(s) that never closed: ${r.copied.join(', ')}`);
  }
  for (const e of r.errors) console.warn(`[e2e] could not archive leftover session logs: ${e}`);
}
