import { useEffect, useState } from 'react';
import { Cpu, Zap } from 'lucide-react';
import {
  getMlDevice,
  listMlModels,
  type MlDeviceInfo,
  type MlModelSummary,
} from '../../../utils/backendApi';

// Model picker + GPU/CPU pill shared by the ML tools (wood/leaf, plant organs).
//
// The installed models and the ML device cannot change under a running backend
// (an import adds a model, but only through a flow that reloads this), so they
// are fetched once per session per task and shared across panel openings. The
// device probe spawns a worker that imports torch (a few seconds, once), so it
// is shared across tasks too.
type MlState = { models: MlModelSummary[]; device: MlDeviceInfo | null };
const cache = new Map<string, MlState>();
const inflight = new Map<string, Promise<MlState>>();
let deviceInflight: Promise<MlDeviceInfo | null> | null = null;

function loadDevice(): Promise<MlDeviceInfo | null> {
  if (!deviceInflight) {
    // A failure only hides the pill, it never blocks running the model.
    deviceInflight = getMlDevice().catch(() => null);
  }
  return deviceInflight;
}

function loadMl(task: string): Promise<MlState> {
  const hit = cache.get(task);
  if (hit) return Promise.resolve(hit);
  let p = inflight.get(task);
  if (!p) {
    p = Promise.all([listMlModels(task), loadDevice()])
      .then(([models, device]) => {
        const state = { models, device };
        cache.set(task, state);
        return state;
      })
      .finally(() => { inflight.delete(task); });
    inflight.set(task, p);
  }
  return p;
}

/** Exposed for tests: drop the session cache. */
export function __resetMlModelCache() {
  cache.clear();
  inflight.clear();
  deviceInflight = null;
}

export function MlModelControls({
  task,
  testIdPrefix,
  noModelText,
  modelId,
  onModelIdChange,
  disabled,
}: {
  task: string;
  // data-testid prefix: `${prefix}-ml-controls`, `-ml-model`, `-ml-device`.
  testIdPrefix: string;
  noModelText: string;
  modelId: string | null;
  onModelIdChange: (id: string | null) => void;
  disabled: boolean;
}) {
  const [ml, setMl] = useState<MlState | null>(cache.get(task) ?? null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    if (ml) return;
    let cancelled = false;
    loadMl(task)
      .then((r) => { if (!cancelled) setMl(r); })
      .catch((e) => { if (!cancelled) setError(String(e?.message ?? e)); });
    return () => { cancelled = true; };
  }, [ml, task]);

  if (error) {
    return <div className="text-[9px] text-red-300 mt-1">Could not list models: {error}</div>;
  }
  if (!ml) {
    return <div className="text-[9px] text-neutral-500 mt-1">Loading models…</div>;
  }
  const { models, device } = ml;
  const selected = models.find((m) => m.id === modelId) ?? models.find((m) => m.is_default) ?? models[0];
  const accel = device && device.device !== 'cpu';
  return (
    <div className="mt-2" data-testid={`${testIdPrefix}-ml-controls`}>
      {models.length > 1 && (
        <select
          data-testid={`${testIdPrefix}-ml-model`}
          value={selected?.id ?? ''}
          onChange={(e) => onModelIdChange(e.target.value)}
          disabled={disabled}
          className="w-full bg-neutral-700 text-neutral-200 text-xs rounded px-2 py-1 border border-neutral-600 mb-1"
        >
          {models.map((m) => (
            <option key={m.id} value={m.id}>
              {m.name}{m.origin === 'user' ? ' (imported)' : ''}
            </option>
          ))}
        </select>
      )}
      {models.length === 0 && (
        <div className="text-[9px] text-red-300">{noModelText}</div>
      )}
      {device && (
        <span
          data-testid={`${testIdPrefix}-ml-device`}
          data-device={device.device}
          title={device.deviceName ?? device.reason ?? ''}
          className={`inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[10px] font-medium border ${
            accel
              ? 'bg-green-500/15 text-green-300 border-green-500/30'
              : 'bg-neutral-700/60 text-neutral-300 border-neutral-600/50'
          }`}
        >
          {accel ? <Zap className="w-3 h-3" /> : <Cpu className="w-3 h-3" />}
          {accel ? 'GPU' : 'CPU'}
        </span>
      )}
      {device && !accel && (
        <div className="text-[9px] text-neutral-500 mt-1 leading-snug">
          No usable GPU, so this runs on the CPU: about a minute per 2 million points.
        </div>
      )}
    </div>
  );
}
