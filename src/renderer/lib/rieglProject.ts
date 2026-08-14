// Is this dropped/opened path a RIEGL raw project directory?
//
// A .riproject is a DIRECTORY, and react-dropzone expands a dropped folder into
// its contents — so by the time `onDrop` runs it has become ~100 .rxp/.jpg/.ppm
// files that the generic point-cloud importer rejects one by one
// ("Unsupported file format: .ppm"). The capture phase sees the un-expanded
// entry, and this is the test it applies there.
//
// Deliberately anchored to the END of the path: a file INSIDE the project must
// never match, or a single stray .rxp would be mistaken for the whole project.
export function isRieglProjectPath(path: string | undefined | null): boolean {
  if (!path) return false;
  return /\.riproject\/?$/i.test(path);
}

/**
 * Pull the position counter out of a RIEGL import progress message.
 *
 * The backend decodes and builds every scan position itself, so the renderer
 * has no independent view of how far along the import is — the counter is
 * driven entirely from the `[N/M]` prefix these messages carry. Without it the
 * dialog sat on "1 of 6" for a whole six-position import and finished about a
 * fifth of the way along the bar.
 *
 * Returns null for messages with no prefix (e.g. the metadata phase), which the
 * caller treats as "leave the counter where it is".
 */
export function parseRieglProgress(
  message: string,
): { current: number; total: number; label: string } | null {
  const m = /^\[(\d+)\/(\d+)\]\s*/.exec(message);
  if (!m) return null;
  return {
    current: Number(m[1]),
    total: Number(m[2]),
    label: message.slice(m[0].length),
  };
}
