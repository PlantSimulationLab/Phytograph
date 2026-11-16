// What the renderer may ask the OS to open via `shell.openExternal`.
//
// The renderer uses it for exactly two things: an https page (a GitHub issue,
// the docs) and a mailto: link for feedback. `openExternal` hands any URL to the
// OS, which opens a `file:` URL with its default app, runs registered protocol
// handlers, and on Windows can launch an executable — so a compromised renderer
// could use it to run things. Anything but those two schemes is refused.

const ALLOWED_SCHEMES = new Set(['https:', 'mailto:']);

export function isAllowedExternalUrl(url: unknown): url is string {
  if (typeof url !== 'string') return false;
  try {
    return ALLOWED_SCHEMES.has(new URL(url).protocol);
  } catch {
    return false;
  }
}
