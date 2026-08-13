import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, waitFor, cleanup } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { RieglProjectDialog } from './RieglProjectDialog';

// The dialog runs the inspect itself (so its spinner covers the wait and a 503
// surfaces inline), which makes the backend call the one thing to stub.
vi.mock('../utils/backendApi', () => ({
  inspectRieglProject: vi.fn(),
}));
import { inspectRieglProject } from '../utils/backendApi';

const PROJECT = {
  project: '/data/2018-02-23.002.riproject',
  rivlib_version: '7.1.0',
  scan_count: 3,
  gnss_anchor: { latitude: 38.3253871, longitude: -121.5779673, height_m: -26.16 },
  registered: false,
  scans: [
    {
      name: 'ScanPos001',
      point_count_probed: 2_000_000,
      instrument: { model: 'VZ-1000' },
      scan_params: { origin: [6.7, 0.76, -0.57] as [number, number, number], theta_min: 30, theta_max: 130, phi_min: 0, phi_max: 360 },
      gnss: { latitude: 38.325394, longitude: -121.5778907, height_m: -26.7, height_datum: 'ellipsoidal' },
      enu: { east_m: 6.7, north_m: 0.76, up_m: -0.57 },
    },
    {
      name: 'ScanPos002',
      point_count_probed: 2_000_000,
      instrument: { model: 'VZ-1000' },
      gnss: { latitude: 38.325345, longitude: -121.5779094, height_m: -26.4, height_datum: 'ellipsoidal' },
      enu: { east_m: 4.72, north_m: -4.57, up_m: 0.34 },
    },
    { name: 'ScanPos003', error: 'unreadable stream' },
  ],
};

