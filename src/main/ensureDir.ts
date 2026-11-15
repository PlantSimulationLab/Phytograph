// Make sure a directory exists before writing a file into it, without failing
// on one that already does.
//
// `mkdir(dir, { recursive: true })` is meant to succeed on an existing
// directory, and on POSIX it does. On Windows it throws for a DRIVE ROOT: saving
// the log export as `D:\phytograph-logs.txt` failed with
// `EPERM: operation not permitted, mkdir 'D:\'` (issue #7's attached log shows
// it twice, before the user picked a folder instead). The root obviously
// exists; Node's recursive mkdir just cannot "create" it. So check first, and if
// mkdir still fails, accept it when the directory is there after all.

import { mkdir as fsMkdir, stat as fsStat } from 'node:fs/promises';

type Mkdir = (dir: string, opts: { recursive: true }) => Promise<unknown>;
type Stat = (p: string) => Promise<{ isDirectory(): boolean }>;

async function isDirectory(dir: string, stat: Stat): Promise<boolean> {
  try {
    return (await stat(dir)).isDirectory();
  } catch {
    return false;
  }
}

/** Create `dir` (and its parents) unless it already exists. `mkdir`/`stat` are
 *  injectable only so a test can reproduce Windows' drive-root behavior. */
export async function ensureDir(
  dir: string,
  mkdir: Mkdir = fsMkdir as Mkdir,
  stat: Stat = fsStat,
): Promise<void> {
  if (await isDirectory(dir, stat)) return;
  try {
    await mkdir(dir, { recursive: true });
  } catch (err) {
    if (await isDirectory(dir, stat)) return;
    throw err;
  }
}
