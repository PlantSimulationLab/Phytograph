// Parity guard between the native menu-bar manifest (src/shared/toolMenu.ts)
// and the renderer's tool registry. The registry is built inside
// PointCloudViewer because each command's `action` closes over component state,
// so it can't be imported here — instead we parse the registry entries out of
// the source text. That's enough, because every field this test cares about
// (id, name, toolGroup, icon) is written as a literal on the entry line.
//
// The bug this exists to prevent: tools were added to the registry (and so got
// toolbar icons) but nobody hand-added the matching item to menu.ts, so
// Generate DEM, Fit Crown & Metrics and Create Plane were unreachable from the
// menu bar. Every icon-bearing tool must be in the menu.
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { TOOLS_MENU, CREATE_MENU, SIMULATE_MENU, allMenuToolIds } from './toolMenu';

const HERE = dirname(fileURLToPath(import.meta.url));
const VIEWER = resolve(HERE, '../renderer/components/PointCloudViewer.tsx');

interface RegistryEntry {
  id: string;
  name: string;
  toolGroup: string | null;
  hasIcon: boolean;
}

/**
 * Pull the registry entries out of PointCloudViewer's source. Each is a single
 * object literal on one line starting with `{ id: '...'`. Note the file
 * contains NUL bytes, so it is read as latin1 rather than utf8.
 */
function parseRegistry(): RegistryEntry[] {
  const src = readFileSync(VIEWER, 'latin1');
  const entries: RegistryEntry[] = [];
  for (const line of src.split('\n')) {
    const m = /^\s*\{ id: '([^']+)', name: '([^']+)'/.exec(line);
    if (!m) continue;
    const groupMatch = /toolGroup: (?:'([a-z]+)'|null)/.exec(line);
    entries.push({
      id: m[1],
      name: m[2],
      toolGroup: groupMatch?.[1] ?? null,
      hasIcon: /\bicon: [A-Z]/.test(line),
    });
  }
  return entries;
}

const registry = parseRegistry();

describe('tool registry parsing', () => {
  it('finds the registry in PointCloudViewer', () => {
    // Sanity: if the registry is ever restructured so the regex stops matching,
    // fail loudly here rather than silently passing every parity check below.
    expect(registry.length).toBeGreaterThan(30);
    expect(registry.map(e => e.id)).toContain('cloud-triangulate');
  });
});

describe('menu / registry parity', () => {
  it('every tool with a toolbar icon is reachable from the menu bar', () => {
    const menuIds = new Set(allMenuToolIds());
    const missing = registry
      .filter(e => e.toolGroup !== null && e.hasIcon)
      .filter(e => !menuIds.has(e.id))
      .map(e => `${e.id} (${e.name})`);
    expect(missing).toEqual([]);
  });

  it('every menu item points at a real registry command', () => {
    const registryIds = new Set(registry.map(e => e.id));
    const dangling = allMenuToolIds().filter(id => !registryIds.has(id));
    expect(dangling).toEqual([]);
  });

  it('lists no tool twice', () => {
    const ids = allMenuToolIds();
    expect(ids.length).toBe(new Set(ids).size);
  });

  it('labels match the registry name apart from a trailing ellipsis', () => {
    const nameById = new Map(registry.map(e => [e.id, e.name]));
    const items = [
      ...TOOLS_MENU.flatMap(s => s.items.filter(i => i !== null)),
      ...CREATE_MENU,
      ...SIMULATE_MENU,
    ];
    const mismatched = items
      .filter(i => i!.label.replace(/…$/, '') !== nameById.get(i!.id))
      .map(i => `${i!.id}: menu "${i!.label}" vs registry "${nameById.get(i!.id)}"`);
    expect(mismatched).toEqual([]);
  });

  it('puts Create and Simulate tools in their own menus, not under Tools', () => {
    const toolsIds = new Set(
      TOOLS_MENU.flatMap(s => s.items.filter(i => i !== null).map(i => i!.id)),
    );
    const misplaced = registry
      .filter(e => e.toolGroup === 'create' || e.toolGroup === 'simulate')
      .filter(e => toolsIds.has(e.id))
      .map(e => e.id);
    expect(misplaced).toEqual([]);
  });
});
