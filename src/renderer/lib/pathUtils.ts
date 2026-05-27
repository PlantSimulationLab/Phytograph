// Pure-string path helpers usable from the renderer. We can't pull in Node's
// `path` module here, and round-tripping through IPC for every dirname is
// unnecessary — the OS-native paths returned by `dialog.open` use `/` on
// posix and `\` on win32, and these utilities handle both.

const SEP_RE = /[\\/]/;

export function isAbsolute(p: string): boolean {
  if (!p) return false;
  if (p.startsWith('/')) return true;                            // posix
  if (/^[A-Za-z]:[\\/]/.test(p)) return true;                    // Windows drive letter
  if (p.startsWith('\\\\')) return true;                         // UNC
  return false;
}

export function dirname(p: string): string {
  if (!p) return '';
  // Trim a single trailing separator (but not the root itself).
  const trimmed = p.length > 1 && (p.endsWith('/') || p.endsWith('\\'))
    ? p.slice(0, -1)
    : p;
  // Find the last separator.
  let i = trimmed.length - 1;
  while (i >= 0 && !SEP_RE.test(trimmed[i])) i--;
  if (i < 0) return '.';
  if (i === 0) return trimmed[0];                                // posix root "/"
  return trimmed.slice(0, i);
}

export function basename(p: string): string {
  if (!p) return '';
  const trimmed = p.length > 1 && (p.endsWith('/') || p.endsWith('\\'))
    ? p.slice(0, -1)
    : p;
  let i = trimmed.length - 1;
  while (i >= 0 && !SEP_RE.test(trimmed[i])) i--;
  return trimmed.slice(i + 1);
}

// Naive join: if `child` is absolute, return it; otherwise concatenate with
// the parent's separator style. Doesn't normalise `..` segments — the
// downstream fs:exists check will resolve them per the OS.
export function joinPath(parent: string, child: string): string {
  if (isAbsolute(child)) return child;
  if (!parent) return child;
  // Prefer the parent's existing separator style. Default to `/`.
  const sep = parent.includes('\\') && !parent.includes('/') ? '\\' : '/';
  const trimmedParent = parent.endsWith('/') || parent.endsWith('\\')
    ? parent.slice(0, -1)
    : parent;
  return `${trimmedParent}${sep}${child}`;
}
