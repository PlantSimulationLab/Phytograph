import { useState, useEffect, useCallback } from 'react';
import { X, Settings as SettingsIcon } from 'lucide-react';
import { DebouncedNumberInput } from './DebouncedNumberInput';
import { getSettings, updateSettings, type AppSettings } from '../lib/store';
import { POINT_CLOUD_FORMATS, MESH_FORMATS, SKELETON_FORMATS } from '../lib/pointCloudParsers';

interface SettingsDialogProps {
  isOpen: boolean;
  onClose: () => void;
}

// App-wide preferences, persisted via electron-store (src/renderer/lib/store.ts).
// Replaces the old full-page Settings "view" that had no way out and exposed no
// real settings. These are genuinely global (not per-cloud) defaults; per-session
// overrides still live in the viewer's Display panel.
//
// Opened from the app/File menu (⌘,/Ctrl+,). Closes on X, backdrop click, or Esc.
export function SettingsDialog({ isOpen, onClose }: SettingsDialogProps) {
  const [settings, setSettings] = useState<AppSettings | null>(null);
  const [appVersion, setAppVersion] = useState<string | null>(null);

  // Load persisted settings + the real app version each time the dialog opens, so
  // it always reflects what's on disk (another surface could have changed it).
  useEffect(() => {
    if (!isOpen) return;
    let cancelled = false;
    getSettings()
      .then((s) => {
        if (!cancelled) setSettings(s);
      })
      .catch(() => {});
    void window.electronAPI?.backend
      ?.getInfo()
      .then((i) => {
        if (!cancelled) setAppVersion(i.appVersion);
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [isOpen]);

  // Esc closes. Capture at document level so it works regardless of focus.
  useEffect(() => {
    if (!isOpen) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.stopPropagation();
        onClose();
      }
    };
    document.addEventListener('keydown', onKey, true);
    return () => document.removeEventListener('keydown', onKey, true);
  }, [isOpen, onClose]);

  // Optimistically update local state and persist. Each control commits its own
  // field so the dialog has no separate "Save" step.
  const patch = useCallback((updates: Partial<AppSettings>) => {
    setSettings((prev) => (prev ? { ...prev, ...updates } : prev));
    updateSettings(updates).catch(() => {});
  }, []);

  // The memory-budget field is optional (blank = use Helios's default), so it's a
  // raw text draft rather than a DebouncedNumberInput. Seed the draft from the
  // loaded value; commit on blur/Enter, mapping blank or non-positive -> null.
  const [budgetDraft, setBudgetDraft] = useState('');
  useEffect(() => {
    setBudgetDraft(
      settings?.syntheticScanMemoryBudgetMb != null
        ? String(settings.syntheticScanMemoryBudgetMb)
        : '',
    );
  }, [settings?.syntheticScanMemoryBudgetMb]);
  const commitBudget = useCallback(() => {
    const trimmed = budgetDraft.trim();
    if (trimmed === '') {
      patch({ syntheticScanMemoryBudgetMb: null });
      return;
    }
    const n = parseInt(trimmed, 10);
    // Reject non-finite / non-positive: snap back to the persisted value.
    patch({ syntheticScanMemoryBudgetMb: Number.isFinite(n) && n > 0 ? n : null });
  }, [budgetDraft, patch]);

  if (!isOpen) return null;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center" onKeyDown={(e) => e.stopPropagation()}>
      <div className="absolute inset-0 bg-black/60 backdrop-blur-sm" onClick={onClose} />

      <div
        data-testid="settings-dialog"
        className="relative bg-neutral-800 rounded-xl shadow-2xl border border-neutral-700 w-full max-w-lg mx-4 max-h-[85vh] flex flex-col overflow-hidden"
      >
        <div className="flex items-center justify-between px-4 py-3 border-b border-neutral-700 bg-neutral-800/90">
          <div className="flex items-center gap-2 text-sm font-medium text-neutral-200">
            <SettingsIcon className="w-4 h-4 text-neutral-400" />
            Settings
          </div>
          <button
            data-testid="settings-dialog-close"
            onClick={onClose}
            className="p-1 rounded hover:bg-neutral-700 transition-colors"
          >
            <X className="w-4 h-4 text-neutral-400" />
          </button>
        </div>

        <div className="px-5 py-4 overflow-y-auto space-y-6">
          {/* Display */}
          <section>
            <h3 className="text-xs font-semibold uppercase tracking-wide text-neutral-500 mb-3">Display</h3>

            <div className="space-y-4">
              <div className="flex items-center justify-between gap-4">
                <div>
                  <label className="block text-sm text-neutral-200">Default background</label>
                  <p className="text-[11px] text-neutral-500">Viewer canvas color on launch.</p>
                </div>
                <div className="flex rounded-md overflow-hidden border border-neutral-600">
                  {(['black', 'white'] as const).map((c) => (
                    <button
                      key={c}
                      data-testid={`settings-bg-${c}`}
                      onClick={() => patch({ defaultBackgroundColor: c })}
                      className={`px-3 py-1.5 text-xs capitalize transition-colors ${
                        settings?.defaultBackgroundColor === c
                          ? 'bg-neutral-600 text-white'
                          : 'bg-neutral-700 text-neutral-300 hover:bg-neutral-600/60'
                      }`}
                    >
                      {c}
                    </button>
                  ))}
                </div>
              </div>

              <div className="flex items-center justify-between gap-4">
                <div>
                  <label className="block text-sm text-neutral-200">Default point size</label>
                  <p className="text-[11px] text-neutral-500">Render size for newly-loaded clouds.</p>
                </div>
                <DebouncedNumberInput
                  data-testid="settings-default-point-size"
                  min={0.1}
                  max={20}
                  step={0.5}
                  value={settings?.defaultPointSize ?? 1}
                  onCommit={(v) => patch({ defaultPointSize: v })}
                  className="w-24 bg-neutral-700 text-neutral-200 text-sm rounded px-2 py-1.5 border border-neutral-600"
                />
              </div>

              <div className="flex items-center justify-between gap-4">
                <div>
                  <label className="block text-sm text-neutral-200">Scan marker size</label>
                  <p className="text-[11px] text-neutral-500">Scale factor for scan-position model markers (1 = real-world size).</p>
                </div>
                <DebouncedNumberInput
                  data-testid="settings-scan-marker-scale"
                  min={0.1}
                  max={20}
                  step={0.25}
                  value={settings?.scanMarkerScale ?? 1}
                  onCommit={(v) => patch({ scanMarkerScale: v })}
                  className="w-24 bg-neutral-700 text-neutral-200 text-sm rounded px-2 py-1.5 border border-neutral-600"
                />
              </div>
            </div>
          </section>

          {/* Performance */}
          <section>
            <h3 className="text-xs font-semibold uppercase tracking-wide text-neutral-500 mb-3">Performance</h3>
            <div className="flex items-start justify-between gap-4">
              <div className="flex-1">
                <label className="block text-sm text-neutral-200">Triangulate max points</label>
                <p className="text-[11px] text-neutral-500 leading-snug">
                  Streamed (octree) clouds are downsampled to this many points before triangulation to bound
                  memory. You'll be warned when a cloud is downsampled.
                </p>
              </div>
              <DebouncedNumberInput
                data-testid="settings-triangulate-max-points"
                min={1000}
                step={100000}
                parse={(s) => parseInt(s, 10)}
                value={settings?.triangulateMaxPoints ?? 5_000_000}
                onCommit={(v) => patch({ triangulateMaxPoints: v })}
                className="w-32 bg-neutral-700 text-neutral-200 text-sm rounded px-2 py-1.5 border border-neutral-600"
              />
            </div>
            <div className="flex items-start justify-between gap-4 mt-4">
              <div className="flex-1">
                <label className="block text-sm text-neutral-200">Miss detection distance (m)</label>
                <p className="text-[11px] text-neutral-500 leading-snug">
                  Fallback for tagging sky/miss points in scans that carry no <code>is_miss</code> column and no
                  <code> target_index</code> sentinel: points farther than this from the scanner are treated as
                  misses and excluded from the view. Defaults to Helios's 1001&nbsp;m placeholder distance.
                </p>
              </div>
              <DebouncedNumberInput
                data-testid="settings-miss-distance"
                min={1}
                max={100000}
                step={10}
                value={settings?.missDistanceThreshold ?? 1001}
                onCommit={(v) => patch({ missDistanceThreshold: v })}
                className="w-32 bg-neutral-700 text-neutral-200 text-sm rounded px-2 py-1.5 border border-neutral-600"
              />
            </div>
            <div className="flex items-start justify-between gap-4 mt-4">
              <div className="flex-1">
                <label className="block text-sm text-neutral-200">Synthetic scan memory budget (MB)</label>
                <p className="text-[11px] text-neutral-500 leading-snug">
                  Soft cap on the ray-tracing scratch buffers during a synthetic scan. Lower it to reduce peak
                  RAM on very large scans &mdash; the beam fan-out is chunked to stay near this budget, with
                  identical results. Leave blank to use Helios's automatic default (&asymp;4&nbsp;GiB on this build).
                </p>
              </div>
              {/* Optional field: blank => null => Helios default. DebouncedNumberInput
                  can't represent "cleared" (it only commits finite parses), so per
                  the CLAUDE.md guidance this is a raw text input over a string draft
                  parsed at commit, mapping empty -> null. */}
              <input
                type="text"
                inputMode="numeric"
                data-testid="settings-synthetic-scan-memory-budget"
                placeholder="default"
                value={budgetDraft}
                onChange={(e) => setBudgetDraft(e.target.value)}
                onBlur={commitBudget}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') (e.target as HTMLInputElement).blur();
                }}
                className="w-32 bg-neutral-700 text-neutral-200 text-sm rounded px-2 py-1.5 border border-neutral-600"
              />
            </div>
          </section>

          {/* Supported formats (reference) */}
          <section>
            <h3 className="text-xs font-semibold uppercase tracking-wide text-neutral-500 mb-3">Supported formats</h3>
            <div className="space-y-3">
              <FormatGroup title="Point Clouds" accent="text-blue-400" badge="bg-blue-500/15 text-blue-300" formats={POINT_CLOUD_FORMATS} />
              <FormatGroup title="Meshes" accent="text-green-400" badge="bg-green-500/15 text-green-300" formats={MESH_FORMATS} />
              <FormatGroup title="Skeletons" accent="text-amber-400" badge="bg-amber-500/15 text-amber-300" formats={SKELETON_FORMATS} />
            </div>
          </section>
        </div>

        <div className="px-5 py-2.5 border-t border-neutral-700 flex items-center justify-between bg-neutral-800/90">
          <span className="text-[11px] text-neutral-500">
            Phytograph{appVersion ? ` ${appVersion}` : ''}
          </span>
          <button
            data-testid="settings-dialog-done"
            onClick={onClose}
            className="px-4 py-1.5 text-sm bg-neutral-700 hover:bg-neutral-600 text-neutral-100 rounded-md transition-colors"
          >
            Done
          </button>
        </div>
      </div>
    </div>
  );
}

function FormatGroup({
  title,
  accent,
  badge,
  formats,
}: {
  title: string;
  accent: string;
  badge: string;
  formats: readonly { ext: string; desc: string }[];
}) {
  return (
    <div>
      <h4 className={`text-xs font-medium mb-1.5 ${accent}`}>{title}</h4>
      <div className="grid grid-cols-2 gap-x-4 gap-y-1">
        {formats.map((f) => (
          <div key={f.ext} className="flex items-start gap-2 text-xs">
            <span className={`font-mono px-1.5 py-0.5 rounded ${badge}`}>{f.ext}</span>
            <span className="text-neutral-400">{f.desc}</span>
          </div>
        ))}
      </div>
    </div>
  );
}
