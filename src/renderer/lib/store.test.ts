import { describe, expect, it } from 'vitest';
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
} from './store';

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
    expect(settings).toEqual({ theme: 'light', triangulateMaxPoints: 5_000_000 });
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
    expect(parsed.settings).toEqual({ theme: 'light', triangulateMaxPoints: 5_000_000 });
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
