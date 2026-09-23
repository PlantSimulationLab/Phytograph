// Pins scripts/free-port.mjs: ports come from bands below every OS ephemeral
// range, the bands never overlap, and all three instance owners use it.
import { describe, it, expect, afterEach } from 'vitest';
import { createServer } from 'node:net';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { PORT_BANDS, e2eWorkerBand, findFreePort, canListen } from './free-port.mjs';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
// Lowest ephemeral port on any platform we ship: Linux 32768 (macOS/Windows 49152).
const LOWEST_EPHEMERAL = 32_768;

const held = [];
function hold(port) {
  return new Promise((resolve, reject) => {
    const srv = createServer();
    srv.once('error', reject);
    srv.listen(port, '127.0.0.1', () => { held.push(srv); resolve(srv); });
  });
}
afterEach(async () => {
  await Promise.all(held.splice(0).map((s) => new Promise((r) => s.close(r))));
});

describe('port bands', () => {
  it('sit entirely below every ephemeral range', () => {
    for (const band of Object.values(PORT_BANDS)) {
      expect(band.min).toBeGreaterThanOrEqual(1024);
      expect(band.max).toBeLessThanOrEqual(LOWEST_EPHEMERAL);
    }
  });

  it('never overlap, so an app, a dev session and E2E never probe the same port', () => {
    const bands = Object.values(PORT_BANDS).sort((a, b) => a.min - b.min);
    for (let i = 1; i < bands.length; i++) expect(bands[i].min).toBeGreaterThanOrEqual(bands[i - 1].max);
  });

  it('gives each of 12 Playwright workers a disjoint slice of the e2e band', () => {
    const slices = Array.from({ length: 12 }, (_, i) => e2eWorkerBand(i));
    for (const s of slices) {
      expect(s.min).toBeGreaterThanOrEqual(PORT_BANDS.e2e.min);
      expect(s.max).toBeLessThanOrEqual(PORT_BANDS.e2e.max);
    }
    for (let i = 1; i < slices.length; i++) expect(slices[i].min).toBe(slices[i - 1].max);
    expect(e2eWorkerBand(undefined)).toEqual(e2eWorkerBand(0));
    expect(e2eWorkerBand('1')).toEqual(slices[1]);
  });
});

describe('findFreePort', () => {
  it('returns a port inside the band that can actually be bound', async () => {
    const port = await findFreePort(PORT_BANDS.app);
    expect(port).toBeGreaterThanOrEqual(PORT_BANDS.app.min);
    expect(port).toBeLessThan(PORT_BANDS.app.max);
    expect(await canListen(port)).toBe(true);
  });

  it('skips a port something is already listening on', async () => {
    const band = { min: 30_990, max: 30_992 };
    await hold(30_990);
    for (let i = 0; i < 10; i++) expect(await findFreePort(band)).toBe(30_991);
  });

  it('never returns an excluded port (two picks in a row, as dev.mjs makes)', async () => {
    const band = { min: 30_993, max: 30_995 };
    for (let i = 0; i < 10; i++) expect(await findFreePort(band, { exclude: [30_993] })).toBe(30_994);
  });

  it('throws rather than looping when the band is full', async () => {
    await hold(30_996);
    await expect(findFreePort({ min: 30_996, max: 30_997 }, { tries: 5 })).rejects.toThrow(/no free port/);
  });
});

describe('every instance owner uses it', () => {
  it.each([
    ['src/main/backend.ts', 'PORT_BANDS.app'],
    ['scripts/dev.mjs', 'PORT_BANDS.dev'],
    ['tests/e2e/helpers/launchApp.ts', 'e2eWorkerBand('],
  ])('%s draws from its band and never binds :0', (file, band) => {
    const src = readFileSync(join(root, file), 'utf8');
    expect(src).toMatch(/from '[./]*(?:scripts\/)?free-port\.mjs'/);
    expect(src).toContain(band);
    expect(src).not.toMatch(/\.listen\(\s*0\b/);
  });
});
