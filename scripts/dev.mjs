// Dev runner: build main + preload once, start Vite for renderer,
// wait for it to listen, then launch Electron pointing at the dev URL.
// Restarts Electron when main/preload sources change.
//
// Also spawns uvicorn with --reload against backend-api/venv on the same port
// (8008) the supervised PyInstaller bundle would normally use, so Python edits
// hot-reload in ~1s without a sidecar rebuild. Electron is told via the
// PHYTOGRAPH_DEV_BACKEND env var to skip its own backend supervision when this
// is in effect. Falls back to today's behavior (supervised bundle) if the
// backend venv isn't present.

import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import waitOn from 'wait-on';

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = join(__dirname, '..');

const RENDERER_URL = 'http://localhost:1427';
const BACKEND_URL = 'http://127.0.0.1:8008/version';
const isWin = process.platform === 'win32';
const backendDir = join(root, 'backend-api');
const venvPython = isWin
  ? join(backendDir, 'venv', 'Scripts', 'python.exe')
  : join(backendDir, 'venv', 'bin', 'python');

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

  let uvicorn = null;
  const electronEnv = { ...process.env };

  if (existsSync(venvPython)) {
    // Build the PyHelios native library up front if it's missing, so the first
    // API call that touches pyhelios doesn't trigger a silent multi-minute
    // compile inside the backend. The backend's own staleness check still
    // handles rebuilds after C++ edits; this just covers the cold-start case.
    const libName =
      process.platform === 'darwin' ? 'libhelios.dylib'
      : isWin ? 'libhelios.dll'
      : 'libhelios.so';
    const libPath = join(root, 'pyhelios', 'pyhelios_build', 'build', 'lib', libName);
    const pyheliosSrc = join(root, 'pyhelios', 'pyhelios', '__init__.py');
    if (existsSync(pyheliosSrc) && !existsSync(libPath)) {
      console.log('[dev] PyHelios native library missing — building from source (one-time, may take a few minutes)...');
      await runOnce('node', ['scripts/build-pyhelios.mjs']);
    }

    console.log('[dev] starting uvicorn --reload (backend) on port 8008...');
    // --reload-dir restricts watching to backend-api/ so edits under node_modules
    // or resources/ don't trigger restarts. uvicorn uses watchfiles when
    // available; it's installed in backend-api/venv.
    // Pipe stderr (rather than inherit) so we can drop the benign macOS objc
    // duplicate-class warnings: pyhelios's libhelios (visualizer plugin) and
    // open3d's pybind module each statically link GLFW, so loading both into the
    // backend process makes the Obj-C runtime warn that GLFWWindow et al. are
    // "implemented in both". The backend is headless and never opens a GLFW
    // window, so these are pure console noise. Match the specific pattern only —
    // genuine objc warnings (anything not a GLFW duplicate-class line) still pass
    // through. stdout stays inherited; everything else on stderr is re-emitted.
    const GLFW_DUP_WARNING = /^objc\[\d+\]: Class GLFW\w+ is implemented in both /;
    uvicorn = spawn(
      venvPython,
      ['-m', 'uvicorn', 'main:app', '--host', '127.0.0.1', '--port', '8008',
       '--reload', '--reload-dir', '.'],
      { stdio: ['inherit', 'inherit', 'pipe'], cwd: backendDir, env: process.env },
    );
    let stderrTail = '';
    uvicorn.stderr.on('data', (chunk) => {
      // Buffer partial lines so a warning split across two chunks still matches.
      const text = stderrTail + chunk.toString();
      const lines = text.split('\n');
      stderrTail = lines.pop(); // last element is the incomplete trailing line
      for (const line of lines) {
        if (!GLFW_DUP_WARNING.test(line)) process.stderr.write(line + '\n');
      }
    });
    uvicorn.stderr.on('end', () => {
      if (stderrTail && !GLFW_DUP_WARNING.test(stderrTail)) {
        process.stderr.write(stderrTail);
      }
    });
    uvicorn.on('exit', (code, signal) => {
      console.log(`[dev] uvicorn exited (code=${code}, signal=${signal})`);
    });
    electronEnv.PHYTOGRAPH_DEV_BACKEND = '1';
  } else {
    console.log(
      `[dev] backend venv not found at ${venvPython} — ` +
      'falling back to the supervised PyInstaller bundle. ' +
      'Create backend-api/venv to enable Python hot-reload.',
    );
  }

  console.log('[dev] starting Vite renderer dev server...');
  const vite = run('npx', ['vite', '--config', 'vite.renderer.config.ts']);

  console.log(`[dev] waiting for ${RENDERER_URL}...`);
  await waitOn({ resources: [RENDERER_URL], timeout: 60_000, interval: 200, validateStatus: () => true });

  if (uvicorn) {
    console.log(`[dev] waiting for ${BACKEND_URL}...`);
    // Use http-get: wait-on's default `http` probe sends HEAD, which FastAPI
    // doesn't auto-register for GET routes and answers with a noisy 405.
    await waitOn({
      resources: [`http-get://127.0.0.1:8008/version`],
      timeout: 120_000,
      interval: 300,
      validateStatus: (status) => status === 200,
    });
  }

  const electronBin = join(root, 'node_modules', '.bin', isWin ? 'electron.cmd' : 'electron');
  if (!existsSync(electronBin)) {
    console.error('[dev] electron not installed. Run `npm install` first.');
    vite.kill('SIGTERM');
    if (uvicorn) try { uvicorn.kill('SIGTERM'); } catch {}
    process.exit(1);
  }

  console.log('[dev] launching Electron...');
  const electron = spawn(electronBin, ['.'], { stdio: 'inherit', cwd: root, shell: isWin, env: electronEnv });

  const shutdown = () => {
    try { electron.kill('SIGTERM'); } catch {}
    try { vite.kill('SIGTERM'); } catch {}
    if (uvicorn) try { uvicorn.kill('SIGTERM'); } catch {}
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
  electron.on('exit', () => { shutdown(); process.exit(0); });
})().catch((err) => {
  console.error('[dev] failed:', err);
  process.exit(1);
});
