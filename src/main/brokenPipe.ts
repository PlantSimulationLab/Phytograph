// Broken-stdio-pipe detection, extracted from logger.ts so it can be unit-tested
// without importing electron / electron-log.
//
// Why this is its own module: a dead stdout/stderr pipe (the controlling terminal
// closed, the system slept and tore down child processes, an SSH session dropped)
// makes the next console write throw EIO/EPIPE. If that escapes as an uncaught
// exception it triggers the fatal crash dialog → exit → relaunch → re-crash loop
// (the dialog/logging path re-writes the same dead pipe). Classifying these as
// recoverable is the load-bearing decision behind that fix, so it gets a test.

/** The error `code` if present and a string, else undefined. */
export function pipeErrCode(error: unknown): string | undefined {
  const code = (error as { code?: unknown })?.code;
  return typeof code === 'string' ? code : undefined;
}

/**
 * True for an I/O error from a dead stdio pipe (terminal closed, system sleep
 * killed child processes, SSH session dropped). These are recoverable: the file
 * transport still works, we just can't echo to a console nobody's reading.
 */
export function isBrokenPipe(error: unknown): boolean {
  const code = pipeErrCode(error);
  return code === 'EIO' || code === 'EPIPE';
}
