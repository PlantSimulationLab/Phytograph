import { _electron, type ElectronApplication, type Page } from '@playwright/test';
import { existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { waitForBackend } from './waitForBackend';

const __dirname = dirname(fileURLToPath(import.meta.url));
export const repoRoot = join(__dirname, '..', '..', '..');

export interface LaunchedApp {
  app: ElectronApplication;
  page: Page;
  backendVersion: string;
  // Use this instead of app.close() — it awaits the Electron process exit,
  // not just the window close. Prevents spec-N+1 from racing spec-N's
  // teardown (which on macOS can briefly surface a window).
  // Refs: playwright#20016, playwright#12189, playwright#39248.
  close: () => Promise<void>;
}

function backendBinaryPath(): string {
  return process.platform === 'win32'
    ? join(repoRoot, 'resources', 'phytograph_backend', 'phytograph_backend.exe')
    : join(repoRoot, 'resources', 'phytograph_backend', 'phytograph_backend');
}

function mainEntry(): string {
  return join(repoRoot, 'dist-main', 'main.js');
}

export async function launchApp(): Promise<LaunchedApp> {
  const backendBin = backendBinaryPath();
  if (!existsSync(backendBin)) {
    throw new Error(
      `Backend binary missing at ${backendBin}.\n` +
        `Run \`npm run build:backend\` before E2E. ` +
        `Mocks are not allowed — see CLAUDE.md Testing rule #1.`,
    );
  }
  const main = mainEntry();
  if (!existsSync(main)) {
    throw new Error(
      `dist-main/main.js missing. Run \`npm run build\` before E2E.`,
    );
  }

  const app = await _electron.launch({
    args: ['.'],
    cwd: repoRoot,
    timeout: 60_000,
    env: {
      ...process.env,
      // Suppresses the visible window and devtools in main.ts. See the
      // comments next to `isE2E` in src/main/main.ts.
      PHYTOGRAPH_E2E: '1',
    },
  });
  const page = await app.firstWindow();

  // Wait for the supervised backend to actually serve /version. The main
  // process spawns it in startBackend(); we don't proceed until it answers.
  const { version } = await waitForBackend();

  const close = async (): Promise<void> => {
    const proc = app.process();
    const exited = new Promise<void>((resolve) => {
      if (proc.exitCode !== null) return resolve();
      proc.once('exit', () => resolve());
    });
    await app.close().catch(() => {});
    await Promise.race([
      exited,
      new Promise<void>((r) => setTimeout(r, 5_000)),
    ]);
  };

  return { app, page, backendVersion: version, close };
}
