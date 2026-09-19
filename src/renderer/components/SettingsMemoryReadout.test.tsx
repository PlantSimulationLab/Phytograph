/**
 * The Settings memory-budget READOUT: what "auto" actually resolved to.
 *
 * `GET /health` has always reported `budget_bytes` / `budget_source` — its own
 * docstring says it exists so "the renderer's diagnostics" can explain a queued
 * operation — and nothing read it. So a user who left the field blank had no way
 * to learn whether they got half of 64 GB, half of 8 GB, or the 4 GB fallback
 * that applies when RAM cannot be measured at all; and a user who typed a value
 * could not confirm it took effect. This pins what the readout says in each of
 * those cases.
 *
 * A separate file from SettingsDialog.test.tsx because that one mocks the whole
 * backendApi module with a REJECTING getMemoryBudget (it is about the RIEGL
 * controls), and the value under test here is the resolved one.
 */
import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, cleanup } from '@testing-library/react';
import type { MemoryBudgetInfo } from '../utils/backendApi';

vi.mock('../lib/store', () => ({
  getSettings: vi.fn().mockResolvedValue({
    theme: 'dark',
    triangulateMaxPoints: 1_000_000,
    defaultBackgroundColor: 'black',
    defaultPointSize: 1,
    scanMarkerScale: 1,
    missDistanceThreshold: 1001,
  }),
  updateSettings: vi.fn().mockResolvedValue(undefined),
}));

let nextMemory: MemoryBudgetInfo | Error;
vi.mock('../utils/backendApi', () => ({
  buildRieglImage: vi.fn().mockResolvedValue({ ok: true, image: 'x' }),
  describeBackendError: (e: unknown) => ({ message: String(e) }),
  getMemoryBudget: vi.fn(() =>
    nextMemory instanceof Error ? Promise.reject(nextMemory) : Promise.resolve(nextMemory),
  ),
}));

vi.mock('./RieglStatusBadge', () => ({
  RieglStatusBadge: () => <span data-testid="riegl-status-badge" />,
}));

import { SettingsDialog } from './SettingsDialog';

const GiB = 1024 ** 3;

/** Auto on a 16 GB laptop with plenty free: budget is half of RAM. */
const AUTO: MemoryBudgetInfo = {
  physicalBytes: 16 * GiB,
  availableBytes: 12 * GiB,
  rssBytes: 1 * GiB,
  budgetBytes: 8 * GiB,
  admissionBytes: 8 * GiB,
  fraction: 0.5,
  source: 'fraction',
  psutil: true,
};

const open = () => render(<SettingsDialog isOpen onClose={() => {}} />);
const readout = () => screen.findByTestId('settings-memory-budget-detected');

beforeEach(() => {
  nextMemory = AUTO;
});
afterEach(() => cleanup());

describe('Settings — detected memory budget', () => {
  it('names the auto budget and the RAM it was derived from', async () => {
    const el = await readoutAfterOpen();
    // Both numbers matter: the budget is what the app will use, and the
    // physical total is what makes "half of this machine's RAM" checkable.
    expect(el.textContent).toMatch(/Auto/);
    expect(el.textContent).toMatch(/8 GB/);
    expect(el.textContent).toMatch(/16 GB detected/);
  });

  it('scales with the machine rather than printing a constant', async () => {
    // The whole point of the fraction: the same build must report a different
    // budget on a workstation. A hard-coded string would pass the test above.
    nextMemory = {
      ...AUTO,
      physicalBytes: 128 * GiB,
      availableBytes: 100 * GiB,
      budgetBytes: 64 * GiB,
      admissionBytes: 64 * GiB,
    };
    const el = await readoutAfterOpen();
    expect(el.textContent).toMatch(/64 GB/);
    expect(el.textContent).toMatch(/128 GB detected/);
    // \b so "128 GB detected" does not satisfy a bare /8 GB/ by substring.
    expect(el.textContent).not.toMatch(/\b8 GB/);
  });

  it('says the value was set here when the budget is pinned', async () => {
    // A user who typed a number needs to see it took effect — `source: 'env'`
    // is the only signal that distinguishes it from a coincidental auto value.
    nextMemory = { ...AUTO, budgetBytes: 6 * GiB, admissionBytes: 6 * GiB, source: 'env' };
    const el = await readoutAfterOpen();
    expect(el.textContent).toMatch(/6 GB/);
    expect(el.textContent).toMatch(/set here/);
    expect(el.textContent).not.toMatch(/Auto/);
    expect(el.textContent).not.toMatch(/detected/);
  });

  it('reports the lower figure that free memory currently allows', async () => {
    // The laptop case this whole change exists for: 8 GB budgeted, 2.4 GB free,
    // so concurrent work is admitted against ~1.7 GB. Showing only the budget
    // would explain neither the queueing nor the slowness.
    nextMemory = { ...AUTO, availableBytes: 2.4 * GiB, admissionBytes: 1.7 * GiB };
    const el = await readoutAfterOpen();
    expect(el.textContent).toMatch(/8 GB/);
    expect(el.textContent).toMatch(/1\.7 GB/);
    expect(el.textContent).toMatch(/limited by free memory/);
  });

  it('stays silent about free memory when it is not the constraint', async () => {
    const el = await readoutAfterOpen();
    expect(el.textContent).not.toMatch(/limited by free memory/);
  });

  it('flags a budget derived without a real RAM measurement', async () => {
    // psutil missing means the 4 GB unmeasurable fallback or an os.sysconf
    // guess — the one case where the number should not be taken at face value.
    nextMemory = {
      ...AUTO, physicalBytes: 0, availableBytes: 0, budgetBytes: 4 * GiB,
      admissionBytes: 4 * GiB, psutil: false,
    };
    const el = await readoutAfterOpen();
    expect(el.textContent).toMatch(/4 GB/);
    expect(el.textContent).toMatch(/could not be measured/);
  });

  it('omits the readout entirely when the backend cannot be reached', async () => {
    // Better than a wrong number: the field still works, it just says nothing.
    nextMemory = new Error('backend down');
    open();
    await screen.findByTestId('settings-memory-budget');
    expect(screen.queryByTestId('settings-memory-budget-detected')).toBeNull();
  });
});

async function readoutAfterOpen() {
  open();
  return readout();
}
