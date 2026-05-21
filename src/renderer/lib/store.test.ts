import { describe, expect, it } from 'vitest';
import {
  createTag,
  deleteTag,
  getSettings,
  getTagById,
  getTags,
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
    expect(settings).toEqual({ theme: 'light' });
  });

  it('updateSettings merges and persists', async () => {
    await updateSettings({ theme: 'dark' });
    const settings = await getSettings();
    expect(settings.theme).toBe('dark');
  });
});
