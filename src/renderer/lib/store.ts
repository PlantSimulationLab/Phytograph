// Persistent app data backed by electron-store via preload IPC.
// Replaces the previous @tauri-apps/plugin-store implementation.
// External API (TAG_COLORS, getSettings/updateSettings, tag CRUD, import/export)
// is unchanged so call sites keep working.

export const TAG_COLORS = [
  { name: 'slate', bg: 'bg-slate-100', text: 'text-slate-600', border: 'border-slate-200' },
  { name: 'red', bg: 'bg-red-100', text: 'text-red-600', border: 'border-red-200' },
  { name: 'orange', bg: 'bg-orange-100', text: 'text-orange-600', border: 'border-orange-200' },
  { name: 'amber', bg: 'bg-amber-100', text: 'text-amber-600', border: 'border-amber-200' },
  { name: 'yellow', bg: 'bg-yellow-100', text: 'text-yellow-600', border: 'border-yellow-200' },
  { name: 'lime', bg: 'bg-lime-100', text: 'text-lime-600', border: 'border-lime-200' },
  { name: 'green', bg: 'bg-green-100', text: 'text-green-600', border: 'border-green-200' },
  { name: 'emerald', bg: 'bg-emerald-100', text: 'text-emerald-600', border: 'border-emerald-200' },
  { name: 'teal', bg: 'bg-teal-100', text: 'text-teal-600', border: 'border-teal-200' },
  { name: 'cyan', bg: 'bg-cyan-100', text: 'text-cyan-600', border: 'border-cyan-200' },
  { name: 'sky', bg: 'bg-sky-100', text: 'text-sky-600', border: 'border-sky-200' },
  { name: 'blue', bg: 'bg-blue-100', text: 'text-blue-600', border: 'border-blue-200' },
  { name: 'indigo', bg: 'bg-indigo-100', text: 'text-indigo-600', border: 'border-indigo-200' },
  { name: 'violet', bg: 'bg-violet-100', text: 'text-violet-600', border: 'border-violet-200' },
  { name: 'purple', bg: 'bg-purple-100', text: 'text-purple-600', border: 'border-purple-200' },
  { name: 'fuchsia', bg: 'bg-fuchsia-100', text: 'text-fuchsia-600', border: 'border-fuchsia-200' },
  { name: 'pink', bg: 'bg-pink-100', text: 'text-pink-600', border: 'border-pink-200' },
  { name: 'rose', bg: 'bg-rose-100', text: 'text-rose-600', border: 'border-rose-200' },
] as const;

export type TagColorName = typeof TAG_COLORS[number]['name'];

export interface Tag {
  id: string;
  name: string;
  color: TagColorName;
  createdAt: string;
}

export interface AppSettings {
  theme: 'light' | 'dark';
  // Max points fed to triangulation for octree-backed clouds. open3d holds the
  // whole point set in RAM, so an uncapped 100M-point octree would OOM; the
  // backend stride-downsamples to this cap and the UI warns when it does.
  triangulateMaxPoints: number;
  // Default viewer background the 3D canvas opens with each session. The viewer
  // still lets you flip black/white per session; this is just the starting value.
  defaultBackgroundColor: 'black' | 'white';
  // Default render size (in px) for points in newly-loaded clouds. The viewer's
  // Display panel still adjusts the live size; this seeds it on launch.
  defaultPointSize: number;
}

export interface StoreData {
  tags: Tag[];
  settings: AppSettings;
}

const DEFAULT_SETTINGS: AppSettings = {
  theme: 'light',
  triangulateMaxPoints: 5_000_000,
  defaultBackgroundColor: 'black',
  defaultPointSize: 1,
};

const hasElectron = (): boolean => typeof window !== 'undefined' && !!window.electronAPI;

async function kvGet<T>(key: string): Promise<T | undefined> {
  if (hasElectron()) return window.electronAPI.store.get<T>(key);
  const raw = localStorage.getItem(`phytograph:${key}`);
  if (raw == null) return undefined;
  try { return JSON.parse(raw) as T; } catch { return undefined; }
}

async function kvSet(key: string, value: unknown): Promise<void> {
  if (hasElectron()) return window.electronAPI.store.set(key, value);
  localStorage.setItem(`phytograph:${key}`, JSON.stringify(value));
}

// Kept for parity with the Tauri API; electron-store autosaves so this is a no-op.
export async function initStore(): Promise<void> {
  // intentionally empty
}

export async function getSettings(): Promise<AppSettings> {
  const settings = await kvGet<Partial<AppSettings>>('settings');
  // Merge over defaults so a settings object persisted before a new field was
  // added still gets that field (e.g. triangulateMaxPoints for older stores).
  return { ...DEFAULT_SETTINGS, ...(settings ?? {}) };
}

export async function updateSettings(updates: Partial<AppSettings>): Promise<AppSettings> {
  const current = await getSettings();
  const next = { ...current, ...updates };
  await kvSet('settings', next);
  return next;
}

export async function exportData(): Promise<string> {
  const tags = (await kvGet<Tag[]>('tags')) ?? [];
  const settings = (await kvGet<AppSettings>('settings')) ?? DEFAULT_SETTINGS;
  return JSON.stringify({ tags, settings }, null, 2);
}

export async function importData(jsonString: string): Promise<void> {
  const data = JSON.parse(jsonString) as Partial<StoreData>;
  if (data.tags) await kvSet('tags', data.tags);
  if (data.settings) await kvSet('settings', data.settings);
}

// ==================== TAG FUNCTIONS ====================

export async function getTags(): Promise<Tag[]> {
  return (await kvGet<Tag[]>('tags')) ?? [];
}

export async function createTag(name: string, color: TagColorName): Promise<Tag> {
  const tags = await getTags();
  const exists = tags.some((t) => t.name.toLowerCase() === name.toLowerCase());
  if (exists) throw new Error(`Tag "${name}" already exists`);

  const newTag: Tag = {
    id: crypto.randomUUID(),
    name: name.toLowerCase().trim(),
    color,
    createdAt: new Date().toISOString(),
  };
  tags.push(newTag);
  await kvSet('tags', tags);
  return newTag;
}

export async function updateTag(
  id: string,
  updates: Partial<Pick<Tag, 'name' | 'color'>>,
): Promise<Tag | null> {
  const tags = await getTags();
  const index = tags.findIndex((t) => t.id === id);
  if (index === -1) return null;

  if (updates.name) {
    const exists = tags.some((t) => t.id !== id && t.name.toLowerCase() === updates.name!.toLowerCase());
    if (exists) throw new Error(`Tag "${updates.name}" already exists`);
    updates.name = updates.name.toLowerCase().trim();
  }

  tags[index] = { ...tags[index], ...updates };
  await kvSet('tags', tags);
  return tags[index];
}

export async function deleteTag(id: string): Promise<boolean> {
  const tags = await getTags();
  const target = tags.find((t) => t.id === id);
  if (!target) return false;
  await kvSet('tags', tags.filter((t) => t.id !== id));
  return true;
}

export async function getTagById(id: string): Promise<Tag | undefined> {
  const tags = await getTags();
  return tags.find((t) => t.id === id);
}

export function getTagColor(colorName: TagColorName) {
  return TAG_COLORS.find((c) => c.name === colorName) ?? TAG_COLORS[0];
}
