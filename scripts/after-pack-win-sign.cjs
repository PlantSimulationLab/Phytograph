// electron-builder afterPack hook: signs every native library in the unpacked
// Windows app that does not already carry a valid signature.
//
// The release workflow signs the two sidecar trees itself, before
// electron-builder runs. That cannot reach Electron's own DLLs (ffmpeg.dll,
// libEGL.dll, libGLESv2.dll, vk_swiftshader.dll, vulkan-1.dll): they do not
// exist until electron-builder unpacks Electron, and by the time it returns
// they are already inside the installer, whose hash is already in latest.yml.
// afterPack is the one moment in between — the app directory is complete, and
// neither the executables nor the installer have been signed yet.
//
// It scans the WHOLE app directory rather than just the Electron files, so it
// is also the last check before anything is published: the sidecar libraries
// are already signed and cost one read each, and a library that slipped
// through fails the build here instead of after `--publish always`.
//
// Skipped off Windows and when Azure credentials are absent, on the same
// terms as the installer signing in run-electron-builder.mjs — a local
// `npm run package:win` still produces an unsigned build.

const { spawnSync } = require('node:child_process');
const path = require('node:path');

// A property on the module so the unit test can substitute a fake runner;
// electron-builder always gets the real one.
exports._run = (command, args) => spawnSync(command, args, { stdio: 'inherit' });

exports.default = async function afterPackWinSign(context) {
  if (context.electronPlatformName !== 'win32') return;

  const { azureSigningDecision } = await import('./azure-sign-config.mjs');
  const decision = azureSigningDecision(process.env);
  if (!decision.enabled) {
    console.log(`[win-sign] native libraries not signed: ${decision.reason}`);
    return;
  }
  if (process.platform !== 'win32') {
    // signtool and the TrustedSigning module exist only on Windows.
    console.log('[win-sign] native libraries not signed: not building on Windows.');
    return;
  }

  console.log(`[win-sign] signing native libraries in ${context.appOutDir}`);
  const script = path.join(__dirname, 'sign-win-natives.ps1');
  const result = exports._run('pwsh', [
    '-NoProfile',
    '-NonInteractive',
    '-ExecutionPolicy',
    'Bypass',
    '-File',
    script,
    '-Roots',
    context.appOutDir,
  ]);
  if (result.error) {
    throw new Error(`[win-sign] could not run PowerShell: ${result.error.message}`);
  }
  if (result.status !== 0) {
    // Throwing stops electron-builder before it signs, packages or publishes.
    throw new Error(`[win-sign] signing native libraries failed (exit ${result.status}); see the output above.`);
  }
};
