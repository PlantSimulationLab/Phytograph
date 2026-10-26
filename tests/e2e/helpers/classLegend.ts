import { expect, type Page } from '@playwright/test';

/**
 * Wait for the categorical class legend, and when it never comes, say why.
 *
 * The legend is drawn for every VISIBLE cloud colored by a class column whose
 * data range resolves (PointCloudViewer's `legendDescriptors`). On Linux CI it
 * has gone missing right after a segment + split with every request
 * succeeding, and passed locally every time, so the failure message carries
 * each cloud's color mode, field, ranges and visibility
 * (`__cloudColorDomains`): no visible cloud, a channel that never switched,
 * and a null range are three different bugs.
 */
export async function expectClassLegend(page: Page, timeout = 60_000): Promise<void> {
  try {
    await expect(page.getByTestId('class-legend')).toBeVisible({ timeout });
  } catch (err) {
    const state = await page.evaluate(() => {
      const domains = (window as any).__cloudColorDomains?.() ?? '(no __cloudColorDomains hook)';
      const rows = [...document.querySelectorAll<HTMLElement>('[data-testid="scan-row"]')].map((r) => ({
        name: r.dataset.scanName,
        visible: r.dataset.visible,
        selected: r.dataset.selected,
        points: r.dataset.pointCount,
      }));
      return { domains, rows };
    }).catch((e) => `(could not read viewer state: ${e})`);
    throw new Error(`${(err as Error).message}\n\nviewer state when the legend never appeared:\n${JSON.stringify(state, null, 2)}`);
  }
}
