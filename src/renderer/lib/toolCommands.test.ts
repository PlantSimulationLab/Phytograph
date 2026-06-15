import { describe, it, expect } from 'vitest';
import {
  isCommandAvailable,
  requiresText,
  commandsForGroup,
  TOOL_GROUPS,
  CREATE_GROUPS,
  SIMULATE_GROUPS,
  type ToolCommand,
  type SelectionState,
} from './toolCommands';

const noop = () => {};

function cmd(partial: Partial<ToolCommand>): ToolCommand {
  return { id: 'x', name: 'X', action: noop, category: 'Point Cloud', ...partial };
}

const EMPTY: SelectionState = {
  hasCloud: false,
  hasMesh: false,
  hasSkeleton: false,
  hasPlantMesh: false,
  cloudCount: 0,
  meshCount: 0,
  totalCloudCount: 0,
};

describe('isCommandAvailable', () => {
  it('is true for commands with no prerequisite', () => {
    expect(isCommandAvailable(cmd({ requires: null }), EMPTY)).toBe(true);
    expect(isCommandAvailable(cmd({ requires: undefined }), EMPTY)).toBe(true);
  });

  it('gates single-input tools on the matching selection', () => {
    const c = cmd({ requires: 'cloud' });
    expect(isCommandAvailable(c, EMPTY)).toBe(false);
    expect(isCommandAvailable(c, { ...EMPTY, hasCloud: true })).toBe(true);
  });

  it('gates mesh / skeleton / plant tools independently', () => {
    expect(isCommandAvailable(cmd({ requires: 'mesh' }), { ...EMPTY, hasMesh: true })).toBe(true);
    expect(isCommandAvailable(cmd({ requires: 'skeleton' }), { ...EMPTY, hasSkeleton: true })).toBe(true);
    expect(isCommandAvailable(cmd({ requires: 'plant' }), { ...EMPTY, hasPlantMesh: true })).toBe(true);
    // A plain mesh selection does not satisfy a plant requirement.
    expect(isCommandAvailable(cmd({ requires: 'plant' }), { ...EMPTY, hasMesh: true })).toBe(false);
  });

  it('requires 2+ for multiple-clouds / multiple-meshes', () => {
    const mc = cmd({ requires: 'multiple-clouds' });
    expect(isCommandAvailable(mc, { ...EMPTY, hasCloud: true, cloudCount: 1 })).toBe(false);
    expect(isCommandAvailable(mc, { ...EMPTY, hasCloud: true, cloudCount: 2 })).toBe(true);
    const mm = cmd({ requires: 'multiple-meshes' });
    expect(isCommandAvailable(mm, { ...EMPTY, meshCount: 1 })).toBe(false);
    expect(isCommandAvailable(mm, { ...EMPTY, meshCount: 3 })).toBe(true);
  });

  it('enables multi-input tools without a selection, but only if a cloud exists', () => {
    // Multi-input tools (stitch/align/LAD) pick inputs in a dialog, so they don't
    // need a *selected* cloud — but an empty scene has nothing to operate on, so
    // they grey out until at least one cloud exists.
    const c = cmd({ multiInput: true, requires: 'multiple-clouds' });
    expect(isCommandAvailable(c, EMPTY)).toBe(false);                          // 0 clouds → disabled
    expect(isCommandAvailable(c, { ...EMPTY, totalCloudCount: 1 })).toBe(true); // 1 cloud, none selected → enabled
    expect(isCommandAvailable(c, { ...EMPTY, totalCloudCount: 3 })).toBe(true);
  });
});

describe('requiresText', () => {
  it('returns a human phrase for each prerequisite', () => {
    expect(requiresText('cloud')).toBe('a point cloud');
    expect(requiresText('mesh')).toBe('a mesh');
    expect(requiresText('multiple-clouds')).toBe('2+ point clouds');
    expect(requiresText(null)).toBe('');
  });
});

describe('commandsForGroup', () => {
  const cmds: ToolCommand[] = [
    cmd({ id: 'a', toolGroup: 'preprocess' }),
    cmd({ id: 'b', toolGroup: 'segment' }),
    cmd({ id: 'c', toolGroup: 'preprocess' }),
    cmd({ id: 'd', toolGroup: null }),
    cmd({ id: 'e' }), // no group
  ];

  it('returns only the group members, in registry order', () => {
    expect(commandsForGroup(cmds, 'preprocess').map(c => c.id)).toEqual(['a', 'c']);
    expect(commandsForGroup(cmds, 'segment').map(c => c.id)).toEqual(['b']);
  });

  it('excludes ungrouped and null-group commands from every group', () => {
    for (const g of TOOL_GROUPS) {
      const ids = commandsForGroup(cmds, g.id).map(c => c.id);
      expect(ids).not.toContain('d');
      expect(ids).not.toContain('e');
    }
  });
});

describe('TOOL_GROUPS', () => {
  it('declares the three analysis categories in order (Create/Simulate are separate)', () => {
    expect(TOOL_GROUPS.map(g => g.id)).toEqual(['preprocess', 'segment', 'reconstruct']);
  });
});

describe('CREATE_GROUPS / SIMULATE_GROUPS', () => {
  it('hold the non-analysis scene-building groups', () => {
    expect(CREATE_GROUPS.map(g => g.id)).toEqual(['create']);
    expect(SIMULATE_GROUPS.map(g => g.id)).toEqual(['simulate']);
  });
});
