/**
 * A picked file standing in for itself with only its header.
 *
 * File → Import hands the import handlers a path AND a `File`. Every
 * path-backed import (point clouds, OBJ/PLY meshes, scan XML, QSM CSV) reads
 * the file by path in the backend, so the `File` is consulted only for its
 * name and a header sniff (`plyHasFaces` / `isQsmCsvFile` read the first
 * 64 KB). Reading each whole file into the renderer for that cost a full copy
 * per selected file, held for the whole import, and Node's readFile refuses
 * anything over 2 GiB: a large scan failed with "Failed to read" before its
 * import started, while a drag-drop of the same file worked.
 *
 * So the browser's picks become header-only Files, remembered here with their
 * path, and `wholeFile` swaps in the full bytes for the few imports that do
 * parse in the renderer (skeletons, STL and other local mesh formats, the
 * no-backend mesh fallback, a non-octree point format). Every other File,
 * including a dropped one, passes through untouched.
 */

/** What a header sniff reads (`plyHasFaces`, `isQsmCsvFile`). */
export const HEADER_BYTES = 64 * 1024;

const headerOnlyPaths = new WeakMap<File, string>();

/**
 * A File of `head` (the first bytes of the file at `path`). When `head` is
 * shorter than `HEADER_BYTES` it already IS the whole file, so it comes back
 * as an ordinary File with nothing left to read.
 */
export function headerOnlyFile(head: ArrayBuffer, name: string, path: string): File {
  const file = new File([head], name);
  if (head.byteLength >= HEADER_BYTES) headerOnlyPaths.set(file, path);
  return file;
}

export function isHeaderOnly(file: File): boolean {
  return headerOnlyPaths.has(file);
}

/** `file` with all of its bytes: read by path if it was header-only. */
export async function wholeFile(
  file: File,
  readAll: (path: string) => Promise<ArrayBuffer>,
): Promise<File> {
  const path = headerOnlyPaths.get(file);
  if (path === undefined) return file;
  return new File([await readAll(path)], file.name);
}
