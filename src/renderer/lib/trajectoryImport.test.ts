// Guards the trajectory file picker against the failure that shipped in v0.82.0:
// the dialog listed text and binary trajectories as TWO filters, and macOS applies
// only the first, so every .out/.sbet SBET was greyed out and unselectable. The
// backend parser worked the whole time — the format simply could not be reached
// through the UI, which reads to a user as "SBET is not supported".
//
// These are cheap structural assertions rather than E2E because a native
// NSOpenPanel cannot be driven by Playwright; the reachable surface is the filter
// list we hand to showOpenDialog.

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { electronAPIMock } from '../../../tests/setup/electronAPI.mock';
import {
  buildTrajectoryFilters,
  isSbetPath,
  parseTrajectoryFromPath,
  pickAndParseTrajectory,
  SBET_EXTENSIONS,
  TEXT_TRAJECTORY_EXTENSIONS,
  TRAJECTORY_EXTENSIONS,
} from './trajectoryImport';

vi.mock('../utils/backendApi', () => ({
  parseTrajectory: vi.fn(async () => ({
    poses: [{ t: 0, x: 1, y: 2, z: 3, qx: 0, qy: 0, qz: 0, qw: 1 }],
    frame: { crs: 'EPSG:32610', up_axis: 'z', body_convention: 'FRD', time_ref: 'gps' },
    lever_arm: [0, 0, 0],
    boresight_rpy: [0, 0, 0],
    source_format: 'sbet',
    warnings: [],
  })),
}));
import { parseTrajectory } from '../utils/backendApi';

describe('trajectory picker filters', () => {
  it('offers exactly ONE filter, so macOS cannot grey out a supported format', () => {
    // The regression: two entries meant filters[0] ('csv','txt','tsv','traj') was
    // the only one macOS honoured. Anything but a single entry reopens it.
    expect(buildTrajectoryFilters()).toHaveLength(1);
  });

  it('lists every extension the parser can route, SBET included', () => {
    const [only] = buildTrajectoryFilters();
    for (const ext of [...TEXT_TRAJECTORY_EXTENSIONS, ...SBET_EXTENSIONS]) {
      expect(only.extensions).toContain(ext);
    }
    // .out is the specific one users hit: it is POSPac's native export extension.
    expect(only.extensions).toContain('out');
  });

  it('keeps the filter list and the routing table in sync', () => {
    // If someone adds a format to TRAJECTORY_EXTENSIONS but forgets the parser
    // (or vice versa), the picker would offer a file it cannot read.
    const routed = [...TEXT_TRAJECTORY_EXTENSIONS, ...SBET_EXTENSIONS].sort();
    expect([...TRAJECTORY_EXTENSIONS].sort()).toEqual(routed);
    expect(buildTrajectoryFilters()[0].extensions.slice().sort()).toEqual(routed);
  });

  it('has no duplicate extensions', () => {
    const e = buildTrajectoryFilters()[0].extensions;
    expect(new Set(e).size).toBe(e.length);
  });
});

describe('SBET routing', () => {
  it('routes .out and .sbet to the backend, case-insensitively', () => {
    expect(isSbetPath('/data/WGS84_sbet_Mission 1.out')).toBe(true);
    expect(isSbetPath('/data/traj.sbet')).toBe(true);
    expect(isSbetPath('/data/TRAJ.SBET')).toBe(true);
    expect(isSbetPath('/data/WGS84_sbet_Mission 1.OUT')).toBe(true);
  });

  it('routes text trajectories to the renderer parser', () => {
    for (const ext of TEXT_TRAJECTORY_EXTENSIONS) {
      expect(isSbetPath(`/data/traj.${ext}`)).toBe(false);
    }
  });

  it('does not mistake an SBET-ish NAME for an SBET extension', () => {
    // "sbet" appears in the middle of the real filename from POSPac's exporter.
    expect(isSbetPath('/data/WGS84_sbet_Mission 1.csv')).toBe(false);
  });
});

describe('parseTrajectoryFromPath', () => {
  beforeEach(() => vi.clearAllMocks());

  it('sends a real POSPac .out filename to the backend and labels it', async () => {
    const path = '/data/WGS84_sbet_Mission 1.out';
    const stream = await parseTrajectoryFromPath(path);
    expect(parseTrajectory).toHaveBeenCalledWith(path);
    expect(stream.label).toBe('WGS84_sbet_Mission 1.out');
  });
});

describe('pickAndParseTrajectory', () => {
  beforeEach(() => vi.clearAllMocks());

  it('hands the single combined filter to the dialog and parses the pick', async () => {
    electronAPIMock.setDialogOpenResult('/data/WGS84_sbet_Mission 1.out');
    const stream = await pickAndParseTrajectory();
    const open = window.electronAPI.dialog.open as unknown as {
      mock: { calls: [{ filters: { extensions: string[] }[] }][] };
    };
    const opts = open.mock.calls[0][0];
    // The whole point of the fix: ONE filter, and it must include .out.
    expect(opts.filters).toHaveLength(1);
    expect(opts.filters[0].extensions).toContain('out');
    expect(stream).not.toBeNull();
    expect(parseTrajectory).toHaveBeenCalledWith('/data/WGS84_sbet_Mission 1.out');
  });

  it('returns null when the user cancels', async () => {
    electronAPIMock.setDialogOpenResult(null);
    expect(await pickAndParseTrajectory()).toBeNull();
  });
});
