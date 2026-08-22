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

// A .PROJ: registration is present but PARTIAL, which is the normal case (the
// reference olive project registered 9 of 24). Covers all three placement
// states plus a position that is absent from the manifest entirely.
const PROJ = {
  project: '/data/2024-07-18.PROJ',
  layout: 'proj',
  reader_version: 3,
  rivlib_version: '7.1.0',
  frame: 'registered',
  scan_count: 3,
  gnss_anchor: { latitude: 39.6044, longitude: -122.2588, height_m: 32.18 },
  registered: true,
  registered_count: 1,
  scans: [
    {
      name: 'ScanPos001',
      registration: 'registered',
      point_count_estimated: 10_350_000,
      instrument: { model: 'VZ-2000i' },
      scan_params: { origin: [0, 0, 0] as [number, number, number], theta_min: 30, theta_max: 130, phi_min: 0, phi_max: 360 },
      sop: [
        [1, 0, 0, -0.1877],
        [0, 1, 0, 0.1886],
        [0, 0, 1, 0.3316],
        [0, 0, 0, 1],
      ],
      gnss: { latitude: 39.6044, longitude: -122.2588, height_m: 33.3, height_datum: 'ellipsoidal' },
      enu: { east_m: 0, north_m: 0, up_m: 0 },
    },
    {
      name: 'ScanPos012',
      registration: 'prior',
      point_count_estimated: 9_000_000,
      instrument: { model: 'VZ-2000i' },
      manifest_success: false,
      sop: [
        [1, 0, 0, 1.5],
        [0, 1, 0, -3.2],
        [0, 0, 1, 0.4],
        [0, 0, 0, 1],
      ],
      gnss: { latitude: 39.6045, longitude: -122.2589, height_m: 33.1, height_datum: 'ellipsoidal' },
      enu: { east_m: 1.4, north_m: -3.1, up_m: 0.1 },
    },
    {
      name: 'ScanPos019',
      registration: 'none',
      point_count_estimated: 1_170_000,
      instrument: { model: 'VZ-2000i' },
      gnss: null,
      enu: null,
    },
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

    expect(onResolve).toHaveBeenCalledWith({ scans: ['ScanPos001'], frame: 'local' });
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
    expect(onResolve).toHaveBeenCalledWith({
      scans: ['ScanPos001', 'ScanPos002'],
      frame: 'local',
    });
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

describe('RieglProjectDialog .PROJ registration', () => {
  beforeEach(() => {
    vi.mocked(inspectRieglProject).mockResolvedValue(PROJ as never);
  });

  it('inspects in the registered frame regardless of the toggle', async () => {
    // The SOPs the plan view and the badges are drawn from only exist when the
    // reader resolves them, so the preview must always ask for them. Getting
    // this wrong would leave a .PROJ looking exactly like a .riproject.
    render(<RieglProjectDialog projectPath="/p.PROJ" rivlibPath="/riv" onResolve={vi.fn()} />);
    await waitFor(() => expect(screen.getByTestId('riegl-scan-row-ScanPos001')).toBeTruthy());
    expect(vi.mocked(inspectRieglProject).mock.calls[0][3]).toBe('registered');
  });

  it('marks each position with how it was placed', async () => {
    render(<RieglProjectDialog projectPath="/p.PROJ" rivlibPath="/riv" onResolve={vi.fn()} />);
    await waitFor(() =>
      expect(screen.getByTestId('riegl-scan-registration-ScanPos001')).toBeTruthy(),
    );
    expect(
      screen.getByTestId('riegl-scan-registration-ScanPos001').dataset.registration,
    ).toBe('registered');
    // The distinction that matters to the user: "prior" is placed, but only to
    // about a metre, so it still needs ICP. Showing it as registered would let
    // a metre of error pass as a survey.
    const prior = screen.getByTestId('riegl-scan-registration-ScanPos012');
    expect(prior.dataset.registration).toBe('prior');
    expect(prior.textContent).toMatch(/prior/i);
    expect(
      screen.getByTestId('riegl-scan-registration-ScanPos019').dataset.registration,
    ).toBe('none');
  });

  it('summarises how much of the project is really registered', async () => {
    // A .PROJ is routinely a MIX, so a blanket "these are aligned" would be a
    // lie about two thirds of this project.
    render(<RieglProjectDialog projectPath="/p.PROJ" rivlibPath="/riv" onResolve={vi.fn()} />);
    await waitFor(() => expect(screen.getByTestId('riegl-registration-summary')).toBeTruthy());
    const text = screen.getByTestId('riegl-registration-summary').textContent ?? '';
    expect(text).toMatch(/1 of 3/);
    expect(text).toMatch(/ICP/);
    expect(screen.queryByTestId('riegl-unregistered-warning')).toBeNull();
  });

  it('reports an estimated point count as approximate, not as a floor', async () => {
    // A .PROJ preview decodes nothing, so this number is neither exact nor a
    // lower bound. Reusing the probe path's "≥" would misrepresent it.
    render(<RieglProjectDialog projectPath="/p.PROJ" rivlibPath="/riv" onResolve={vi.fn()} />);
    await waitFor(() => expect(screen.getByTestId('riegl-scan-row-ScanPos001')).toBeTruthy());
    const row = screen.getByTestId('riegl-scan-row-ScanPos001');
    expect(row.textContent).toMatch(/~10,350,000 pts/);
    expect(row.textContent).not.toMatch(/\u2265/);
  });

  it('opting out of registration switches the frame and the warning back', async () => {
    const onResolve = vi.fn();
    render(<RieglProjectDialog projectPath="/p.PROJ" rivlibPath="/riv" onResolve={onResolve} />);
    await waitFor(() => expect(screen.getByTestId('riegl-keep-local')).toBeTruthy());

    await userEvent.click(screen.getByTestId('riegl-keep-local'));

    // The unregistered warning comes back, the summary goes away, and the rows
    // fall back to reporting GNSS rather than a placement they no longer get.
    expect(screen.queryByTestId('riegl-registration-summary')).toBeNull();
    expect(screen.getByTestId('riegl-unregistered-warning')).toBeTruthy();
    expect(screen.getByTestId('riegl-scan-gnss-ScanPos001')).toBeTruthy();

    await userEvent.click(screen.getByTestId('riegl-dialog-import'));
    expect(onResolve).toHaveBeenCalledWith(
      expect.objectContaining({ frame: 'local' }),
    );
  });

  it('imports registered by default', async () => {
    const onResolve = vi.fn();
    render(<RieglProjectDialog projectPath="/p.PROJ" rivlibPath="/riv" onResolve={onResolve} />);
    await waitFor(() => expect(screen.getByTestId('riegl-dialog-import')).toBeTruthy());
    await userEvent.click(screen.getByTestId('riegl-dialog-import'));
    expect(onResolve).toHaveBeenCalledWith(
      expect.objectContaining({ frame: 'registered' }),
    );
  });

  it('offers no frame choice for a .riproject', async () => {
    // Raw scanner data has no pose to apply, so the checkbox would imply an
    // alignment that does not exist.
    vi.mocked(inspectRieglProject).mockResolvedValue(PROJECT as never);
    render(<RieglProjectDialog projectPath="/p.riproject" rivlibPath="/riv" onResolve={vi.fn()} />);
    await waitFor(() => expect(screen.getByTestId('riegl-scan-row-ScanPos001')).toBeTruthy());
    expect(screen.queryByTestId('riegl-keep-local')).toBeNull();
    expect(screen.getByTestId('riegl-unregistered-warning')).toBeTruthy();
  });

  it('draws the plan view from the surveyed poses when there are any', async () => {
    // The GNSS prior and the SOP disagree by metres; plotting the prior for a
    // project that knows better would show a layout the import will not produce.
    render(<RieglProjectDialog projectPath="/p.PROJ" rivlibPath="/riv" onResolve={vi.fn()} />);
    await waitFor(() => expect(screen.getByTestId('riegl-layout-plan')).toBeTruthy());
    // ScanPos019 has neither a pose nor a fix, so it is simply not plotted.
    expect(
      screen.getByTestId('riegl-layout-plan').querySelectorAll('circle').length,
    ).toBe(2);
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

describe('RieglProjectDialog sensor levelling', () => {
  // A .riproject where only SOME positions recorded an attitude — the real
  // shape of the data (4 of 8 in 2017-12-15.001 had no usable pose record).
  const LEVELABLE = {
    ...PROJECT,
    scans: [
      { ...PROJECT.scans[0], sensor_pose: { roll_deg: 1.526, pitch_deg: 0.134, yaw_deg: 58.02, source: 'scanner_pose_hr' } },
      { ...PROJECT.scans[1] },
      PROJECT.scans[2],
    ],
  };

  it('offers levelling for a .riproject that measured its own tilt', async () => {
    vi.mocked(inspectRieglProject).mockResolvedValue(LEVELABLE as never);
    render(<RieglProjectDialog projectPath="/p.riproject" rivlibPath="/riv" onResolve={vi.fn()} />);
    const toggle = await screen.findByTestId('riegl-level-toggle');
    // On by default: an unlevelled cloud silently breaks ground/DEM work.
    expect(toggle.getAttribute('data-level-scans')).toBe('true');
    // The claim must stay narrow — levelled is not aligned.
    expect(toggle.textContent).toMatch(/does not align the scans/i);
  });

  it('imports in the sensor frame when levelling is on', async () => {
    vi.mocked(inspectRieglProject).mockResolvedValue(LEVELABLE as never);
    const onResolve = vi.fn();
    render(<RieglProjectDialog projectPath="/p.riproject" rivlibPath="/riv" onResolve={onResolve} />);
    await screen.findByTestId('riegl-level-toggle');
    await userEvent.click(screen.getByTestId('riegl-dialog-import'));
    expect(onResolve).toHaveBeenCalledWith(
      expect.objectContaining({ frame: 'sensor' }),
    );
  });

  it('falls back to the local frame when levelling is switched off', async () => {
    vi.mocked(inspectRieglProject).mockResolvedValue(LEVELABLE as never);
    const onResolve = vi.fn();
    render(<RieglProjectDialog projectPath="/p.riproject" rivlibPath="/riv" onResolve={onResolve} />);
    await screen.findByTestId('riegl-level-toggle');
    await userEvent.click(screen.getByTestId('riegl-level-scans'));
    await userEvent.click(screen.getByTestId('riegl-dialog-import'));
    expect(onResolve).toHaveBeenCalledWith(
      expect.objectContaining({ frame: 'local' }),
    );
  });

  it('says how many selected positions recorded no tilt', async () => {
    vi.mocked(inspectRieglProject).mockResolvedValue(LEVELABLE as never);
    render(<RieglProjectDialog projectPath="/p.riproject" rivlibPath="/riv" onResolve={vi.fn()} />);
    const toggle = await screen.findByTestId('riegl-level-toggle');
    // ScanPos002 has no sensor_pose (ScanPos003 errored and is unselectable),
    // so the user is told it imports unlevelled rather than finding out later.
    expect(toggle.textContent).toMatch(/1 of the 2 selected positions recorded no tilt/i);
  });

  it('resets to levelling-on when the dialog is reopened', async () => {
    // A choice made for one project must not silently carry into the next —
    // the same rule keepLocal follows.
    vi.mocked(inspectRieglProject).mockResolvedValue(LEVELABLE as never);
    const { rerender } = render(
      <RieglProjectDialog projectPath="/p.riproject" rivlibPath="/riv" onResolve={vi.fn()} />,
    );
    await screen.findByTestId('riegl-level-toggle');
    await userEvent.click(screen.getByTestId('riegl-level-scans'));
    expect(
      screen.getByTestId('riegl-level-toggle').getAttribute('data-level-scans'),
    ).toBe('false');

    rerender(<RieglProjectDialog projectPath={null} rivlibPath="/riv" onResolve={vi.fn()} />);
    rerender(<RieglProjectDialog projectPath="/p.riproject" rivlibPath="/riv" onResolve={vi.fn()} />);
    const reopened = await screen.findByTestId('riegl-level-toggle');
    expect(reopened.getAttribute('data-level-scans')).toBe('true');
  });

  it('hides the option when no position measured anything', async () => {
    // Every position lacking a pose is ordinary, not an error state.
    vi.mocked(inspectRieglProject).mockResolvedValue(PROJECT as never);
    render(<RieglProjectDialog projectPath="/p.riproject" rivlibPath="/riv" onResolve={vi.fn()} />);
    await waitFor(() => expect(screen.getByTestId('riegl-scan-row-ScanPos001')).toBeTruthy());
    expect(screen.queryByTestId('riegl-level-toggle')).toBeNull();
  });

  it('never offers levelling for a .PROJ, which has real registration', async () => {
    vi.mocked(inspectRieglProject).mockResolvedValue({
      ...PROJ,
      scans: PROJ.scans.map((s) => ({
        ...s,
        sensor_pose: { roll_deg: 1.0, pitch_deg: 0.5, source: 'hk_incl' },
      })),
    } as never);
    render(<RieglProjectDialog projectPath="/p.PROJ" rivlibPath="/riv" onResolve={vi.fn()} />);
    await waitFor(() => expect(screen.getByTestId('riegl-frame-toggle')).toBeTruthy());
    expect(screen.queryByTestId('riegl-level-toggle')).toBeNull();
  });
});