beforeEach(() => {
  vi.mocked(inspectRieglProject).mockResolvedValue(PROJECT as never);
});
afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe('RieglProjectDialog', () => {
  it('renders nothing until a project is opened', () => {
    render(<RieglProjectDialog projectPath={null} rivlibPath="/riv" onResolve={vi.fn()} />);
    expect(screen.queryByTestId('riegl-project-dialog')).toBeNull();
    expect(inspectRieglProject).not.toHaveBeenCalled();
  });

  it('lists the scan positions once inspect resolves', async () => {
    render(<RieglProjectDialog projectPath="/p.riproject" rivlibPath="/riv" onResolve={vi.fn()} />);
    expect(screen.getByTestId('riegl-dialog-loading')).toBeTruthy();
    await waitFor(() => expect(screen.getByTestId('riegl-scan-row-ScanPos001')).toBeTruthy());
    expect(screen.getByTestId('riegl-scan-row-ScanPos002')).toBeTruthy();
    // Scoped to one row: every position reports the same instrument, so a bare
    // getByText would match several nodes.
    expect(
      screen.getByTestId('riegl-scan-row-ScanPos001').textContent,
    ).toMatch(/VZ-1000/);
    // The .pat sweep is what tells the user this position is worth importing.
    expect(
      screen.getByTestId('riegl-scan-row-ScanPos001').textContent,
    ).toMatch(/30–130°/);
  });

  it('preselects readable positions but never a failed one', async () => {
    render(<RieglProjectDialog projectPath="/p.riproject" rivlibPath="/riv" onResolve={vi.fn()} />);
    await waitFor(() => expect(screen.getByTestId('riegl-scan-row-ScanPos001')).toBeTruthy());
    expect(screen.getByTestId('riegl-scan-row-ScanPos001').dataset.selected).toBe('true');
    // A position that couldn't be read must not be importable — selecting it
    // would produce an extraction that fails halfway through.
    expect(screen.getByTestId('riegl-scan-row-ScanPos003').dataset.selected).toBe('false');
    expect(
      screen.getByTestId<HTMLInputElement>('riegl-scan-check-ScanPos003').disabled,
    ).toBe(true);
  });

  it('resolves with exactly the checked positions', async () => {
    const onResolve = vi.fn();
    render(<RieglProjectDialog projectPath="/p.riproject" rivlibPath="/riv" onResolve={onResolve} />);
    await waitFor(() => expect(screen.getByTestId('riegl-scan-row-ScanPos001')).toBeTruthy());

    await userEvent.click(screen.getByTestId('riegl-scan-check-ScanPos002'));
    await userEvent.click(screen.getByTestId('riegl-dialog-import'));

    expect(onResolve).toHaveBeenCalledWith(['ScanPos001']);
  });

  it('resolves null on cancel so the caller imports nothing', async () => {
    const onResolve = vi.fn();
    render(<RieglProjectDialog projectPath="/p.riproject" rivlibPath="/riv" onResolve={onResolve} />);
    await waitFor(() => expect(screen.getByTestId('riegl-dialog-close')).toBeTruthy());
    await userEvent.click(screen.getByTestId('riegl-dialog-close'));
    expect(onResolve).toHaveBeenCalledWith(null);
  });

  it('blocks import when nothing is selected', async () => {
    const onResolve = vi.fn();
    render(<RieglProjectDialog projectPath="/p.riproject" rivlibPath="/riv" onResolve={onResolve} />);
    await waitFor(() => expect(screen.getByTestId('riegl-scan-row-ScanPos001')).toBeTruthy());

    await userEvent.click(screen.getByTestId('riegl-scan-check-ScanPos001'));
    await userEvent.click(screen.getByTestId('riegl-scan-check-ScanPos002'));

    const importBtn = screen.getByTestId<HTMLButtonElement>('riegl-dialog-import');
    expect(importBtn.disabled).toBe(true);
    await userEvent.click(importBtn);
    expect(onResolve).not.toHaveBeenCalled();
  });

  it('always warns that raw scans are unregistered', async () => {
    // The single most surprising property of raw RIEGL data. If this warning
    // ever disappears, users get a pile of coincident clouds with no
    // explanation.
    render(<RieglProjectDialog projectPath="/p.riproject" rivlibPath="/riv" onResolve={vi.fn()} />);
    await waitFor(() => expect(screen.getByTestId('riegl-unregistered-warning')).toBeTruthy());
    expect(screen.getByTestId('riegl-unregistered-warning').textContent).toMatch(/not registered/i);
  });

  it('says positions land at the origin when no GNSS fix exists', async () => {
    vi.mocked(inspectRieglProject).mockResolvedValue({
      ...PROJECT,
      scans: [{ name: 'ScanPos001', point_count_probed: 10, gnss: null, enu: null }],
    } as never);
    render(<RieglProjectDialog projectPath="/p.riproject" rivlibPath="/riv" onResolve={vi.fn()} />);
    await waitFor(() => expect(screen.getByTestId('riegl-unregistered-warning')).toBeTruthy());
    expect(screen.getByTestId('riegl-unregistered-warning').textContent).toMatch(/at the origin/i);
    // With no fix there is nothing to plot.
    expect(screen.queryByTestId('riegl-layout-plan')).toBeNull();
  });

  it('surfaces a capability failure inline instead of an empty list', async () => {
    // A 503 carries the remediation ("start Docker", "choose a RiVLib folder").
    // Swallowing it would leave the user staring at a blank dialog.
    vi.mocked(inspectRieglProject).mockRejectedValue(
      new Error('Docker is not running. Start Docker Desktop and try again.'),
    );
    render(<RieglProjectDialog projectPath="/p.riproject" rivlibPath="/riv" onResolve={vi.fn()} />);
    await waitFor(() => expect(screen.getByTestId('riegl-dialog-error')).toBeTruthy());
    expect(screen.getByTestId('riegl-dialog-error').textContent).toMatch(/Docker/);
  });
});

