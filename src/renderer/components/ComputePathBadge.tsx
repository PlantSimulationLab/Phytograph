import { useEffect, useState } from 'react';
import { Cpu, Zap } from 'lucide-react';
import { getDeviceInfo, type DeviceInfo } from '../utils/backendApi';

// Device capabilities (GPU compiled-in + present) don't change while the app
// runs, so fetch once and share across every badge instance for the session.
let cached: DeviceInfo | null = null;
let inflight: Promise<DeviceInfo> | null = null;

function loadDeviceInfo(): Promise<DeviceInfo> {
  if (cached) return Promise.resolve(cached);
  if (!inflight) {
    inflight = getDeviceInfo()
      .then((d) => { cached = d; return d; })
      .finally(() => { inflight = null; });
  }
  return inflight;
}

/** Exposed for tests: drop the session cache. */
export function __resetComputePathBadgeCache() {
  cached = null;
  inflight = null;
}

/**
 * A small pill showing whether synthetic-scan ray tracing runs on the GPU or
 * CPU on this machine. Renders nothing until the backend answers (and silently
 * nothing if it can't), so it never blocks or clutters the UI. The tooltip
 * carries the full reason and GPU name.
 */
export function ComputePathBadge() {
  const [info, setInfo] = useState<DeviceInfo | null>(cached);

  useEffect(() => {
    if (info) return;
    let cancelled = false;
    void loadDeviceInfo()
      .then((d) => { if (!cancelled) setInfo(d); })
      .catch(() => { /* leave the badge hidden if device info is unavailable */ });
    return () => { cancelled = true; };
  }, [info]);

  if (!info) return null;

  const isGpu = info.effectivePath === 'gpu';
  const tooltip = info.gpuName ? `${info.reason} (${info.gpuName})` : info.reason;

  return (
    <span
      data-testid="compute-path-badge"
      data-path={info.effectivePath}
      title={tooltip}
      className={`inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[10px] font-medium border ${
        isGpu
          ? 'bg-green-500/15 text-green-300 border-green-500/30'
          : 'bg-neutral-700/60 text-neutral-300 border-neutral-600/50'
      }`}
    >
      {isGpu ? <Zap className="w-3 h-3" /> : <Cpu className="w-3 h-3" />}
      {isGpu ? 'GPU' : 'CPU'}
    </span>
  );
}
