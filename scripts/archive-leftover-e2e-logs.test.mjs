import { mkdtemp, mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { archiveLeftoverSessionLogs } from './archive-leftover-e2e-logs.mjs';

async function tree() {
  const root = await mkdtemp(join(tmpdir(), 'leftover-logs-test-'));
  const tmpRoot = join(root, 'tmp');
  const archiveDir = join(root, 'archive');
  // A session that timed out: profile and logs still there.
  await mkdir(join(tmpRoot, 'phyto-userdata-TIMEDOUT', 'logs'), { recursive: true });
  await writeFile(join(tmpRoot, 'phyto-userdata-TIMEDOUT', 'logs', 'main.log'), 'stalled\n');
  // A session whose close() already archived it before the delete failed.
  await mkdir(join(tmpRoot, 'phyto-userdata-ARCHIVED', 'logs'), { recursive: true });
  await mkdir(join(archiveDir, 'phyto-userdata-ARCHIVED'), { recursive: true });
  // A profile that never wrote a log, and unrelated temp folders.
  await mkdir(join(tmpRoot, 'phyto-userdata-NOLOGS'), { recursive: true });
  await mkdir(join(tmpRoot, 'phyto-octree-abc', 'logs'), { recursive: true });
  await mkdir(join(tmpRoot, 'something-else', 'logs'), { recursive: true });
  return { tmpRoot, archiveDir };
}

describe('archiveLeftoverSessionLogs', () => {
  it('copies only the sessions close() never archived', async () => {
    const { tmpRoot, archiveDir } = await tree();
    const r = await archiveLeftoverSessionLogs({ tmpRoot, archiveDir, platform: 'linux' });
    expect(r).toEqual({ copied: ['phyto-userdata-TIMEDOUT'], skipped: ['phyto-userdata-ARCHIVED'], errors: [] });
    expect(await readFile(join(archiveDir, 'phyto-userdata-TIMEDOUT', 'main.log'), 'utf8')).toBe('stalled\n');
    expect((await readdir(archiveDir)).sort()).toEqual(['phyto-userdata-ARCHIVED', 'phyto-userdata-TIMEDOUT']);
  });

  it('does nothing on macOS or without an archive, like close()', async () => {
    const { tmpRoot, archiveDir } = await tree();
    expect((await archiveLeftoverSessionLogs({ tmpRoot, archiveDir, platform: 'darwin' })).copied).toEqual([]);
    expect((await archiveLeftoverSessionLogs({ tmpRoot, archiveDir: '', platform: 'linux' })).copied).toEqual([]);
  });

  it('reports an unreadable temp root instead of throwing', async () => {
    const r = await archiveLeftoverSessionLogs({ tmpRoot: '/nonexistent/x', archiveDir: '/tmp/y', platform: 'linux' });
    expect(r.copied).toEqual([]);
    expect(r.errors[0]).toContain('/nonexistent/x');
  });
});
