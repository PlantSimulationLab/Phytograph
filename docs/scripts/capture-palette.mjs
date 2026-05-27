// One-shot retry of the command palette screenshot only.
import { _electron } from 'playwright';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(__dirname, '..', '..');
const outDir = join(repoRoot, 'docs', 'docs', 'assets', 'screenshots');

const BACKEND_URL = 'http://127.0.0.1:8008';

async function waitForBackend(timeoutMs = 120_000) {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    try {
      const res = await fetch(`${BACKEND_URL}/version`, { signal: AbortSignal.timeout(2_000) });
      if (res.ok) return await res.json();
    } catch {}
    await new Promise((r) => setTimeout(r, 1_000));
  }
  throw new Error('Backend never came up');
}

const app = await _electron.launch({ args: ['.'], cwd: repoRoot, timeout: 60_000 });
const page = await app.firstWindow();
await waitForBackend();
await page.waitForTimeout(1500);

// Navigate to viewer (palette only works there).
await page.getByTestId('nav-viewer').click();
await page.waitForTimeout(800);

// Click on the canvas / app root to make sure the window is focused.
await page.locator('[data-testid="app-root"]').click({ position: { x: 400, y: 200 } });
await page.waitForTimeout(300);

// Dispatch Cmd+K via the page's keyboard API. Use lowercase 'k' because the
// handler checks e.key === 'k' (not 'K').
await page.keyboard.down('Meta');
await page.keyboard.press('KeyK');
await page.keyboard.up('Meta');
await page.waitForTimeout(600);

await page.screenshot({ path: join(outDir, '05-command-palette.png') });
console.log('Saved 05-command-palette.png');

await app.close().catch(() => {});
