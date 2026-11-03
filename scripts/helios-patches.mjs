// Source patches build-pyhelios.mjs applies to the helios-core submodule before
// compiling, for fixes Phytograph needs ahead of an upstream Helios release.
// Each is idempotent and recognizes when upstream has already fixed it.
// Pure functions, so they're unit-tested without building anything
// (scripts/helios-patches.test.mjs).

// See the comment at the call site in build-pyhelios.mjs: on macOS the
// visualizer's `find_package(X11 REQUIRED)` links Homebrew's X11 into
// libhelios for no reason, and those bottles require the build runner's macOS.
export const X11_PATCH_MARKER = '# [phytograph] no X11 on Apple';
const X11_ANCHOR = 'find_package(X11 REQUIRED)\nif(X11_FOUND)';

/** Guard the visualizer's X11 lookup on Apple. Returns {text, status}. */
export function patchVisualizerX11(text) {
  if (text.includes(X11_PATCH_MARKER)) return { text, status: 'already' };
  if (!text.includes(X11_ANCHOR)) return { text, status: 'absent' };
  return {
    text: text.replace(X11_ANCHOR,
      `${X11_PATCH_MARKER} (applied by Phytograph scripts/build-pyhelios.mjs)\n`
      + 'if(NOT APPLE)\n\tfind_package(X11 REQUIRED)\nendif()\nif(X11_FOUND)'),
    status: 'patched',
  };
}