describe('RieglProjectDialog select-all', () => {
  it('toggles every selectable position at once', async () => {
    const onResolve = vi.fn();
    render(<RieglProjectDialog projectPath="/p.riproject" rivlibPath="/riv" onResolve={onResolve} />);
    await waitFor(() => expect(screen.getByTestId('riegl-select-all')).toBeTruthy());

    const all = screen.getByTestId<HTMLInputElement>('riegl-select-all');
    // Everything readable starts selected, so the box starts checked.
    expect(all.checked).toBe(true);

    await userEvent.click(all); // deselect all
    expect(screen.getByTestId('riegl-scan-row-ScanPos001').dataset.selected).toBe('false');
    expect(screen.getByTestId('riegl-scan-row-ScanPos002').dataset.selected).toBe('false');
    expect(screen.getByTestId<HTMLButtonElement>('riegl-dialog-import').disabled).toBe(true);

    await userEvent.click(all); // re-select all
    expect(screen.getByTestId('riegl-scan-row-ScanPos001').dataset.selected).toBe('true');
    expect(screen.getByTestId('riegl-scan-row-ScanPos002').dataset.selected).toBe('true');

    await userEvent.click(screen.getByTestId('riegl-dialog-import'));
    // A failed position must never be swept in by "all" — the import would
    // then be asked for something it cannot produce.
    expect(onResolve).toHaveBeenCalledWith(['ScanPos001', 'ScanPos002']);
  });

  it('shows an indeterminate state when only some are selected', async () => {
    render(<RieglProjectDialog projectPath="/p.riproject" rivlibPath="/riv" onResolve={vi.fn()} />);
    await waitFor(() => expect(screen.getByTestId('riegl-select-all')).toBeTruthy());

    await userEvent.click(screen.getByTestId('riegl-scan-check-ScanPos002'));
    const all = screen.getByTestId<HTMLInputElement>('riegl-select-all');
    // `checked` alone cannot distinguish "some" from "none".
    expect(all.checked).toBe(false);
    expect(all.indeterminate).toBe(true);
  });
});

describe('RieglProjectDialog GNSS note', () => {
  it('marks each position with whether a fix was found', async () => {
    // Whether a position has GNSS decides where its cloud lands: with a fix it
    // is placed at its surveyed offset, without one it imports at the origin on
    // top of everything else.
    render(<RieglProjectDialog projectPath="/p.riproject" rivlibPath="/riv" onResolve={vi.fn()} />);
    await waitFor(() => expect(screen.getByTestId('riegl-scan-gnss-ScanPos001')).toBeTruthy());
    expect(screen.getByTestId('riegl-scan-gnss-ScanPos001').dataset.gnss).toBe('true');
    expect(screen.getByTestId('riegl-scan-gnss-ScanPos001').textContent).toMatch(/GNSS/);
  });

  it('flags a position with no fix', async () => {
    vi.mocked(inspectRieglProject).mockResolvedValue({
      ...PROJECT,
      scans: [
        { name: 'ScanPos001', point_count_probed: 10, gnss: null, enu: null },
      ],
    } as never);
    render(<RieglProjectDialog projectPath="/p.riproject" rivlibPath="/riv" onResolve={vi.fn()} />);
    await waitFor(() => expect(screen.getByTestId('riegl-scan-gnss-ScanPos001')).toBeTruthy());
    const note = screen.getByTestId('riegl-scan-gnss-ScanPos001');
    expect(note.dataset.gnss).toBe('false');
    expect(note.textContent).toMatch(/no GNSS/i);
  });
});

describe('RieglProjectDialog layering', () => {
  it('renders above the drag-drop overlay', async () => {
    // THE REPORTED BUG: the dialog is opened BY a drop, so the "Drop to load
    // scans" overlay (z-50) is still on screen when it appears. At equal
    // z-index the later-rendered overlay won and the dialog was only visible
    // as a blur moving behind it.
    render(<RieglProjectDialog projectPath="/p.riproject" rivlibPath="/riv" onResolve={vi.fn()} />);
    const root = screen.getByTestId('riegl-project-dialog').parentElement!;
    const z = Number(root.className.match(/z-\[(\d+)\]/)?.[1] ?? 0);
    expect(z).toBeGreaterThan(50);
  });
});
