import { useEffect, useState } from 'react';
import { X, Radio, FileUp } from 'lucide-react';
import { DebouncedNumberInput } from './DebouncedNumberInput';
import {
  DEFAULT_SCAN_PARAMETERS,
  applyTrajectoryToParams,
  type PulseReturnMode,
  type SingleReturnSelection,
  type ScanParameters,
  type ScanPattern,
} from '../lib/scanParameters';
import {
  SCANNER_MODELS,
  getScannerModel,
  type ScannerModelId,
} from '../lib/scannerModels';
import {
  parseHeliosScanXml,
  HeliosXmlParseError,
  type HeliosXmlScan,
  type HeliosXmlGrid,
} from '../lib/heliosScanXml';
import {
  PoseStreamParseError,
  deriveMovingScanGrid,
  trajectoryDurationS,
} from '../lib/poseStream';
import { pickAndParseTrajectory } from '../lib/trajectoryImport';

// What the popup is doing in this open. Drives the title and submit-button
// labels — submission semantics are otherwise identical (the caller decides
// what to do with the resulting label+params).
//   - 'create'  : making a new scan from scratch (params-only). Default.
//   - 'attach'  : attaching params to an existing data-only scan.
//   - 'edit'    : editing the params of an existing scan.
export type ScanParametersPopupMode = 'create' | 'attach' | 'edit';

interface ScanParametersPopupProps {
  isOpen: boolean;
  onClose: () => void;
  // Called with the (possibly edited) label and finalised parameters. The
  // caller decides whether to attach to an existing scan or create a new one.
  onSubmit: (label: string, params: ScanParameters) => void;
  // When provided, the form opens pre-filled for editing. Otherwise a new
  // scan is created from DEFAULT_SCAN_PARAMETERS (with caller-supplied
  // overrides via `defaults`).
  initial?: { label: string; params: ScanParameters };
  defaults?: { label?: string; params?: Partial<ScanParameters> };
  mode?: ScanParametersPopupMode;
  // When true, the popup shows an "Import from XML" button. The caller
  // receives parsed Helios scans and grids along with the XML's on-disk path so
  // it can resolve any <filename> references relative to the XML directory and
  // create voxel-grid meshes from any <grid> blocks.
  showBulkImport?: boolean;
  onBulkImport?: (scans: HeliosXmlScan[], grids: HeliosXmlGrid[], xmlPath: string, warnings: string[]) => void | Promise<void>;
}

