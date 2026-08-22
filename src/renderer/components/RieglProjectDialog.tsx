import { useCallback, useEffect, useMemo, useState } from 'react';
import { X, Loader2, AlertTriangle } from 'lucide-react';
import {
  inspectRieglProject,
  type RieglFrame,
  type RieglProject,
  type RieglScanPosition,
} from '../utils/backendApi';

export interface RieglProjectSelection {
  scans: string[];
  frame: RieglFrame;
}

export interface RieglProjectDialogProps {
  /** Absolute path to the .riproject / .PROJ directory, or null when closed. */
  projectPath: string | null;
  rivlibPath: string | null;
  /** Resolves with the chosen positions and frame, or null if cancelled. */
  onResolve: (selection: RieglProjectSelection | null) => void;
}

/**
 * Scan-position picker for a RIEGL project (.riproject or .PROJ).
 *
 * A project holds several scan positions and a user rarely wants all of them —
 * each is hundreds of megabytes once decoded, so choosing up front avoids
 * minutes of work per unwanted position.
 *
 * The dialog also carries the thing about the data that will surprise people,
 * which differs by layout:
 *
 *   .riproject — the scans are UNREGISTERED. They come off the scanner in their
 *     own frames, and the GNSS-derived layout shown here is a metres-level prior
 *     for seeding ICP, not a placement.
 *   .PROJ — registration is present but usually PARTIAL. In the reference olive
 *     project only 9 of 24 positions registered; the rest fall back to the
 *     inclinometer/GNSS prior and still want ICP. Showing that per position
 *     beats explaining a partly-aligned pile afterwards.
 *
 * Inspect always runs in the `registered` frame regardless of the checkbox
 * below, because that is what yields the SOPs the plan view draws. The checkbox
 * only decides what the EXTRACT is asked for, so toggling it costs no round
 * trip.
 */

const REGISTRATION_BADGE: Record<
  string,
  { label: string; title: string; className: string }
> = {
  registered: {
    label: 'registered',
    title: 'Placed by the project\u2019s own registration result.',
    className: 'text-lime-400',
  },
  prior: {
    label: 'prior only',
    title:
      'No registration result — placed from the inclinometer/compass/GNSS ' +
      'estimate, which is accurate to about a metre. Refine with ICP.',
    className: 'text-amber-400',
  },
  none: {
    label: 'no pose',
    title: 'No pose at all — this position imports at the origin.',
    className: 'text-amber-400',
  },
};

/** Plan-view position: the surveyed pose when there is one, else the GNSS prior. */
function planPoint(s: RieglScanPosition): { e: number; n: number } | null {
  if (s.sop) return { e: s.sop[0][3], n: s.sop[1][3] };
  if (s.enu) return { e: s.enu.east_m, n: s.enu.north_m };
  return null;
}

