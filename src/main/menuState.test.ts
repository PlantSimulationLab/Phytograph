// Enablement of scene-dependent native menu items.
//
// The native menu is built in the MAIN process and cannot see renderer state,
// so anything that greys out on a scene condition ("Reset Registration" is dead
// unless something has been registered) depends on the renderer pushing that
// state over IPC and applyMenuState landing it on the right MenuItem. E2E can't
// cover this: the suite installs an inert chrome (Menu.setApplicationMenu(null))
// precisely so tests aren't fighting a native menu, which is also the null case
// asserted below.
import { describe, it, expect, beforeEach, vi } from 'vitest';

/** Minimal MenuItem stand-in — `enabled` is the only field under test. */
class FakeMenuItem {
  enabled = true;
  constructor(public id: string) {}
}

let currentMenu: { getMenuItemById: (id: string) => FakeMenuItem | null } | null = null;
let items: Map<string, FakeMenuItem>;

const Menu = {
  getApplicationMenu: vi.fn(() => currentMenu),
  setApplicationMenu: vi.fn(),
  buildFromTemplate: vi.fn(),
};

vi.mock('electron', () => ({
  Menu,
  BrowserWindow: class {},
  app: { isPackaged: true, getVersion: () => '0.72.0' },
  shell: { openExternal: vi.fn() },
}));

vi.mock('./updater.js', () => ({ checkForUpdatesManually: vi.fn() }));

const { applyMenuState, retainedMenuState } = await import('./menu.js');

function installMenu(ids: string[]) {
  items = new Map(ids.map(id => [id, new FakeMenuItem(id)]));
  currentMenu = { getMenuItemById: (id: string) => items.get(id) ?? null };
}

beforeEach(() => {
  installMenu(['cloud-unregister', 'cloud-auto-register']);
  // Reset any state a previous test pushed, so tests don't leak into each other
  // through the module-level `lastMenuState`.
  applyMenuState({ enabled: {} });
});

describe('applyMenuState', () => {
  it('disables the item the renderer reports as unavailable', () => {
    applyMenuState({ enabled: { 'cloud-unregister': false } });
    expect(items.get('cloud-unregister')!.enabled).toBe(false);
  });

  it('re-enables it when the renderer reports it available again', () => {
    applyMenuState({ enabled: { 'cloud-unregister': false } });
    applyMenuState({ enabled: { 'cloud-unregister': true } });
    expect(items.get('cloud-unregister')!.enabled).toBe(true);
  });

  it('leaves unreported items alone', () => {
    // The safe default: a wrongly-greyed item is unreachable with no
    // explanation, whereas a wrongly-enabled one still runs and reports.
    applyMenuState({ enabled: { 'cloud-unregister': false } });
    expect(items.get('cloud-auto-register')!.enabled).toBe(true);
  });

  it('ignores an id that is not in the menu', () => {
    expect(() => applyMenuState({ enabled: { 'no-such-tool': false } })).not.toThrow();
  });

  it('does not throw when there is no application menu', () => {
    // E2E installs an inert chrome, and there is a window at startup before the
    // menu exists. Both must be no-ops rather than crashes in the main process.
    currentMenu = null;
    expect(() => applyMenuState({ enabled: { 'cloud-unregister': false } })).not.toThrow();
  });

  it('remembers state pushed while no menu existed, and applies it on rebuild', () => {
    // The ordering that makes retention load-bearing: the renderer reports its
    // state BEFORE the menu is built (or between builds), so there is no item
    // to set at the time. The state must survive until a menu exists.
    currentMenu = null;
    applyMenuState({ enabled: { 'cloud-unregister': false } });

    installMenu(['cloud-unregister']);
    expect(items.get('cloud-unregister')!.enabled).toBe(true); // fresh item, not yet applied

    // What installApplicationMenu does at the end of a (re)build: replay the
    // retained state. Passing an EMPTY payload here would wrongly re-enable the
    // item, so this asserts the retention itself rather than the re-push.
    applyMenuState(retainedMenuState());
    expect(items.get('cloud-unregister')!.enabled).toBe(false);
  });
});
