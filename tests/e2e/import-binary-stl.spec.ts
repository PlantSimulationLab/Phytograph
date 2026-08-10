import { test, expect } from '@playwright/test';
import { join } from 'node:path';
import { launchApp, repoRoot, type LaunchedApp } from './helpers/launchApp';
import { importFiles } from './helpers/importFiles';
import { resetToFreshScene } from './helpers/resetApp';

// STL comes in two encodings and the file itself must say which. Binary is what
// Blender/MeshLab/CAD/slicers write by default: an 80-byte header (frequently all
// zeros, with no `solid` token to key off), a uint32 triangle count, then 50 bytes
// per triangle. Only the length test — 84 + 50n === file size — classifies it
// reliably. Before that existed, every binary STL failed at import with "No mesh
// data found in STL file".
//
// Unit tests cover the parser directly (pointCloudParsers.test.ts). This spec
// exists for the part they can't reach: File→Import → fs:readBinary →
// new File([bytes]) → parseMesh. If the bytes get mangled into text anywhere in
// that chain, only an end-to-end run catches it.
//
// Fixture: a unit cube, 12 triangles, 684 bytes (84 + 50*12), header = 80 zero
// bytes so it reproduces the reported file's shape rather than an easier
// text-header variant. Regenerate byte-identically with:
//
//   python3 -c "
//   import struct
//   V=[(0,0,0),(1,0,0),(1,1,0),(0,1,0),(0,0,1),(1,0,1),(1,1,1),(0,1,1)]
//   F=[(0,3,2,(0,0,-1)),(0,2,1,(0,0,-1)),(4,5,6,(0,0,1)),(4,6,7,(0,0,1)),
//      (0,1,5,(0,-1,0)),(0,5,4,(0,-1,0)),(2,3,7,(0,1,0)),(2,7,6,(0,1,0)),
//      (0,4,7,(-1,0,0)),(0,7,3,(-1,0,0)),(1,2,6,(1,0,0)),(1,6,5,(1,0,0))]
//   out=bytearray(b'\x00'*80)+struct.pack('<I',len(F))
//   for a,b,c,n in F:
//       out+=struct.pack('<3f',*n)
//       for i in (a,b,c): out+=struct.pack('<3f',*V[i])
//       out+=struct.pack('<H',0)
//   open('tests/e2e/fixtures/cube-mesh-binary.stl','wb').write(bytes(out))
//   "
//
// Per CLAUDE.md Testing rules: live backend, drive the real UI through the file
// chooser, assert on concrete output (triangle count), no mocking.
const BINARY_STL = join(repoRoot, 'tests', 'e2e', 'fixtures', 'cube-mesh-binary.stl');

let session: LaunchedApp;
test.beforeAll(async () => {
  session = await launchApp();
});
test.afterAll(async () => {
  await session?.close();
});
test.beforeEach(async () => {
  await resetToFreshScene(session.app, session.page);
});

test('imports a binary STL as a mesh', async () => {
  const { app, page } = session;

  await expect(page.getByTestId('empty-viewer-hint')).toBeVisible();

  await importFiles(app, page, 'import-auto', BINARY_STL);

  // The cube becomes a mesh row with all 12 of its triangles.
  const meshRow = page.getByTestId('mesh-row').first();
  await expect(meshRow).toBeVisible({ timeout: 30_000 });
  await expect(meshRow).toHaveAttribute('data-triangle-count', '12');
  await expect(meshRow).toHaveAttribute('data-mesh-name', 'cube-mesh-binary');

  // It must NOT have landed as a point cloud, and the scene must not be empty.
  await expect(page.getByTestId('scan-row')).toHaveCount(0);
  await expect(page.getByTestId('empty-viewer-hint')).toHaveCount(0);
});