export function RieglProjectDialog({
  projectPath,
  rivlibPath,
  onResolve,
}: RieglProjectDialogProps) {
  const [project, setProject] = useState<RieglProject | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  // Opt OUT of registration, not into it: a project that carries poses should
  // use them by default, and the user who wants the exact scanner-local LAD
  // raster is the one making the deliberate choice.
  const [keepLocal, setKeepLocal] = useState(false);
  // Levelling a .riproject is ON by default: the inclinometer is survey-grade
  // and an unlevelled cloud silently breaks ground/DEM assumptions.
  const [levelScans, setLevelScans] = useState(true);

  useEffect(() => {
    if (!projectPath) {
      setProject(null);
      setError(null);
      setSelected(new Set());
      setKeepLocal(false);
      // Back to the default too, matching keepLocal: a choice made for one
      // project should not silently carry into the next one.
      setLevelScans(true);
      return;
    }
    const controller = new AbortController();
    setProject(null);
    setError(null);
    // Always 'registered': this is what makes the reader resolve each SOP, which
    // is what the plan view and the per-position badges are drawn from. The
    // frame the user picks applies to the extract, not to this preview.
    inspectRieglProject(projectPath, rivlibPath, controller.signal, 'registered')
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

  // Plan-view extents, used to normalise the mini-map. Drawn from the surveyed
  // poses where a project has them and the GNSS prior otherwise, so a .PROJ
  // shows its real geometry rather than a metres-level approximation of it.
  const layout = useMemo(() => {
    const pts = (project?.scans ?? [])
      .map(planPoint)
      .filter((pt): pt is { e: number; n: number } => !!pt);
    if (pts.length === 0) return null;
    const es = pts.map((p) => p.e);
    const ns = pts.map((p) => p.n);
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
  const isProj = project?.layout === 'proj';
  const registeredCount = scans.filter(
    (s) => s.registration === 'registered',
  ).length;
  // A .PROJ is imported registered unless the user opts out; a .riproject has
  // no registration to apply, so it is never "registered" whatever is ticked.
  const useRegistered = isProj && !keepLocal;
  // ...but a .riproject CAN still be levelled by each position's own
  // inclinometer, which is a different and much weaker claim than registration:
  // plumb-correct, not aligned. Only offered when at least one selected
  // position actually measured an attitude — several real projects have
  // positions that recorded none.
  const levelableNames = new Set(
    scans.filter((s) => s.sensor_pose).map((s) => s.name),
  );
  const canLevel = !isProj && levelableNames.size > 0;
  const levelableSelected = [...selected].filter((n) =>
    levelableNames.has(n),
  ).length;
  const useSensor = canLevel && levelScans;
  const frame: RieglFrame = useRegistered
    ? 'registered'
    : useSensor
      ? 'sensor'
      : 'local';
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
                    // Three tiers of certainty, and the prefix says which:
                    // exact after extraction, a floor from a bounded probe, or
                    // an estimate from the file size when nothing was decoded
                    // (a .PROJ preview reads no points at all).
                    const count =
                      s.point_count ??
                      s.point_count_probed ??
                      s.point_count_estimated;
                    const countPrefix =
                      s.point_count != null
                        ? ''
                        : s.point_count_probed != null
                          ? '\u2265'
                          : '~';
                    const badge = s.registration
                      ? REGISTRATION_BADGE[s.registration]
                      : undefined;
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
                                    {countPrefix}
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
                                {/* What decides where this cloud lands. On a
                                    registered import that is the pose and how
                                    it was obtained; otherwise it is whether
                                    there is a GNSS fix at all, since without
                                    one the position imports at the origin on
                                    top of everything else. Either way it is
                                    worth knowing per-scan BEFORE the import. */}
                                {' · '}
                                {useRegistered && badge ? (
                                  <span
                                    data-testid={`riegl-scan-registration-${s.name}`}
                                    data-registration={s.registration}
                                    title={badge.title}
                                    className={badge.className}
                                  >
                                    {badge.label}
                                  </span>
                                ) : (
                                  <span
                                    data-testid={`riegl-scan-gnss-${s.name}`}
                                    data-gnss={s.gnss ? 'true' : 'false'}
                                    className={s.gnss ? 'text-neutral-500' : 'text-amber-400'}
                                  >
                                    {s.gnss ? 'GNSS ✓' : 'no GNSS'}
                                  </span>
                                )}
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
                      const pt = planPoint(s);
                      if (!pt) return null;
                      const x =
                        ((pt.e - layout.minE) / (layout.maxE - layout.minE)) *
                        100;
                      // SVG y grows downward; north should point up.
                      const y =
                        100 -
                        ((pt.n - layout.minN) / (layout.maxN - layout.minN)) *
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

              {/* A .riproject has no registration, but it does carry the
                  instrument's own inclinometer — enough to stand the cloud
                  upright, not to align it. Kept verbally distinct from the
                  .PROJ toggle below so "levelled" is never read as "placed". */}
              {canLevel && (
                <label
                  data-testid="riegl-level-toggle"
                  data-level-scans={levelScans ? 'true' : 'false'}
                  className="mt-4 flex items-start gap-2 px-2 py-2 rounded bg-neutral-900/50 border border-neutral-700/60 cursor-pointer"
                >
                  <input
                    type="checkbox"
                    data-testid="riegl-level-scans"
                    checked={levelScans}
                    onChange={(e) => setLevelScans(e.target.checked)}
                    className="mt-0.5"
                  />
                  <span className="text-[11px] text-neutral-400">
                    <span className="text-neutral-300">
                      Level using the onboard inclination sensor
                    </span>
                    <span className="block mt-0.5">
                      Stands each position upright using its own tilt reading,
                      which is accurate to a few hundredths of a degree. Ground
                      segmentation, DEM and terrain slope all assume a plumb
                      cloud, so this is worth leaving on.{' '}
                      <span className="text-neutral-300">
                        It does not align the scans to each other or to north
                      </span>{' '}
                      — the scanner&rsquo;s compass is far too coarse for that,
                      so you still need ICP.
                      {levelableSelected < selected.size && (
                        <>
                          {' '}
                          {selected.size - levelableSelected} of the{' '}
                          {selected.size} selected position
                          {selected.size === 1 ? '' : 's'} recorded no tilt and
                          will import unlevelled.
                        </>
                      )}
                    </span>
                  </span>
                </label>
              )}

              {/* Only a .PROJ has poses to apply, so the choice is only shown
                  where it exists. Offering it on a .riproject would imply an
                  alignment that raw scanner data simply does not carry. */}
              {isProj && (
                <label
                  data-testid="riegl-frame-toggle"
                  data-keep-local={keepLocal ? 'true' : 'false'}
                  className="mt-4 flex items-start gap-2 px-2 py-2 rounded bg-neutral-900/50 border border-neutral-700/60 cursor-pointer"
                >
                  <input
                    type="checkbox"
                    data-testid="riegl-keep-local"
                    checked={keepLocal}
                    onChange={(e) => setKeepLocal(e.target.checked)}
                    className="mt-0.5"
                  />
                  <span className="text-[11px] text-neutral-400">
                    <span className="text-neutral-300">
                      Keep scanner-local coordinates
                    </span>
                    <span className="block mt-0.5">
                      Imports each position unregistered, in its own frame, as a
                      .riproject does. Leaf Area Density models a scan as an
                      origin plus a &theta;/&phi; sweep with no tilt, so this is
                      the exact case for it &mdash; at the cost of scans that
                      are not aligned to each other and ground that is not
                      level.
                    </span>
                  </span>
                </label>
              )}

              <div className="mt-4 space-y-1.5 text-[11px] text-amber-300/90">
                <div className="flex items-start gap-1.5">
                  <AlertTriangle className="w-3.5 h-3.5 mt-px shrink-0" />
                  {useRegistered ? (
                    <span data-testid="riegl-registration-summary">
                      <strong>
                        {registeredCount} of {scans.length}
                      </strong>{' '}
                      position(s) carry a registration and are placed from it.
                      {registeredCount < scans.length && (
                        <>
                          {' '}
                          The rest fall back to the scanner&rsquo;s own
                          inclinometer/GNSS estimate &mdash; accurate to about a
                          metre, so refine them with ICP.
                        </>
                      )}
                    </span>
                  ) : (
                    <span data-testid="riegl-unregistered-warning">
                      These scans are <strong>not registered</strong>.
                      {isProj
                        ? ' The project\u2019s registration is being skipped at your request, so each position imports into its own frame'
                        : useSensor
                          ? ' Raw scanner data carries no alignment. Each position is stood upright by its own tilt sensor, but imports into its own frame'
                          : ' Raw scanner data has no alignment, so each position imports into its own frame'}
                      {anyGnss
                        ? ', offset by its GNSS fix — a metres-level starting point for ICP, not a placement.'
                        : '. No GNSS fix was found, so all positions import at the origin.'}
                    </span>
                  )}
                </div>
                <div className="text-neutral-500 pl-5">
                  Sky/miss points are recovered from the scanner's per-shot
                  record, so Leaf Area Density is available. They are hidden by
                  default &mdash; use <em>Show sky/miss points</em> to see them.
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
              onClick={() =>
                onResolve({
                  scans: [...selected],
                  frame,
                })
              }
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
