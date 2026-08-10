import { beforeEach, describe, expect, it } from 'vitest';
import {
  createTag,
  deleteTag,
  exportData,
  getSettings,
  getTagById,
  getTagColor,
  getTags,
  importData,
  initStore,
  TAG_COLORS,
  updateSettings,
  updateTag,
  getClassPalettes,
  saveClassPalette,
  deleteClassPalette,
  exportClassPalettes,
  importClassPalettes,
} from './store';
import type { ClassPalette } from './classPalettes';

describe('store tags', () => {
  it('creates a tag and returns it from getTags', async () => {
    const tag = await createTag('Field A', 'green');
    expect(tag.name).toBe('field a');
    expect(tag.color).toBe('green');
    expect(tag.id).toMatch(/[0-9a-f-]{36}/);

    const all = await getTags();
    expect(all).toHaveLength(1);
    expect(all[0]).toEqual(tag);
  });

  it('rejects duplicate names case-insensitively', async () => {
    await createTag('Maple', 'red');
    await expect(createTag('MAPLE', 'blue')).rejects.toThrow(/already exists/);
  });

  it('updates a tag in place and persists the change', async () => {
    const tag = await createTag('original', 'amber');
    const updated = await updateTag(tag.id, { name: 'renamed', color: 'sky' });
    expect(updated?.name).toBe('renamed');
    expect(updated?.color).toBe('sky');
    expect(updated?.id).toBe(tag.id);

    const fetched = await getTagById(tag.id);
    expect(fetched?.name).toBe('renamed');
  });

  it('deleteTag removes the tag and returns true; second delete returns false', async () => {
    const tag = await createTag('temp', 'rose');
    expect(await deleteTag(tag.id)).toBe(true);
    expect(await getTags()).toHaveLength(0);
    expect(await deleteTag(tag.id)).toBe(false);
  });
});

describe('store settings', () => {
  it('returns default light theme when nothing is stored', async () => {
    const settings = await getSettings();
    expect(settings).toEqual({
      theme: 'light',
      triangulateMaxPoints: 5_000_000,
      defaultBackgroundColor: 'black',
      defaultPointSize: 1,
      scanMarkerScale: 1,
      missDistanceThreshold: 1001,
      syntheticScanMemoryBudgetMb: null,
    });
  });

  it('updateSettings persists the new display defaults', async () => {
    await updateSettings({ defaultBackgroundColor: 'white', defaultPointSize: 3 });
    const settings = await getSettings();
    expect(settings.defaultBackgroundColor).toBe('white');
    expect(settings.defaultPointSize).toBe(3);
    expect(settings.triangulateMaxPoints).toBe(5_000_000); // untouched
  });

  it('updateSettings merges and persists', async () => {
    await updateSettings({ theme: 'dark' });
    const settings = await getSettings();
    expect(settings.theme).toBe('dark');
  });

  it('updateSettings persists triangulateMaxPoints', async () => {
    await updateSettings({ triangulateMaxPoints: 2_000_000 });
    const settings = await getSettings();
    expect(settings.triangulateMaxPoints).toBe(2_000_000);
    expect(settings.theme).toBe('light'); // untouched
  });

  it('a theme-only update preserves the triangulate cap', async () => {
    // Updating one field must not wipe the other.
    await updateSettings({ triangulateMaxPoints: 1_234_000 });
    await updateSettings({ theme: 'dark' });
    const settings = await getSettings();
    expect(settings.theme).toBe('dark');
    expect(settings.triangulateMaxPoints).toBe(1_234_000);
  });

  it('updateSettings persists missDistanceThreshold', async () => {
    await updateSettings({ missDistanceThreshold: 2500 });
    const settings = await getSettings();
    expect(settings.missDistanceThreshold).toBe(2500);
    expect(settings.theme).toBe('light'); // untouched
  });

  it('syntheticScanMemoryBudgetMb defaults to null (use Helios default)', async () => {
    const settings = await getSettings();
    expect(settings.syntheticScanMemoryBudgetMb).toBeNull();
  });

  it('updateSettings round-trips a memory budget and can clear it back to null', async () => {
    await updateSettings({ syntheticScanMemoryBudgetMb: 512 });
    expect((await getSettings()).syntheticScanMemoryBudgetMb).toBe(512);
    // Clearing the field commits null — the backend then leaves Helios's default.
    await updateSettings({ syntheticScanMemoryBudgetMb: null });
    expect((await getSettings()).syntheticScanMemoryBudgetMb).toBeNull();
  });
});

