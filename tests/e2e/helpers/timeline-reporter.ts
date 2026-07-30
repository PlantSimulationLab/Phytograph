import { appendFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { dirname, relative } from 'node:path';
import type { Reporter, TestCase, TestResult } from '@playwright/test/reporter';

/**
 * Writes a JSONL span per test so `scripts/monitor-resources.mjs` can say WHICH
 * spec was running when the machine ran out of memory or pinned every core.
 *
 * Opt-in: playwright.config.ts only registers this reporter when
 * PHYTOGRAPH_E2E_TIMELINE names an output file, so a plain `npm run test:e2e`
 * is unchanged. `npm run test:e2e:profile` sets it.
 *
 * Spans overlap — the suite runs 2 workers — so the monitor credits a sample to
 * every span in flight at that instant and reports the overlap.
 */
export default class TimelineReporter implements Reporter {
  private readonly path = process.env.PHYTOGRAPH_E2E_TIMELINE ?? '';

  onBegin(): void {
    if (!this.path) return;
    mkdirSync(dirname(this.path), { recursive: true });
    writeFileSync(this.path, '');
  }

  onTestEnd(test: TestCase, result: TestResult): void {
    if (!this.path) return;
    const start = result.startTime.getTime();
    appendFileSync(
      this.path,
      JSON.stringify({
        type: 'test',
        file: relative(process.cwd(), test.location.file),
        title: test.title,
        worker: result.workerIndex,
        status: result.status,
        start,
        end: start + result.duration,
      }) + '\n',
    );
  }
}
