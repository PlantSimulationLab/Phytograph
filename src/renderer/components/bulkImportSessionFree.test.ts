// The Helios-XML bundle import is all-or-nothing: on a cancel or any failed
// scan it adds no scans. The scans loaded before that point each own a backend
// session, and dropping them without freeing it left every one resident in the
// sidecar until quit. bulkImportScans lives in the 30k-line viewer, which
// cannot be mounted in a unit test, so this pins both exits at the source.
import { describe, expect, it } from 'vitest';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

const VIEWER = join(process.cwd(), 'src/renderer/components/PointCloudViewer.tsx');

describe('bulkImportScans frees what it will not add', () => {
  it('frees each loaded scan session on cancel and on failure', async () => {
    const src = (await readFile(VIEWER, 'utf8')).replace(/\0/g, '');
    const start = src.indexOf('const bulkImportScans = useCallback');
    expect(start).toBeGreaterThan(-1);
    const block = src.slice(start, src.indexOf('}, [importMesh, onRequestImportWizard, onAddScans, scans]);', start));

    expect(block).toMatch(/const discardLoaded = \(\) => \{[\s\S]*?deleteCloudSession\(sid\)/);
    expect(block).toMatch(/if \(bulkImportCanceledRef\.current\) \{ discardLoaded\(\); return; \}/);
    expect(block).toMatch(/if \(failures\.length > 0\) \{\s*discardLoaded\(\);/);
    // ...and only those two: a successful bundle keeps its sessions.
    expect(block.match(/discardLoaded\(\)/g)).toHaveLength(2);
  });
});
