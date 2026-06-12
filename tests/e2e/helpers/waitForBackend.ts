// Polls GET /version on the supervised backend, mirroring the timing contract
// of src/renderer/hooks/useBackendReady.ts (120s ceiling, 1s interval).
// Used from the Playwright Node side, not from inside the renderer.

export interface VersionPayload {
  version: string;
  status?: string;
}

export async function waitForBackend(
  port: number,
  timeoutMs = 120_000,
  intervalMs = 1_000,
): Promise<VersionPayload> {
  const baseUrl = `http://127.0.0.1:${port}`;
  const startedAt = Date.now();

  while (Date.now() - startedAt < timeoutMs) {
    try {
      const res = await fetch(`${baseUrl}/version`, {
        signal: AbortSignal.timeout(2_000),
      });
      if (res.ok) {
        return (await res.json()) as VersionPayload;
      }
    } catch {
      // connection refused / timeout — backend not up yet
    }
    await new Promise((r) => setTimeout(r, intervalMs));
  }

  throw new Error(
    `Backend at ${baseUrl} did not become ready within ${timeoutMs}ms. ` +
      `If the PyInstaller backend isn't built, run \`npm run build:backend\`. ` +
      `Mocks are not allowed — see CLAUDE.md Testing rule #1.`,
  );
}