describe('store export/import', () => {
  it('exportData round-trips through importData', async () => {
    const tag = await createTag('field-a', 'green');
    await updateSettings({ theme: 'dark' });
    const json = await exportData();
    const parsed = JSON.parse(json);
    expect(parsed.tags).toHaveLength(1);
    expect(parsed.tags[0].id).toBe(tag.id);
    expect(parsed.settings.theme).toBe('dark');

    // Wipe and re-import.
    await deleteTag(tag.id);
    await updateSettings({ theme: 'light' });
    await importData(json);

    const tags = await getTags();
    const settings = await getSettings();
    expect(tags).toHaveLength(1);
    expect(tags[0].id).toBe(tag.id);
    expect(settings.theme).toBe('dark');
  });

  it('importData ignores missing tags / settings fields', async () => {
    await importData(JSON.stringify({ tags: [{ id: 't1', name: 'only', color: 'red', createdAt: '' }] }));
    expect(await getTags()).toHaveLength(1);
    // settings untouched
    expect((await getSettings()).theme).toBe('light');
  });

  it('exportData with empty store returns defaults', async () => {
    const json = await exportData();
    const parsed = JSON.parse(json);
    expect(parsed.tags).toEqual([]);
    expect(parsed.settings).toEqual({
      theme: 'light',
      triangulateMaxPoints: 5_000_000,
      defaultBackgroundColor: 'black',
      defaultPointSize: 1,
      scanMarkerScale: 1,
      missDistanceThreshold: 1001,
      syntheticScanMemoryBudgetMb: null,
    });
  });
});

describe('getTagColor', () => {
  it('returns the matching color descriptor for a known name', () => {
    const color = getTagColor('rose');
    expect(color.name).toBe('rose');
    expect(color.bg).toBe('bg-rose-100');
  });

  it('falls back to the first color (slate) when name is unknown', () => {
    // Cast around the literal type so we can exercise the fallback path.
    const color = getTagColor('not-a-real-color' as 'slate');
    expect(color.name).toBe(TAG_COLORS[0].name);
  });
});

describe('initStore', () => {
  it('resolves to undefined (kept for Tauri API parity)', async () => {
    await expect(initStore()).resolves.toBeUndefined();
  });
});

describe('class palette library', () => {
  // These tests reset their own key rather than relying on suite ordering, so
  // they can be run in isolation. Seeding goes through the same electronAPI
  // store the module uses (the suite runs with the electronAPI mock installed,
  // so the localStorage fallback is not the live path).
  const KEY = 'classPalettes';
  const NOW = 1_700_000_000_000;
  const pal = (id: string, name = id): ClassPalette => ({
    id, name, slug: 'manual_class', updatedAt: 0,
    classes: [{ value: 0, label: 'Unclassified', color: [0.5, 0.5, 0.5] }],
  });
  const seedRaw = (value: unknown) => window.electronAPI.store.set(KEY, value);

  beforeEach(async () => { await seedRaw([]); });

  it('starts empty and round-trips a saved palette', async () => {
    expect(await getClassPalettes()).toEqual([]);
    await saveClassPalette(pal('p1', 'Mine'), NOW);
    const all = await getClassPalettes();
    expect(all).toHaveLength(1);
    expect(all[0].name).toBe('Mine');
    expect(all[0].updatedAt).toBe(NOW);
  });

  it('replaces by id rather than appending a duplicate', async () => {
    await saveClassPalette(pal('p1', 'First'), NOW);
    await saveClassPalette(pal('p1', 'Renamed'), NOW + 1);
    const all = await getClassPalettes();
    expect(all).toHaveLength(1);
    expect(all[0].name).toBe('Renamed');
  });

  it('preserves position when replacing, so the list does not reshuffle', async () => {
    await saveClassPalette(pal('a'), NOW);
    await saveClassPalette(pal('b'), NOW);
    await saveClassPalette(pal('a', 'a-edited'), NOW + 1);
    expect((await getClassPalettes()).map((p) => p.id)).toEqual(['a', 'b']);
  });

  it('deletes by id', async () => {
    await saveClassPalette(pal('a'), NOW);
    await saveClassPalette(pal('b'), NOW);
    expect((await deleteClassPalette('a')).map((p) => p.id)).toEqual(['b']);
  });

  it('skips malformed records instead of failing the whole library', async () => {
    // One bad entry (hand-edited store, older format) must not make every
    // palette unreadable.
    await seedRaw([pal('good'), { junk: true }, null]);
    const all = await getClassPalettes();
    expect(all).toHaveLength(1);
    expect(all[0].id).toBe('good');
  });

  it('exports and re-imports, replacing same-id palettes', async () => {
    await saveClassPalette(pal('shared', 'v1'), NOW);
    const json = await exportClassPalettes();

    await saveClassPalette(pal('shared', 'local-edit'), NOW);
    expect(await importClassPalettes(json, NOW + 5)).toBe(1);
    const all = await getClassPalettes();
    expect(all).toHaveLength(1);
    expect(all[0].name).toBe('v1');          // the imported copy wins
    expect(all[0].updatedAt).toBe(NOW + 5);
  });

  it('import merges rather than replacing the whole library', async () => {
    await saveClassPalette(pal('mine'), NOW);
    await importClassPalettes(JSON.stringify([pal('theirs')]), NOW);
    expect((await getClassPalettes()).map((p) => p.id).sort()).toEqual(['mine', 'theirs']);
  });

  it('importing junk entries is a no-op, and bad JSON throws', async () => {
    await saveClassPalette(pal('mine'), NOW);
    expect(await importClassPalettes(JSON.stringify([{ junk: true }]), NOW)).toBe(0);
    expect((await getClassPalettes()).map((p) => p.id)).toEqual(['mine']);
    await expect(importClassPalettes('{not json', NOW)).rejects.toThrow();
  });
});
