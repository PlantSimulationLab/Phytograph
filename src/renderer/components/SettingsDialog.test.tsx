import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { useEffect } from 'react';
import { render, screen, cleanup } from '@testing-library/react';
import type { RieglStatus } from '../utils/backendApi';

// Only the RIEGL reader-image controls are exercised here. The rest of the
// dialog is plain persisted settings, covered by E2E per the component rule in
// CLAUDE.md — but the button's VISIBILITY is worth pinning at this layer,
// because it was wrong in a way E2E could never have caught: the state that
// hides it needs a Docker image built by an older Phytograph, which no CI
// machine has.

vi.mock('../lib/store', () => ({
  getSettings: vi.fn().mockResolvedValue({
    rivlibPath: '/opt/rivlib',
    theme: 'dark',
    triangulateMaxPoints: 1_000_000,
    defaultBackgroundColor: 'black',
    defaultPointSize: 1,
    scanMarkerScale: 1,
    missDistanceThreshold: 1001,
  }),
  updateSettings: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('../utils/backendApi', () => ({
  buildRieglImage: vi.fn().mockResolvedValue({ ok: true, image: 'x' }),
  describeBackendError: (e: unknown) => ({ message: String(e) }),
}));

// Stand in for the badge so the test drives the status directly instead of
// through a fetch: this file is about what the dialog DOES with a status.
let nextStatus: RieglStatus;
vi.mock('./RieglStatusBadge', () => ({
  RieglStatusBadge: ({ onStatus }: { onStatus?: (s: RieglStatus | null) => void }) => {
    // In an effect, not during render: the real badge reports from a resolved
    // fetch, and calling the parent's setter mid-render is a React warning.
    useEffect(() => onStatus?.(nextStatus), [onStatus]);
    return <span data-testid="riegl-status-badge" />;
  },
}));

import { SettingsDialog } from './SettingsDialog';

const BASE: RieglStatus = {
  available: true,
  platformSupported: true,
  dockerPresent: true,
  imageBuilt: true,
  imageStale: false,
  rivlibPath: '/opt/rivlib',
  rivlibValid: true,
  image: 'phytograph-riegl:latest',
  reason: 'RIEGL .rxp import is ready.',
};

beforeEach(() => {
  nextStatus = BASE;
});
afterEach(() => cleanup());

const open = () => render(<SettingsDialog isOpen onClose={() => {}} />);

describe('SettingsDialog — RIEGL reader image', () => {
  it('offers no build button when the image is current', async () => {
    open();
    await screen.findByTestId('settings-rivlib-path');
    expect(screen.queryByTestId('settings-riegl-build-image')).toBeNull();
    // Nothing to fix, so no checklist either.
    expect(screen.queryByTestId('settings-riegl-checklist')).toBeNull();
  });

  it('offers a REBUILD when the image was built by an older Phytograph', async () => {
    // The exact state that used to hide the button: the import fails telling
    // the user to press "Build reader image", and Settings shows no such
    // button, because an out-of-date image still counts as built.
    nextStatus = {
      ...BASE,
      available: false,
      imageStale: true,
      reason: 'The RIEGL reader image is out of date …',
    };
    open();

    const btn = await screen.findByTestId('settings-riegl-build-image');
    expect(btn.textContent).toMatch(/rebuild reader image/i);

    // And the checklist names the reason rather than reading as a broken setup.
    const row = await screen.findByTestId('settings-riegl-check-image');
    expect(row.dataset.ok).toBe('false');
    expect(row.textContent).toMatch(/older version/i);
    expect(row.textContent).toMatch(/automatically/i);
    // The prerequisites are still satisfied — the image is the only gap.
    expect(
      (await screen.findByTestId('settings-riegl-check-docker')).dataset.ok,
    ).toBe('true');
    expect(
      (await screen.findByTestId('settings-riegl-check-rivlib')).dataset.ok,
    ).toBe('true');
  });

  it('offers a first BUILD when no image exists at all', async () => {
    nextStatus = {
      ...BASE,
      available: false,
      imageBuilt: false,
      imageStale: false,
      reason: 'The RIEGL reader image has not been built yet.',
    };
    open();

    const btn = await screen.findByTestId('settings-riegl-build-image');
    expect(btn.textContent).toMatch(/^build reader image$/i);
  });

  it('hides the button while a prerequisite is unmet', async () => {
    // Building without a usable RiVLib would "succeed" and leave the feature
    // off, which reads as a broken build — so the prerequisite comes first.
    nextStatus = {
      ...BASE,
      available: false,
      imageStale: true,
      rivlibValid: false,
      reason: 'No lib/libscanifc.so …',
    };
    open();

    await screen.findByTestId('settings-riegl-checklist');
    expect(screen.queryByTestId('settings-riegl-build-image')).toBeNull();
  });
});
