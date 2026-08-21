import { useCallback, useEffect, useState } from 'react';
import { CheckCircle2, AlertCircle, Loader2 } from 'lucide-react';
import { getRieglStatus, type RieglStatus } from '../utils/backendApi';

// DELIBERATELY NOT CACHED FOR THE SESSION, unlike ComputePathBadge.
//
// That badge caches because GPU presence cannot change while the app runs.
// RIEGL availability can, and routinely does: the user starts Docker Desktop,
// picks a RiVLib folder, or builds the image — all mid-session, often in direct
// response to this badge telling them what is missing. A session cache would
// leave it reading "unavailable" until an app restart, right when the user has
// just fixed the problem.
//
// So each mount probes, and `refresh()` re-probes on demand. The probe is cheap
// (two short docker calls) and only runs where the badge is actually shown.

export interface RieglStatusBadgeProps {
  /** The user's configured RiVLib directory (null when unset). */
  rivlibPath: string | null;
  /**
   * Called with each fetched status, or `null` when the backend cannot be
   * reached. Parents MUST handle null by clearing whatever they derived from
   * the last status — a stale checklist describing an unreachable machine is
   * worse than showing nothing.
   */
  onStatus?: (status: RieglStatus | null) => void;
  /** Bump to force a re-probe (e.g. after the user picks a folder). */
  refreshKey?: number;
}

/**
 * A small pill showing whether RIEGL .riproject import is ready on this machine.
 *
 * Unlike most capability badges this one stays visible when the feature is
 * UNAVAILABLE: "not available" is the state the user most needs to see and act
 * on, and the tooltip carries the specific remediation (start Docker, choose a
 * RiVLib folder, build the image). It renders nothing only while the first
 * probe is in flight or if the backend cannot be reached at all.
 */
export function RieglStatusBadge({
  rivlibPath,
  onStatus,
  refreshKey = 0,
}: RieglStatusBadgeProps) {
  const [status, setStatus] = useState<RieglStatus | null>(null);
  const [loading, setLoading] = useState(true);

  const probe = useCallback(
    (signal?: AbortSignal) =>
      getRieglStatus(rivlibPath, signal)
        .then((s) => {
          setStatus(s);
          onStatus?.(s);
        })
        .catch(() => {
          // Backend unreachable (still starting, or down). Clear BOTH our own
          // state and the parent's: leaving the parent holding the last good
          // status would render a checklist describing a machine we can no
          // longer see. `null` means "unknown", which is honest; the retry
          // below is what turns it back into a real answer.
          setStatus(null);
          onStatus?.(null);
          throw new Error('unreachable');
        })
        .finally(() => setLoading(false)),
    // `onStatus` is deliberately excluded: callers commonly pass an inline
    // arrow, which would change identity every render and re-probe in a loop.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [rivlibPath],
  );

  useEffect(() => {
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    let attempt = 0;

    // RETRY, don't give up on the first failure. In `npm run dev` a rebuild
    // restarts the backend while the renderer stays up (or remounts first), so
    // a probe fired in that window gets a connection error — and a single-shot
    // probe would then show "Docker not running / image not built" until the
    // whole dev session was restarted, which is a lie about the machine's
    // actual state. Back off a few times to cover a normal restart instead.
    const run = () => {
      void probe(controller.signal).catch(() => {
        if (controller.signal.aborted || attempt >= 5) return;
        // 0.5s, 1s, 2s, 4s, 8s — ~15s total, comfortably longer than a backend
        // restart, and it stops rather than polling forever.
        const delay = 500 * 2 ** attempt;
        attempt += 1;
        timer = setTimeout(run, delay);
      });
    };

    setLoading(true);
    run();
    return () => {
      controller.abort();
      if (timer) clearTimeout(timer);
    };
  }, [probe, refreshKey]);

  if (loading && !status) {
    return (
      <span
        data-testid="riegl-status-badge"
        data-state="loading"
        className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[10px] font-medium border bg-neutral-700/60 text-neutral-300 border-neutral-600/50"
      >
        <Loader2 className="w-3 h-3 animate-spin" />
        Checking…
      </span>
    );
  }

  if (!status) return null;

  return (
    <span
      data-testid="riegl-status-badge"
      data-state={status.available ? 'ready' : 'unavailable'}
      title={status.reason}
      className={`inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[10px] font-medium border ${
        status.available
          ? 'bg-green-500/15 text-green-300 border-green-500/30'
          : 'bg-amber-500/15 text-amber-300 border-amber-500/30'
      }`}
    >
      {status.available ? (
        <CheckCircle2 className="w-3 h-3" />
      ) : (
        <AlertCircle className="w-3 h-3" />
      )}
      {status.available ? 'RIEGL ready' : 'RIEGL unavailable'}
    </span>
  );
}
