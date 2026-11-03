// The per-launch secret between this app and its backend.
//
// The backend can read and overwrite any path the user can, so "it only binds
// 127.0.0.1" is not a boundary: another local account can reach that port, and
// so can a web page that rebinds its own domain to 127.0.0.1. The backend's
// Host and Origin checks stop the page; this stops everything that is not this
// app. Deliberately electron-free so it is unit-testable.
//
// `npm run dev` pins it through the environment, because there uvicorn and
// Electron are started side by side and must agree, exactly as they do on the
// port. Every other launch mints its own.
import { randomBytes } from 'node:crypto';

let token: string | null = null;

export function getBackendToken(env: NodeJS.ProcessEnv = process.env): string {
  if (token === null) token = env.PHYTOGRAPH_BACKEND_TOKEN || randomBytes(32).toString('hex');
  return token;
}

/** Whether the backend on `port` accepts `candidate`. /version stays open, so
 *  it cannot answer this; a port held by another instance answers it with 401. */
export async function backendAcceptsToken(port: number, candidate: string): Promise<boolean> {
  try {
    const res = await fetch(`http://127.0.0.1:${port}/api/token-check`, {
      headers: { 'X-Phytograph-Token': candidate },
      signal: AbortSignal.timeout(2000),
    });
    return res.ok;
  } catch {
    return false;
  }
}
