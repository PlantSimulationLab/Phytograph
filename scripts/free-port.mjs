// Single source of truth for choosing a free localhost port, shared by the
// packaged app's backend supervisor (src/main/backend.ts), the dev session
// (scripts/dev.mjs) and E2E launches (tests/e2e/helpers/launchApp.ts).
//
// NOT `listen(0)`, which all three used to do. That returns a port from the
// OS's EPHEMERAL range — the same pool every outgoing TCP connection draws its
// local port from — and the port is only free until the probe closes. Anything
// that makes a localhost connection in the gap before the real server binds can
// be handed that exact port as its local end and hold it for the life of the
// connection. It happened on the Linux CI runner: the backend's pinned port
// 46141 was taken that way, all four binds failed with "[Errno 98] address
// already in use", and the spec timed out at startup. The supervisor respawns
// on the SAME port (the renderer has already cached it), so in the packaged app
// that race is a backend that never comes up.
//
// So ports are probed BELOW every ephemeral range (Linux 32768+, macOS and
// Windows 49152+), where the OS never assigns one to a connection, and each
// owner draws from its own band so a desktop app, a dev session and E2E workers
// never even consider the same number:
//
//   app  10000-14999   packaged backend
//   dev  15000-19999   dev backend + Vite renderer
//   e2e  20000-31999   one 1000-port slice per Playwright worker (12 slices)
//
// The probe only proves nobody is LISTENING right now; that is all a bind needs
// once connections can no longer be assigned the port behind our back.

import { createServer } from 'node:net';

export const PORT_BANDS = Object.freeze({
  app: Object.freeze({ min: 10_000, max: 15_000 }),
  dev: Object.freeze({ min: 15_000, max: 20_000 }),
  e2e: Object.freeze({ min: 20_000, max: 32_000 }),
});

/** The disjoint slice of the e2e band for one Playwright worker. */
export function e2eWorkerBand(parallelIndex) {
  const slices = 12;
  const size = (PORT_BANDS.e2e.max - PORT_BANDS.e2e.min) / slices;
  const i = ((Number(parallelIndex) || 0) % slices + slices) % slices;
  const min = PORT_BANDS.e2e.min + i * size;
  return { min, max: min + size };
}

/** Whether something could bind `port` on `host` right now. */
export function canListen(port, host = '127.0.0.1') {
  return new Promise((resolve) => {
    const srv = createServer();
    srv.once('error', () => resolve(false));
    srv.listen(port, host, () => srv.close(() => resolve(true)));
  });
}

/**
 * A random free port in [min, max), never one listed in `exclude` (a caller
 * choosing two ports in a row must exclude the first: its probe has closed, so
 * the second probe would happily pick it again).
 */
export async function findFreePort({ min, max }, { exclude = [], tries = 200, host = '127.0.0.1' } = {}) {
  if (!(Number.isInteger(min) && Number.isInteger(max) && min > 0 && max > min)) {
    throw new Error(`findFreePort: bad band [${min}, ${max})`);
  }
  const skip = new Set(exclude);
  for (let i = 0; i < tries; i++) {
    const port = min + Math.floor(Math.random() * (max - min));
    if (skip.has(port)) continue;
    if (await canListen(port, host)) return port;
  }
  throw new Error(`findFreePort: no free port in [${min}, ${max}) after ${tries} tries`);
}