export function ScanParametersPopup({
  isOpen,
  onClose,
  onSubmit,
  initial,
  defaults,
  mode,
  showBulkImport,
  onBulkImport,
}: ScanParametersPopupProps) {
  // Resolve the active mode. `initial` implies 'edit'; otherwise default to
  // 'create' unless the caller explicitly asked for 'attach'.
  const activeMode: ScanParametersPopupMode = initial ? 'edit' : (mode ?? 'create');
  const titleText = activeMode === 'edit'
    ? 'Edit Scan Parameters'
    : activeMode === 'attach'
      ? 'Add Scan Metadata'
      : 'Add Scan';
  const submitText = activeMode === 'edit'
    ? 'Save Changes'
    : activeMode === 'attach'
      ? 'Add Metadata'
      : 'Add Scan';
  const seedLabel = (): string => initial?.label ?? defaults?.label ?? 'Scan';
  const seedParams = (): ScanParameters => {
    if (initial) return initial.params;
    return {
      ...DEFAULT_SCAN_PARAMETERS,
      ...defaults?.params,
      origin: { ...DEFAULT_SCAN_PARAMETERS.origin, ...defaults?.params?.origin },
    };
  };

  const [label, setLabel] = useState<string>(seedLabel);
  const [params, setParams] = useState<ScanParameters>(seedParams);
  const [importError, setImportError] = useState<string | null>(null);
  const [submitError, setSubmitError] = useState<string | null>(null);
  // The elevation-angles field is edited as free text (comma/space separated)
  // so partial input like a trailing comma isn't clobbered by the parsed array.
  // The parsed number[] lives in params.beamElevationAnglesDeg.
  const [elevationText, setElevationText] = useState<string>(
    () => seedParams().beamElevationAnglesDeg.join(', '),
  );
  // The zenith/azimuth ray counts can be entered two equivalent ways: as a raw
  // point count (per revolution, for azimuth), or as an angular step resolution
  // (degrees between consecutive rays). Manufacturer datasheets quote the
  // latter, so this lets a user transcribe a spec directly. The stored values
  // are always `zenithPoints` / `azimuthPoints`; this is a display-only mode, so
  // toggling it just re-derives the shown numbers from the same underlying
  // points (an auto-convert). The mode flips both fields together so a datasheet
  // angular spec can be entered consistently for the whole grid.
  const [rayInputMode, setRayInputMode] =
    useState<'points' | 'resolution'>('points');

  // Reset form (and clear any stale import error) whenever the popup is
  // reopened so editing the same scan twice doesn't carry over stale state.
  useEffect(() => {
    if (isOpen) {
      const seeded = seedParams();
      setLabel(seedLabel());
      setParams(seeded);
      setElevationText(seeded.beamElevationAnglesDeg.join(', '));
      setImportError(null);
      setSubmitError(null);
      setRayInputMode('points');
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isOpen, initial, defaults]);

  if (!isOpen) return null;

  const handleImportXml = async () => {
    setImportError(null);
    const picked = await window.electronAPI.dialog.open({
      title: 'Import Helios scan XML',
      filters: [{ name: 'Helios scan XML', extensions: ['xml'] }],
    });
    if (!picked) return;
    const path = Array.isArray(picked) ? picked[0] : picked;

    // Parse first so XML errors stay surfaced inside the popup.
    let parsed;
    try {
      const text = await window.electronAPI.fs.readText(path);
      parsed = parseHeliosScanXml(text);
    } catch (err) {
      const msg = err instanceof HeliosXmlParseError
        ? err.message
        : err instanceof Error
          ? err.message
          : String(err);
      setImportError(msg);
      return;
    }

    // Close the popup before kicking off the (potentially many-second) bulk
    // import. Two reasons:
    //   1. Enter pressed in the OS file dialog can leak through to the
    //      renderer once the dialog closes; if the popup's form is still
    //      mounted, that stray Enter submits it and creates a phantom
    //      default scan in addition to the imported ones.
    //   2. Without closing, the popup just sits there for ~10s while the
    //      backend parses the scan — the user has no idea anything is
    //      happening. Parent shows a progress modal instead.
    // Fire-and-forget the import; the parent owns errors/progress now.
    onClose();
    void onBulkImport?.(parsed.scans, parsed.grids, path, parsed.warnings);
  };

  // Import a moving-platform trajectory file (t,x,y,z + quaternion or Euler rows).
  // Stores the parsed PoseStream on params.trajectory and anchors origin to the
  // first pose (origin is only a fallback anchor for a moving scan). Errors are
  // surfaced inside the popup, like XML import.
  const handleImportTrajectory = async () => {
    setImportError(null);
    try {
      // Binary SBET is parsed server-side (it needs pyproj for the UTM projection);
      // text trajectories are parsed in the renderer. Both yield the same PoseStream.
      const stream = await pickAndParseTrajectory();
      if (!stream) return; // user cancelled the file picker
      // applyTrajectoryToParams anchors origin to the first pose and zeros the
      // static tilt/heading (a moving scan's attitude comes from the trajectory;
      // the backend's addScanMoving REJECTS a non-zero static tilt).
      setParams(p => applyTrajectoryToParams(p, stream));
    } catch (err) {
      const msg = err instanceof PoseStreamParseError || err instanceof Error
        ? err.message
        : String(err);
      setImportError(msg);
    }
  };

  const clearTrajectory = () => {
    setParams(p => ({ ...p, trajectory: undefined }));
  };

  // The azimuth sweep (degrees) the point count is spread over: a full 360° for
  // a spinning multibeam (it always completes a revolution), else the raster's
  // azimuth min↔max span. Used to convert between a points-per-rev count and an
  // angular step resolution (degrees/ray). Guard a degenerate zero/negative span
  // so conversion never divides by zero.
  const azimuthSpanDeg =
    params.pattern === 'spinning_multibeam'
      ? 360
      : Math.abs(params.azimuthMaxDeg - params.azimuthMinDeg) || 360;
  // Angular resolution (deg/ray) implied by the current point count, for display
  // in 'resolution' mode. span / points; finer when points is larger.
  const azimuthResolutionDeg =
    params.azimuthPoints > 0 ? azimuthSpanDeg / params.azimuthPoints : 0;
  // Commit a typed angular resolution by converting back to a point count
  // (points = span / resolution, ≥ 1). DebouncedNumberInput only hands us finite
  // values, and a non-positive resolution is meaningless, so floor those to the
  // minimum single ray.
  const setAzimuthResolution = (deg: number) => {
    setParams(p => {
      const span =
        p.pattern === 'spinning_multibeam'
          ? 360
          : Math.abs(p.azimuthMaxDeg - p.azimuthMinDeg) || 360;
      const points = deg > 0 ? Math.max(1, Math.round(span / deg)) : 1;
      return { ...p, azimuthPoints: points };
    });
  };

  // The zenith counterpart: the point count is spread over the raster's
  // zenith min↔max span. (A spinning multibeam hides the zenith field — its
  // zenith coverage comes from the per-channel elevation angles, not a count —
  // so this only ever applies to a raster grid.) Guard a degenerate span with
  // the conventional full 180° sweep so the conversion never divides by zero.
  const zenithSpanDeg =
    Math.abs(params.zenithMaxDeg - params.zenithMinDeg) || 180;
  const zenithResolutionDeg =
    params.zenithPoints > 0 ? zenithSpanDeg / params.zenithPoints : 0;
  const setZenithResolution = (deg: number) => {
    setParams(p => {
      const span = Math.abs(p.zenithMaxDeg - p.zenithMinDeg) || 180;
      const points = deg > 0 ? Math.max(1, Math.round(span / deg)) : 1;
      return { ...p, zenithPoints: points };
    });
  };

  // Angular sweep min/max commit on blur/Enter (via DebouncedNumberInput), so a
  // user can type a full number like "130" without it being clamped against the
  // other field mid-keystroke. We only clamp to the physical [lo, hi] range here;
  // the min↔max ordering isn't enforced (the backend handles any sweep ordering),
  // which is what lets you set min=30 then type max=130 freely.
  const setAngle = (
    key: 'zenithMinDeg' | 'zenithMaxDeg' | 'azimuthMinDeg' | 'azimuthMaxDeg',
  ) => (v: number) => {
    setParams(p => ({ ...p, [key]: v }));
  };

  // Origin x/y/z are signed coordinates (a scanner can sit at negative
  // positions), so they go through DebouncedNumberInput with no min. That
  // component owns a focus-guarded text draft, which is what lets a user clear
  // the field or type a lone "-" before the rest of a negative number — a plain
  // controlled type="number" bound to the parsed value snaps "" / "-" back to 0
  // and eats the keystroke.
  const setOrigin = (axis: 'x' | 'y' | 'z') => (v: number) => {
    setParams(p => ({ ...p, origin: { ...p.origin, [axis]: v } }));
  };

  // Tilt roll/pitch and the heading offset are signed angles (a scanner can lean
  // or face either way); same text-draft reasoning as setOrigin above.
  const setTilt = (key: 'tiltRollDeg' | 'tiltPitchDeg' | 'azimuthOffsetDeg') => (v: number) => {
    setParams(p => ({ ...p, [key]: v }));
  };

  // Parse the free-text elevation field into params.beamElevationAnglesDeg on
  // every keystroke; the raw text is kept for display so partial entries survive.
  const setElevations = (e: React.ChangeEvent<HTMLInputElement>) => {
    const text = e.target.value;
    setElevationText(text);
    const list = text.split(/[\s,]+/).filter(Boolean).map(Number).filter(Number.isFinite);
    setParams(p => ({ ...p, beamElevationAnglesDeg: list }));
    if (submitError) setSubmitError(null);
  };

  const setPattern = (pattern: ScanPattern) => {
    setParams(p => ({ ...p, pattern }));
    if (submitError) setSubmitError(null);
  };

  // Selecting a scanner model records the choice (drives the marker mesh) and
  // overwrites the instrument-fixed parameters with that model's preset. The
  // preset touches optics/pattern/return/elevations/sweep — and, for a spinning
  // sensor whose datasheet pins a per-revolution step width, azimuthPoints too.
  // Origin, tilt, heading, and the zenith point count are user choices and stay
  // as-is. Everything remains editable afterward. 'generic' carries an empty
  // preset, so picking it just sets the mesh back to the sphere without
  // disturbing current values.
  const setModel = (id: ScannerModelId) => {
    const preset = getScannerModel(id).preset;
    setParams(p => {
      const next: ScanParameters = { ...p, ...preset, scannerModel: id };
      // Keep the free-text elevation field in sync when the preset (de)fines
      // channel elevations (e.g. switching to the Velodyne fills 32 channels).
      if (preset.beamElevationAnglesDeg) {
        setElevationText(preset.beamElevationAnglesDeg.join(', '));
      }
      return next;
    });
    if (submitError) setSubmitError(null);
  };

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (params.pattern === 'spinning_multibeam' && params.beamElevationAnglesDeg.length < 1) {
      setSubmitError('Enter at least one beam elevation angle for a spinning-multibeam scan.');
      return;
    }
    // A spinning multibeam rotates continuously — it's a moving-platform pattern.
    // Require a trajectory (a stationary capture is two coincident poses one
    // revolution apart). The submit button is also disabled in this state.
    if (params.pattern === 'spinning_multibeam' && !params.trajectory) {
      setSubmitError('A spinning-multibeam scan needs a trajectory — import one above. '
        + 'For a stationary capture, use a trajectory with two poses at the same '
        + 'position one revolution apart.');
      return;
    }
    onSubmit(label, params);
  };

  // A spinning-multibeam scan is only valid with a trajectory (a rotating sensor
  // is moving-only). Used to gate submit + show an inline prompt.
  const multibeamNeedsTrajectory =
    params.pattern === 'spinning_multibeam' && !params.trajectory;

  // Show the raster zenith grid + sweep fields for a raster scan OR any moving
  // scan: a moving-platform scan walks the trajectory over an Ntheta×Nphi raster
  // grid regardless of the instrument's static pattern, so it always needs the
  // zenith point count + sweep (which the multibeam form otherwise hides).
  const showRaster = params.pattern === 'raster' || params.trajectory != null;

  // For a moving scan, derive what the backend will actually fire: the user sets
  // azimuth points PER REVOLUTION; with the PRF (a fixed laser spec) and the
  // trajectory duration we derive the rotation rate, revolutions, and total pulse
  // count for the WHOLE flight. Ntheta is the channel count for a multibeam
  // sensor, else the zenith point count. Shown read-only so the user sees the
  // cost (and that the sweep covers the flight) before running.
  const movingGrid = params.trajectory
    ? deriveMovingScanGrid(
        params.pattern === 'spinning_multibeam'
          ? Math.max(params.beamElevationAnglesDeg.length, 1)
          : params.zenithPoints,
        params.azimuthPoints,
        params.pulseRateHz ?? 300000,
        trajectoryDurationS(params.trajectory),
      )
    : null;
  const MOVING_PULSE_WARN = 20_000_000;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center">
      <div className="absolute inset-0 bg-black/60 backdrop-blur-sm" onClick={onClose} />

      <div
        data-testid="scan-parameters-popup"
        className="relative bg-neutral-800 rounded-xl shadow-2xl border border-neutral-700 w-full max-w-md mx-4 overflow-hidden max-h-[90vh] flex flex-col"
      >
        <div className="flex items-center justify-between px-4 py-3 border-b border-neutral-700 bg-neutral-800/90">
          <div className="flex items-center gap-2">
            <Radio className="w-5 h-5 text-neutral-400" />
            <h2 className="text-lg font-semibold text-white">
              {titleText}
            </h2>
          </div>
          <button
            onClick={onClose}
            className="p-1 rounded hover:bg-neutral-700 transition-colors"
            aria-label="Close"
          >
            <X className="w-5 h-5 text-neutral-400" />
          </button>
        </div>

        <form onSubmit={handleSubmit} className="p-4 space-y-4 overflow-y-auto">
          {showBulkImport && onBulkImport && (
            <div>
              <button
                type="button"
                data-testid="scan-import-xml"
                onClick={handleImportXml}
                className="w-full flex items-center justify-center gap-2 px-3 py-2 bg-neutral-700 hover:bg-neutral-600 border border-neutral-600 rounded-lg text-sm text-neutral-200 transition-colors"
              >
                <FileUp className="w-4 h-4" />
                Import from XML file…
              </button>
              {importError && (
                <p data-testid="scan-import-error" className="mt-2 text-xs text-red-400">
                  {importError}
                </p>
              )}
              <div className="flex items-center gap-2 mt-3">
                <div className="flex-1 h-px bg-neutral-700" />
                <span className="text-[10px] uppercase tracking-wider text-neutral-500">or fill manually</span>
                <div className="flex-1 h-px bg-neutral-700" />
              </div>
            </div>
          )}

          <div>
            <label className="block text-sm font-medium text-neutral-300 mb-1.5">Label</label>
            <input
              data-testid="scan-label-input"
              type="text"
              value={label}
              onChange={(e) => setLabel(e.target.value)}
              // Enter in a single-line text field would submit the form (close
              // the modal). Swallow it — the user commits via the submit button.
              onKeyDown={(e) => { if (e.key === 'Enter') e.preventDefault(); }}
              className="w-full px-3 py-2 bg-neutral-700 border border-neutral-600 rounded-lg text-white text-sm focus:outline-none focus:ring-2 focus:ring-blue-500/50 focus:border-blue-500"
            />
          </div>

          <div>
            <label className="block text-sm font-medium text-neutral-300 mb-1.5">Scanner model</label>
            <select
              data-testid="scan-model-select"
              value={params.scannerModel ?? 'generic'}
              onChange={(e) => setModel(e.target.value as ScannerModelId)}
              className="w-full px-3 py-2 bg-neutral-700 border border-neutral-600 rounded-lg text-white text-sm focus:outline-none focus:ring-2 focus:ring-blue-500/50 focus:border-blue-500"
            >
              {SCANNER_MODELS.map(m => (
                <option key={m.id} value={m.id}>{m.label}</option>
              ))}
            </select>
            <p className="mt-1 text-[11px] text-neutral-500">
              Picking a specific instrument fills its beam optics, scan pattern, return
              type, and angular sweep below (all still editable). “Generic / custom” leaves
              the values untouched and marks the position with a plain sphere.
            </p>
          </div>

          <div>
            <label className="block text-sm font-medium text-neutral-300 mb-1.5">Scan pattern</label>
            <div className="flex gap-2">
              {([
                ['raster', 'Raster'],
                ['spinning_multibeam', 'Spinning multibeam'],
              ] as [ScanPattern, string][]).map(([value, text]) => (
                <button
                  key={value}
                  type="button"
                  data-testid={`scan-pattern-${value === 'spinning_multibeam' ? 'multibeam' : value}`}
                  onClick={() => setPattern(value)}
                  className={`flex-1 px-3 py-2 rounded-lg text-sm transition-colors ${
                    params.pattern === value
                      ? 'bg-blue-600 text-white'
                      : 'bg-neutral-700 text-neutral-300 hover:bg-neutral-600'
                  }`}
                >
                  {text}
                </button>
              ))}
            </div>
          </div>

          <div>
            <label className="block text-sm font-medium text-neutral-300 mb-1.5">Origin (m)</label>
            {params.trajectory ? (
              // A moving-platform scan has no single origin — each return's beam
              // origin comes from the trajectory. Show the first-pose anchor
              // read-only rather than editable fields, which would imply origin
              // matters (it doesn't, beyond anchoring the marker).
              <p data-testid="scan-origin-anchor" className="text-xs text-neutral-400">
                Set by the trajectory — anchored to the first pose
                {' '}({params.origin.x.toFixed(2)}, {params.origin.y.toFixed(2)},{' '}
                {params.origin.z.toFixed(2)}). Per-return beam origins come from the
                trajectory.
              </p>
            ) : (
              <div className="grid grid-cols-3 gap-2">
                {(['x', 'y', 'z'] as const).map(axis => (
                  <div key={axis}>
                    <label className="block text-xs text-neutral-500 mb-1 uppercase">{axis}</label>
                    <DebouncedNumberInput
                      data-testid={`scan-origin-${axis}`}
                      step="any"
                      debounceMs={0}
                      value={params.origin[axis]}
                      onCommit={setOrigin(axis)}
                      className="w-full px-3 py-2 bg-neutral-700 border border-neutral-600 rounded-lg text-white text-sm focus:outline-none focus:ring-2 focus:ring-blue-500/50 focus:border-blue-500"
                    />
                  </div>
                ))}
              </div>
            )}
          </div>

          <div>
            <label className="block text-sm font-medium text-neutral-300 mb-1.5">
              Platform trajectory
            </label>
            {params.trajectory ? (
              <div className="flex items-center justify-between gap-2 px-3 py-2 bg-neutral-700/60 border border-neutral-600 rounded-lg">
                <div className="min-w-0">
                  <p className="text-sm text-white truncate" data-testid="scan-trajectory-label">
                    {params.trajectory.label ?? 'trajectory'}
                  </p>
                  <p className="text-xs text-neutral-400">
                    {params.trajectory.poses.length} poses · t{' '}
                    {params.trajectory.poses[0].t.toFixed(2)}–
                    {params.trajectory.poses[params.trajectory.poses.length - 1].t.toFixed(2)} s
                  </p>
                </div>
                <button
                  type="button"
                  onClick={clearTrajectory}
                  data-testid="scan-trajectory-clear"
                  className="shrink-0 px-2 py-1 text-xs text-neutral-300 hover:text-white border border-neutral-600 rounded-md hover:bg-neutral-600"
                >
                  Clear
                </button>
              </div>
            ) : (
              <button
                type="button"
                onClick={handleImportTrajectory}
                data-testid="scan-trajectory-import"
                className="w-full flex items-center justify-center gap-2 px-3 py-2 text-sm text-neutral-300 hover:text-white border border-dashed border-neutral-600 rounded-lg hover:bg-neutral-700/60"
              >
                <FileUp size={14} /> Import trajectory file…
              </button>
            )}
            <p className="mt-1 text-xs text-neutral-500">
              Optional. A CSV/text file of <code>t x y z</code> + orientation
              (quaternion or roll/pitch/yaw) turns this into a moving-platform scan;
              leaf-area inversion then reconstructs a per-beam origin per return.
            </p>
          </div>

          {/* Pulse rate (PRF) — a fixed laser spec for a real instrument, set by
              the scanner model. The scan fires continuously at this rate for the
              whole flight; the rotation rate + total pulses below are DERIVED from
              it, the per-revolution resolution, and the trajectory duration. PRF
              stays editable so a generic/custom scanner can be configured. */}
          {params.trajectory && movingGrid && (
            <div>
              <label className="block text-sm font-medium text-neutral-300 mb-1.5">
                Pulse rate / PRF (Hz)
              </label>
              <DebouncedNumberInput
                data-testid="scan-pulse-rate"
                step="any"
                debounceMs={0}
                value={params.pulseRateHz ?? 300000}
                onCommit={(v) => setParams(p => ({ ...p, pulseRateHz: Math.max(1, v) }))}
                className="w-full px-3 py-2 bg-neutral-700 border border-neutral-600 rounded-lg text-white text-sm focus:outline-none focus:ring-2 focus:ring-blue-500/50 focus:border-blue-500"
              />
              <p className="mt-1 text-xs text-neutral-500">
                Laser pulses per second (an instrument property; set by the scanner
                model). Azimuth points below are <em>per revolution</em>.
              </p>
              {/* Derived, read-only: the sensor spins at PRF ÷ (channels × az/rev),
                  for the trajectory's duration, firing PRF × duration pulses. */}
              <div data-testid="scan-moving-derived"
                className="mt-2 rounded-md border border-neutral-700 bg-neutral-800/60 px-3 py-2 text-xs text-neutral-400 space-y-0.5">
                <div>Flight duration:{' '}
                  <span className="text-neutral-200">{movingGrid.durationS.toFixed(2)} s</span>
                </div>
                <div>Rotation rate:{' '}
                  <span className="text-neutral-200">{movingGrid.rotationRateHz.toFixed(1)} Hz</span>
                  {' '}({(movingGrid.rotationRateHz * 60).toFixed(0)} RPM),{' '}
                  {movingGrid.nRevolutions.toFixed(0)} revolutions
                </div>
                <div>Total pulses:{' '}
                  <span className="text-neutral-200" data-testid="scan-moving-total-pulses">
                    {movingGrid.totalPulses.toLocaleString()}
                  </span>
                </div>
                {movingGrid.totalPulses > MOVING_PULSE_WARN && (
                  <div data-testid="scan-moving-warn" className="text-amber-400">
                    ⚠ Very large scan ({(movingGrid.totalPulses / 1e6).toFixed(0)}M pulses) —
                    may be slow. Lower the azimuth points or use a shorter trajectory
                    for a quicker test.
                  </div>
                )}
              </div>
            </div>
          )}

          <div>
            <label className="block text-sm font-medium text-neutral-300 mb-1.5">Scan size (# points)</label>
            <div className={`grid gap-2 ${showRaster && !(params.trajectory && params.pattern === 'spinning_multibeam') ? 'grid-cols-2' : 'grid-cols-1'}`}>
              {/* For a moving MULTIBEAM scan the zenith rows are the laser
                  channels (set by the elevation-angles list, not editable here),
                  so hide the zenith point field and let the channel count drive it.
                  Raster (static or moving) keeps the editable zenith field. */}
              {showRaster && !(params.trajectory && params.pattern === 'spinning_multibeam') && (
                <div>
                  <label className="block text-xs text-neutral-500 mb-1">
                    {rayInputMode === 'resolution' ? 'Zenith (°/ray)' : 'Zenith'}
                  </label>
                  {rayInputMode === 'points' ? (
                    <DebouncedNumberInput
                      data-testid="scan-zenith-points"
                      min={1}
                      step={1}
                      debounceMs={0}
                      parse={(s) => parseInt(s, 10)}
                      value={params.zenithPoints}
                      onCommit={(v) => setParams(p => ({ ...p, zenithPoints: Math.max(1, Math.round(v)) }))}
                      className="w-full px-3 py-2 bg-neutral-700 border border-neutral-600 rounded-lg text-white text-sm focus:outline-none focus:ring-2 focus:ring-blue-500/50 focus:border-blue-500"
                    />
                  ) : (
                    <DebouncedNumberInput
                      data-testid="scan-zenith-resolution"
                      min={0}
                      step="any"
                      value={zenithResolutionDeg}
                      onCommit={setZenithResolution}
                      className="w-full px-3 py-2 bg-neutral-700 border border-neutral-600 rounded-lg text-white text-sm focus:outline-none focus:ring-2 focus:ring-blue-500/50 focus:border-blue-500"
                    />
                  )}
                  {rayInputMode === 'resolution' && (
                    <p className="text-[11px] text-neutral-500 mt-1">
                      ≈ {params.zenithPoints.toLocaleString()} rays over {zenithSpanDeg}°
                    </p>
                  )}
                </div>
              )}
              <div>
                <div className="flex items-center justify-between mb-1">
                  <label className="block text-xs text-neutral-500">
                    {rayInputMode === 'resolution'
                      ? 'Azimuth (°/ray)'
                      : params.trajectory ? 'Azimuth (per rev)' : showRaster ? 'Azimuth' : 'Azimuth (Nphi)'}
                  </label>
                  {/* Toggle the unit BOTH ray counts are entered in. The stored
                      values are always zenithPoints / azimuthPoints, so flipping
                      the mode auto-converts the displayed numbers for the whole
                      grid (count ⇄ deg/ray) — a datasheet quoting an angular step
                      can be transcribed directly for both axes. */}
                  <button
                    type="button"
                    data-testid="scan-azimuth-mode-toggle"
                    // Keep this unit toggle out of the Tab order so tabbing from
                    // the Zenith input lands on the Azimuth input (it sits before
                    // that input in the DOM), not on this button. It stays
                    // click-discoverable.
                    tabIndex={-1}
                    onClick={() =>
                      setRayInputMode(m => (m === 'points' ? 'resolution' : 'points'))
                    }
                    title={
                      rayInputMode === 'points'
                        ? 'Entering ray counts — switch to angular resolution (°/ray)'
                        : 'Entering angular resolution (°/ray) — switch to ray counts'
                    }
                    className="text-[11px] text-blue-400 hover:text-blue-300 focus:outline-none"
                  >
                    {rayInputMode === 'points' ? 'use °/ray' : 'use # points'}
                  </button>
                </div>
                {rayInputMode === 'points' ? (
                  <DebouncedNumberInput
                    data-testid="scan-azimuth-points"
                    min={1}
                    step={1}
                    debounceMs={0}
                    parse={(s) => parseInt(s, 10)}
                    value={params.azimuthPoints}
                    onCommit={(v) => setParams(p => ({ ...p, azimuthPoints: Math.max(1, Math.round(v)) }))}
                    className="w-full px-3 py-2 bg-neutral-700 border border-neutral-600 rounded-lg text-white text-sm focus:outline-none focus:ring-2 focus:ring-blue-500/50 focus:border-blue-500"
                  />
                ) : (
                  <DebouncedNumberInput
                    data-testid="scan-azimuth-resolution"
                    min={0}
                    step="any"
                    value={azimuthResolutionDeg}
                    onCommit={setAzimuthResolution}
                    className="w-full px-3 py-2 bg-neutral-700 border border-neutral-600 rounded-lg text-white text-sm focus:outline-none focus:ring-2 focus:ring-blue-500/50 focus:border-blue-500"
                  />
                )}
                {rayInputMode === 'resolution' && (
                  <p className="text-[11px] text-neutral-500 mt-1">
                    ≈ {params.azimuthPoints.toLocaleString()} rays over {azimuthSpanDeg}°
                  </p>
                )}
              </div>
            </div>
          </div>

          <div>
            <label className="block text-sm font-medium text-neutral-300 mb-1.5">Angular sweep (degrees)</label>
            <div className="space-y-2">
              {/* The zenith SWEEP applies only to a raster pattern. A spinning
                  multibeam's zenith coverage is fixed by its per-channel beam
                  elevation angles, so this field is meaningless there (the
                  backend derives the zenith range from the channels). */}
              {params.pattern === 'raster' && (
                <div>
                  <label className="block text-xs text-neutral-500 mb-1">Zenith (θ) min / max</label>
                  <div className="grid grid-cols-2 gap-2">
                    <DebouncedNumberInput
                      data-testid="scan-zenith-min"
                      min={0}
                      max={180}
                      step="any"
                      value={params.zenithMinDeg}
                      onCommit={setAngle('zenithMinDeg')}
                      className="w-full px-3 py-2 bg-neutral-700 border border-neutral-600 rounded-lg text-white text-sm focus:outline-none focus:ring-2 focus:ring-blue-500/50 focus:border-blue-500"
                    />
                    <DebouncedNumberInput
                      data-testid="scan-zenith-max"
                      min={0}
                      max={180}
                      step="any"
                      value={params.zenithMaxDeg}
                      onCommit={setAngle('zenithMaxDeg')}
                      className="w-full px-3 py-2 bg-neutral-700 border border-neutral-600 rounded-lg text-white text-sm focus:outline-none focus:ring-2 focus:ring-blue-500/50 focus:border-blue-500"
                    />
                  </div>
                </div>
              )}
              {/* A spinning-multibeam sensor rotates a full 360° per revolution,
                  so an azimuth sweep RANGE is meaningless for it (its azimuth
                  control is the per-revolution point count above). Only a raster
                  scan has a partial azimuth sweep. */}
              {params.pattern !== 'spinning_multibeam' && (
                <div>
                  <label className="block text-xs text-neutral-500 mb-1">Azimuth (φ) min / max</label>
                  <div className="grid grid-cols-2 gap-2">
                    <DebouncedNumberInput
                      data-testid="scan-azimuth-min"
                      min={0}
                      max={360}
                      step="any"
                      value={params.azimuthMinDeg}
                      onCommit={setAngle('azimuthMinDeg')}
                      className="w-full px-3 py-2 bg-neutral-700 border border-neutral-600 rounded-lg text-white text-sm focus:outline-none focus:ring-2 focus:ring-blue-500/50 focus:border-blue-500"
                    />
                    <DebouncedNumberInput
                      data-testid="scan-azimuth-max"
                      min={0}
                      max={360}
                      step="any"
                      value={params.azimuthMaxDeg}
                      onCommit={setAngle('azimuthMaxDeg')}
                      className="w-full px-3 py-2 bg-neutral-700 border border-neutral-600 rounded-lg text-white text-sm focus:outline-none focus:ring-2 focus:ring-blue-500/50 focus:border-blue-500"
                    />
                  </div>
                </div>
              )}
            </div>
          </div>

          {params.pattern === 'spinning_multibeam' && (
            <div>
              <label className="block text-sm font-medium text-neutral-300 mb-1.5">
                Beam elevation angles (deg above horizon)
              </label>
              <input
                data-testid="scan-beam-elevations"
                type="text"
                value={elevationText}
                onChange={setElevations}
                onKeyDown={(e) => { if (e.key === 'Enter') e.preventDefault(); }}
                placeholder="15, 10, 5, 0, -5, -10, -15, -20"
                className="w-full px-3 py-2 bg-neutral-700 border border-neutral-600 rounded-lg text-white text-sm focus:outline-none focus:ring-2 focus:ring-blue-500/50 focus:border-blue-500"
              />
              <p className="mt-1 text-[11px] text-neutral-500">
                One value per laser channel, e.g. <code>15, 10, 5, 0, -5</code>. Positive is above
                horizon. The channel count ({params.beamElevationAnglesDeg.length}) sets the scan's
                zenith resolution.
              </p>
            </div>
          )}

          {/* Scanner tilt + heading describe the orientation of a STATIC
              instrument. A moving scan's attitude comes entirely from the
              trajectory's per-pose quaternions (+ boresight), and the backend
              rejects a non-zero static tilt for a moving scan — so hide these
              fields when a trajectory is attached. */}
          {params.trajectory ? (
            <p data-testid="scan-attitude-note" className="text-xs text-neutral-500">
              Scanner tilt &amp; heading come from the trajectory (per-pose
              orientation), so they aren&apos;t set here for a moving scan.
            </p>
          ) : (
            <>
              <div>
                <label className="block text-sm font-medium text-neutral-300 mb-1.5">Scanner tilt (degrees)</label>
                <div className="grid grid-cols-2 gap-2">
                  <div>
                    <label className="block text-xs text-neutral-500 mb-1">Roll</label>
                    <DebouncedNumberInput
                      data-testid="scan-tilt-roll"
                      step="any"
                      debounceMs={0}
                      value={params.tiltRollDeg}
                      onCommit={setTilt('tiltRollDeg')}
                      className="w-full px-3 py-2 bg-neutral-700 border border-neutral-600 rounded-lg text-white text-sm focus:outline-none focus:ring-2 focus:ring-blue-500/50 focus:border-blue-500"
                    />
                  </div>
                  <div>
                    <label className="block text-xs text-neutral-500 mb-1">Pitch</label>
                    <DebouncedNumberInput
                      data-testid="scan-tilt-pitch"
                      step="any"
                      debounceMs={0}
                      value={params.tiltPitchDeg}
                      onCommit={setTilt('tiltPitchDeg')}
                      className="w-full px-3 py-2 bg-neutral-700 border border-neutral-600 rounded-lg text-white text-sm focus:outline-none focus:ring-2 focus:ring-blue-500/50 focus:border-blue-500"
                    />
                  </div>
                </div>
                <p className="mt-1 text-[11px] text-neutral-500">
                  Residual tilt of the scanner away from level. Roll is applied first (about the
                  scanner's lateral axis), then pitch (about its forward axis). 0 / 0 is perfectly level.
                </p>
              </div>

              <div>
                <label className="block text-sm font-medium text-neutral-300 mb-1.5">Scanner heading (degrees)</label>
                <DebouncedNumberInput
                  data-testid="scan-azimuth-offset"
                  step="any"
                  debounceMs={0}
                  value={params.azimuthOffsetDeg}
                  onCommit={setTilt('azimuthOffsetDeg')}
                  className="w-full px-3 py-2 bg-neutral-700 border border-neutral-600 rounded-lg text-white text-sm focus:outline-none focus:ring-2 focus:ring-blue-500/50 focus:border-blue-500"
                />
                <p className="mt-1 text-[11px] text-neutral-500">
                  Initial heading the scanner faces in the horizontal plane (azimuth offset).
                  Rotates the swept beam fan about the vertical axis; 0 points along +Y.
                  Counter-clockwise positive.
                </p>
              </div>
            </>
          )}

          <div>
            <label className="block text-sm font-medium text-neutral-300 mb-1.5">Return type</label>
            <div className="flex gap-2">
              {(['single', 'multi'] as PulseReturnMode[]).map(rm => (
                <button
                  key={rm}
                  type="button"
                  data-testid={`scan-return-${rm}`}
                  onClick={() => setParams(p => ({ ...p, returnMode: rm }))}
                  className={`flex-1 px-3 py-2 rounded-lg text-sm capitalize transition-colors ${
                    params.returnMode === rm
                      ? 'bg-blue-600 text-white'
                      : 'bg-neutral-700 text-neutral-300 hover:bg-neutral-600'
                  }`}
                >
                  {rm}-return
                </button>
              ))}
            </div>
            <p className="mt-1.5 text-[11px] text-neutral-500">
              {params.returnMode === 'single'
                ? 'One return per pulse, selected below. For an idealized exact scan, set rays per pulse to 1 when you run the scan.'
                : 'All returns per pulse up to the cap below (full-waveform; penetrates foliage).'}
            </p>
          </div>

          {params.returnMode === 'multi' && (
            <div>
              <label className="block text-xs text-neutral-500 mb-1">Max returns per pulse</label>
              <DebouncedNumberInput
                data-testid="scan-max-returns"
                min={1}
                step={1}
                debounceMs={0}
                parse={(s) => parseInt(s, 10)}
                value={params.maxReturns}
                onCommit={(v) => setParams(p => ({ ...p, maxReturns: Math.max(1, Math.round(v)) }))}
                className="w-full px-3 py-2 bg-neutral-700 border border-neutral-600 rounded-lg text-white text-sm focus:outline-none focus:ring-2 focus:ring-blue-500/50 focus:border-blue-500"
              />
            </div>
          )}

          {params.returnMode === 'single' && (
            <div>
              <label className="block text-xs text-neutral-500 mb-1">Return selection</label>
              <select
                data-testid="scan-return-selection"
                value={params.returnSelection}
                onChange={(e) => setParams(p => ({ ...p, returnSelection: e.target.value as SingleReturnSelection }))}
                className="w-full px-3 py-2 bg-neutral-700 border border-neutral-600 rounded-lg text-white text-sm focus:outline-none focus:ring-2 focus:ring-blue-500/50 focus:border-blue-500"
              >
                <option value="strongest">Strongest</option>
                <option value="first">First (nearest)</option>
                <option value="last">Last (farthest)</option>
              </select>
            </div>
          )}

          {/* Beam optics define the cone the sub-rays sample for both single- and
              multi-return scans. (At rays-per-pulse = 1 the cone collapses to an
              exact ray and these are effectively ignored.) */}
          <div data-testid="scan-beam-fields" className="border border-neutral-700 rounded-lg p-3 space-y-3 bg-neutral-800/50">
            <div>
              <label className="block text-xs text-neutral-500 mb-1">Beam exit diameter (m)</label>
              <DebouncedNumberInput
                data-testid="scan-beam-diameter"
                min={0}
                step="any"
                debounceMs={0}
                value={params.beamExitDiameterM}
                onCommit={(v) => setParams(p => ({ ...p, beamExitDiameterM: Math.max(0, v) }))}
                className="w-full px-3 py-2 bg-neutral-700 border border-neutral-600 rounded-lg text-white text-sm focus:outline-none focus:ring-2 focus:ring-blue-500/50 focus:border-blue-500"
              />
            </div>
            <div>
              <label className="block text-xs text-neutral-500 mb-1">Beam divergence (mrad)</label>
              <DebouncedNumberInput
                data-testid="scan-beam-divergence"
                min={0}
                step="any"
                debounceMs={0}
                value={params.beamDivergenceMrad}
                onCommit={(v) => setParams(p => ({ ...p, beamDivergenceMrad: Math.max(0, v) }))}
                className="w-full px-3 py-2 bg-neutral-700 border border-neutral-600 rounded-lg text-white text-sm focus:outline-none focus:ring-2 focus:ring-blue-500/50 focus:border-blue-500"
              />
            </div>
          </div>

          {multibeamNeedsTrajectory && (
            <p data-testid="scan-multibeam-needs-trajectory" className="text-xs text-amber-300">
              A spinning-multibeam sensor rotates continuously, so it needs a
              trajectory (it&apos;s a moving-platform scan). Import a trajectory
              file above. For a stationary capture, use a trajectory with two poses
              at the same position one revolution apart.
            </p>
          )}

          {submitError && (
            <p data-testid="scan-submit-error" className="text-xs text-red-400">
              {submitError}
            </p>
          )}

          <button
            data-testid="scan-submit"
            type="submit"
            disabled={multibeamNeedsTrajectory}
            className="w-full flex items-center justify-center gap-2 px-4 py-2.5 bg-blue-600 hover:bg-blue-500 disabled:bg-neutral-600 disabled:cursor-not-allowed rounded-lg text-white font-medium transition-colors"
          >
            <Radio className="w-4 h-4" />
            {submitText}
          </button>
        </form>
      </div>
    </div>
  );
}
