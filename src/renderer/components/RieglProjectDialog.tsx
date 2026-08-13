import { useCallback, useEffect, useMemo, useState } from 'react';
import { X, Loader2, AlertTriangle } from 'lucide-react';
import { inspectRieglProject, type RieglProject } from '../utils/backendApi';

export interface RieglProjectDialogProps {
  /** Absolute path to the .riproject directory, or null when closed. */
  projectPath: string | null;
  rivlibPath: string | null;
  /** Resolves with the chosen scan-position names, or null if cancelled. */
  onResolve: (scans: string[] | null) => void;
}

/**
 * Scan-position picker for a raw RIEGL project.
 *
 * A .riproject holds several scan positions and a user rarely wants all of
 * them — each is ~750 MB of LAS once extracted, so choosing up front avoids
 * minutes of work per unwanted position.
 *
 * The dialog also carries the one thing about raw RIEGL data that will surprise
 * people: the scans are UNREGISTERED. They come off the scanner in their own
 * frames, and the GNSS-derived layout shown here is a metres-level prior for
 * seeding ICP — not a placement. Saying so before the import is cheaper than
 * explaining a pile of overlapping clouds afterwards.
 */
export function RieglProjectDialog({
  projectPath,
  rivlibPath,
  onResolve,
}: RieglProjectDialogProps) {
  const [project, setProject] = useState<RieglProject | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [selected, setSelected] = useState<Set<string>>(new Set());

  useEffect(() => {
    if (!projectPath) {
      setProject(null);
      setError(null);
      setSelected(new Set());
      return;
    }
    const controller = new AbortController();
    setProject(null);
    setError(null);
    inspectRieglProject(projectPath, rivlibPath, controller.signal)
      .then((p) => {
        setProject(p);
        // Default to everything: a user who opened the project probably wants
        // it, and unchecking a few is less work than checking five.
        setSelected(new Set(p.scans.filter((s) => !s.error).map((s) => s.name)));
      })
      .catch((err: unknown) => {
        if (controller.signal.aborted) return;
        setError(err instanceof Error ? err.message : String(err));
      });
    return () => controller.abort();
  }, [projectPath, rivlibPath]);

  const toggle = useCallback((name: string) => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(name)) next.delete(name);
      else next.add(name);
      return next;
    });
  }, []);

  // Plan-view extents of the GNSS layout, used to normalise the mini-map.
  const layout = useMemo(() => {
    const pts = (project?.scans ?? [])
      .map((s) => s.enu)
      .filter((e): e is { east_m: number; north_m: number; up_m: number } => !!e);
    if (pts.length === 0) return null;
    const es = pts.map((p) => p.east_m);
    const ns = pts.map((p) => p.north_m);
    const pad = 2;
    return {
      minE: Math.min(...es) - pad,
      maxE: Math.max(...es) + pad,
      minN: Math.min(...ns) - pad,
      maxN: Math.max(...ns) + pad,
    };
  }, [project]);

  if (!projectPath) return null;

  const scans = project?.scans ?? [];
  const anyGnss = scans.some((s) => s.gnss);
  // Positions that CAN be imported. A failed read is shown (so its error is
  // visible) but is never selectable, so it must not count toward "all".
  const selectableNames = scans.filter((s) => !s.error).map((s) => s.name);
  const allSelected =
    selectableNames.length > 0 &&
    selectableNames.every((n) => selected.has(n));
  const someSelected = selectableNames.some((n) => selected.has(n));

  return (
    // z-[60] sits above the drag-drop overlay's z-50: this dialog is opened BY
    // a drop, so both can be on screen at once. At equal z-index the
    // later-rendered overlay won, hiding the dialog behind a blur.
    <div className="fixed inset-0 z-[60] flex items-center justify-center">
      <div
        className="absolute inset-0 bg-black/60 backdrop-blur-sm"
        onClick={() => onResolve(null)}
      />
      <div
        data-testid="riegl-project-dialog"
        className="relative bg-neutral-800 rounded-xl shadow-2xl border border-neutral-700 w-full max-w-2xl mx-4 max-h-[85vh] flex flex-col overflow-hidden"
      >
        <div className="flex items-center justify-between px-4 py-3 border-b border-neutral-700">
          <div className="text-sm font-medium text-neutral-200">
            Import RIEGL project
            <span className="ml-2 text-[11px] text-neutral-500 font-normal">
              {projectPath.split('/').pop()}
            </span>
          </div>
          <button
            data-testid="riegl-dialog-close"
            onClick={() => onResolve(null)}
            className="p-1 rounded hover:bg-neutral-700"
          >
            <X className="w-4 h-4 text-neutral-400" />
          </button>
        </div>

        <div className="px-5 py-4 overflow-y-auto">
          {!project && !error && (
            <div
              data-testid="riegl-dialog-loading"
              className="flex items-center gap-2 text-sm text-neutral-400 py-8 justify-center"
            >
              <Loader2 className="w-4 h-4 animate-spin" />
              Reading scan positions…
            </div>
          )}

          {error && (
            <div
              data-testid="riegl-dialog-error"
              className="flex items-start gap-2 text-sm text-red-400 py-6"
            >
              <AlertTriangle className="w-4 h-4 mt-0.5 shrink-0" />
              <span>{error}</span>
            </div>
          )}

          {project && (
            <>
              <div className="flex items-start gap-4">
                <div className="flex-1 space-y-1">
                  {/* Select-all. Only ever covers the SELECTABLE positions — a
                      scan that failed to read can't be imported, so including
                      it would let "all" mean something the Import button then
                      refuses. */}
                  <label className="flex items-center gap-2 px-2 py-1.5 border-b border-neutral-700/60 mb-1 cursor-pointer">
                    <input
                      type="checkbox"
                      data-testid="riegl-select-all"
                      ref={(el) => {
                        // Indeterminate can only be set via the DOM node, not
                        // as a prop; it is what distinguishes "some selected"
                        // from "none", which `checked` alone cannot express.
                        if (el) el.indeterminate = someSelected && !allSelected;
                      }}
                      checked={allSelected}
                      disabled={selectableNames.length === 0}
                      onChange={() =>
                        setSelected(
                          allSelected ? new Set() : new Set(selectableNames),
                        )
                      }
                    />
                    <span className="text-[11px] text-neutral-400">
                      {allSelected ? 'Deselect all' : 'Select all'}
                    </span>
                  </label>
                  {scans.map((s) => {
                    const count = s.point_count ?? s.point_count_probed;
                    const sp = s.scan_params;
                    return (
                      <label
                        key={s.name}
                        data-testid={`riegl-scan-row-${s.name}`}
                        data-selected={selected.has(s.name) ? 'true' : 'false'}
                        className={`flex items-start gap-2 px-2 py-1.5 rounded cursor-pointer ${
                          s.error ? 'opacity-50' : 'hover:bg-neutral-700/50'
                        }`}
                      >
                        <input
                          type="checkbox"
                          data-testid={`riegl-scan-check-${s.name}`}
                          checked={selected.has(s.name)}
                          disabled={!!s.error}
                          onChange={() => toggle(s.name)}
                          className="mt-0.5"
                        />
                        <div className="min-w-0">
                          <div className="text-sm text-neutral-200">
                            {s.name}
                            {s.instrument?.model && (
                              <span className="ml-2 text-[11px] text-neutral-500">
                                {s.instrument.model}
                              </span>
                            )}
                          </div>
                          <div className="text-[11px] text-neutral-500">
                            {s.error ? (
                              <span className="text-red-400">{s.error}</span>
                            ) : (
                              <>
                                {count != null && (
                                  <>
                                    {/* An inspect only probes a prefix, so the
                                        count is a floor, not a total. */}
                                    {s.point_count != null ? '' : '≥'}
                                    {count.toLocaleString('en-US')} pts
                                  </>
                                )}
                                {sp?.theta_min != null && (
                                  <>
                                    {' · '}
                                    {sp.theta_min}–{sp.theta_max}° ×{' '}
                                    {sp.phi_min}–{sp.phi_max}°
                                  </>
                                )}
                                {/* Whether this position has a GNSS fix decides
                                    where its cloud lands: with one it is placed
                                    at its surveyed offset, without one it
                                    imports at the origin on top of everything
                                    else. Worth knowing per-scan, before the
                                    import rather than after. */}
                                {' · '}
                                <span
                                  data-testid={`riegl-scan-gnss-${s.name}`}
                                  data-gnss={s.gnss ? 'true' : 'false'}
                                  className={s.gnss ? 'text-neutral-500' : 'text-amber-400'}
                                >
                                  {s.gnss ? 'GNSS ✓' : 'no GNSS'}
                                </span>
                              </>
                            )}
                          </div>
                        </div>
                      </label>
                    );
                  })}
                </div>

                {/* Plan view of the GNSS layout. Cheap, and it makes an
                    implausible prior (a scan flung far from the rest by a bad
                    fix) obvious before minutes are spent extracting it. */}
                {layout && (
                  <svg
                    data-testid="riegl-layout-plan"
                    viewBox="0 0 100 100"
                    className="w-40 h-40 shrink-0 rounded bg-neutral-900/60 border border-neutral-700"
                  >
                    {scans.map((s) => {
                      if (!s.enu) return null;
                      const x =
                        ((s.enu.east_m - layout.minE) /
                          (layout.maxE - layout.minE)) *
                        100;
                      // SVG y grows downward; north should point up.
                      const y =
                        100 -
                        ((s.enu.north_m - layout.minN) /
                          (layout.maxN - layout.minN)) *
                          100;
                      const on = selected.has(s.name);
                      return (
                        <circle
                          key={s.name}
                          cx={x}
                          cy={y}
                          r={3}
                          className={on ? 'fill-lime-400' : 'fill-neutral-600'}
                        />
                      );
                    })}
                  </svg>
                )}
              </div>

              <div className="mt-4 space-y-1.5 text-[11px] text-amber-300/90">
                <div className="flex items-start gap-1.5">
                  <AlertTriangle className="w-3.5 h-3.5 mt-px shrink-0" />
                  <span data-testid="riegl-unregistered-warning">
                    These scans are <strong>not registered</strong>. Raw scanner
                    data has no alignment, so each position imports into its own
                    frame
                    {anyGnss
                      ? ', offset by its GNSS fix — a metres-level starting point for ICP, not a placement.'
                      : '. No GNSS fix was found, so all positions import at the origin.'}
                  </span>
                </div>
                <div className="text-neutral-500 pl-5">
                  Sky/miss points are not recovered from .rxp, so Leaf Area
                  Density is not available for these scans.
                </div>
              </div>
            </>
          )}
        </div>

        <div className="flex items-center justify-between px-4 py-3 border-t border-neutral-700">
          <div className="text-[11px] text-neutral-500">
            {project ? `${selected.size} of ${scans.length} selected` : ''}
          </div>
          <div className="flex gap-2">
            <button
              onClick={() => onResolve(null)}
              className="px-3 py-1.5 text-sm rounded text-neutral-300 hover:bg-neutral-700"
            >
              Cancel
            </button>
            <button
              data-testid="riegl-dialog-import"
              disabled={selected.size === 0}
              onClick={() => onResolve([...selected])}
              className="px-3 py-1.5 text-sm rounded bg-blue-600 text-white hover:bg-blue-500 disabled:opacity-50 disabled:cursor-not-allowed"
            >
              Import {selected.size > 0 ? selected.size : ''}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
