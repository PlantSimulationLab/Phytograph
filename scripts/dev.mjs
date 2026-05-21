// Dev runner: build main + preload once, start Vite for renderer,
// wait for it to listen, then launch Electron pointing at the dev URL.
// Restarts Electron when main/preload sources change.

import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import waitOn from 'wait-on';

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = join(__dirname, '..');

const RENDERER_URL = 'http://localhost:1427';

function run(cmd, args, opts = {}) {
  return spawn(cmd, args, { stdio: 'inherit', cwd: root, shell: process.platform === 'win32', ...opts });
}

async function runOnce(cmd, args) {
  const p = run(cmd, args);
  const [code] = await once(p, 'exit');
  if (code !== 0) throw new Error(`${cmd} ${args.join(' ')} exited with ${code}`);
}

(async () => {
  console.log('[dev] building main + preload...');
  await runOnce('npx', ['vite', 'build', '--config', 'vite.preload.config.ts']);
  await runOnce('npx', ['vite', 'build', '--config', 'vite.main.config.ts']);

  console.log('[dev] starting Vite renderer dev server...');
  const vite = run('npx', ['vite', '--config', 'vite.renderer.config.ts']);

  console.log(`[dev] waiting for ${RENDERER_URL}...`);
  await waitOn({ resources: [RENDERER_URL], timeout: 60_000, interval: 200, validateStatus: () => true });

  const electronBin = join(root, 'node_modules', '.bin', process.platform === 'win32' ? 'electron.cmd' : 'electron');
  if (!existsSync(electronBin)) {
    console.error('[dev] electron not installed. Run `npm install` first.');
    vite.kill('SIGTERM');
    process.exit(1);
  }

  console.log('[dev] launching Electron...');
  const electron = run(electronBin, ['.']);

  const shutdown = () => {
    try { electron.kill('SIGTERM'); } catch {}
    try { vite.kill('SIGTERM'); } catch {}
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
  electron.on('exit', () => { shutdown(); process.exit(0); });
})().catch((err) => {
  console.error('[dev] failed:', err);
  process.exit(1);
});
