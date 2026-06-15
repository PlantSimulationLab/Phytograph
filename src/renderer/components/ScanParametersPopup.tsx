import { useEffect, useState } from 'react';
import { X, Radio, FileUp } from 'lucide-react';
import { DebouncedNumberInput } from './DebouncedNumberInput';
import {
  DEFAULT_SCAN_PARAMETERS,
  type ReturnType,
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
  onBulkImport?: (scans: HeliosXmlScan[], grids: HeliosXmlGrid[], xmlPath: string) => void | Promise<void>;
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
    void onBulkImport?.(parsed.scans, parsed.grids, path);
  };

  const setNum = (key: keyof Omit<ScanParameters, 'origin' | 'returnType'>, min = 0) => (e: React.ChangeEvent<HTMLInputElement>) => {
    const v = parseFloat(e.target.value);
    setParams(p => ({ ...p, [key]: Number.isFinite(v) ? Math.max(min, v) : min }));
  };

  const setInt = (key: 'zenithPoints' | 'azimuthPoints', min = 1) => (e: React.ChangeEvent<HTMLInputElement>) => {
    const v = parseInt(e.target.value, 10);
    setParams(p => ({ ...p, [key]: Number.isFinite(v) ? Math.max(min, v) : min }));
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
  // preset only touches optics/pattern/return/elevations/sweep — origin, tilt,
  // heading, and resolution (point counts) are user choices and stay as-is. Everything
  // remains editable afterward. 'generic' carries an empty preset, so picking it
  // just sets the mesh back to the sphere without disturbing current values.
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
    onSubmit(label, params);
  };

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
          </div>

          <div>
            <label className="block text-sm font-medium text-neutral-300 mb-1.5">Scan size (# points)</label>
            <div className={`grid gap-2 ${params.pattern === 'raster' ? 'grid-cols-2' : 'grid-cols-1'}`}>
              {params.pattern === 'raster' && (
                <div>
                  <label className="block text-xs text-neutral-500 mb-1">Zenith</label>
                  <input
                    data-testid="scan-zenith-points"
                    type="number"
                    min={1}
                    step={1}
                    value={params.zenithPoints}
                    onChange={setInt('zenithPoints')}
                    className="w-full px-3 py-2 bg-neutral-700 border border-neutral-600 rounded-lg text-white text-sm focus:outline-none focus:ring-2 focus:ring-blue-500/50 focus:border-blue-500"
                  />
                </div>
              )}
              <div>
                <label className="block text-xs text-neutral-500 mb-1">
                  {params.pattern === 'raster' ? 'Azimuth' : 'Azimuth (Nphi)'}
                </label>
                <input
                  data-testid="scan-azimuth-points"
                  type="number"
                  min={1}
                  step={1}
                  value={params.azimuthPoints}
                  onChange={setInt('azimuthPoints')}
                  className="w-full px-3 py-2 bg-neutral-700 border border-neutral-600 rounded-lg text-white text-sm focus:outline-none focus:ring-2 focus:ring-blue-500/50 focus:border-blue-500"
                />
              </div>
            </div>
          </div>

          <div>
            <label className="block text-sm font-medium text-neutral-300 mb-1.5">Angular sweep (degrees)</label>
            <div className="space-y-2">
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
              Orients the scanner marker; 0 points along +Y. Counter-clockwise positive.
            </p>
          </div>

          <div>
            <label className="block text-sm font-medium text-neutral-300 mb-1.5">Return type</label>
            <div className="flex gap-2">
              {(['single', 'multi'] as ReturnType[]).map(rt => (
                <button
                  key={rt}
                  type="button"
                  data-testid={`scan-return-${rt}`}
                  onClick={() => setParams(p => ({ ...p, returnType: rt }))}
                  className={`flex-1 px-3 py-2 rounded-lg text-sm capitalize transition-colors ${
                    params.returnType === rt
                      ? 'bg-blue-600 text-white'
                      : 'bg-neutral-700 text-neutral-300 hover:bg-neutral-600'
                  }`}
                >
                  {rt}-return
                </button>
              ))}
            </div>
          </div>

          {params.returnType === 'multi' && (
            <div data-testid="scan-beam-fields" className="border border-neutral-700 rounded-lg p-3 space-y-3 bg-neutral-800/50">
              <div>
                <label className="block text-xs text-neutral-500 mb-1">Beam exit diameter (m)</label>
                <input
                  data-testid="scan-beam-diameter"
                  type="number"
                  min={0}
                  step="any"
                  value={params.beamExitDiameterM}
                  onChange={setNum('beamExitDiameterM')}
                  className="w-full px-3 py-2 bg-neutral-700 border border-neutral-600 rounded-lg text-white text-sm focus:outline-none focus:ring-2 focus:ring-blue-500/50 focus:border-blue-500"
                />
              </div>
              <div>
                <label className="block text-xs text-neutral-500 mb-1">Beam divergence (mrad)</label>
                <input
                  data-testid="scan-beam-divergence"
                  type="number"
                  min={0}
                  step="any"
                  value={params.beamDivergenceMrad}
                  onChange={setNum('beamDivergenceMrad')}
                  className="w-full px-3 py-2 bg-neutral-700 border border-neutral-600 rounded-lg text-white text-sm focus:outline-none focus:ring-2 focus:ring-blue-500/50 focus:border-blue-500"
                />
              </div>
            </div>
          )}

          {submitError && (
            <p data-testid="scan-submit-error" className="text-xs text-red-400">
              {submitError}
            </p>
          )}

          <button
            data-testid="scan-submit"
            type="submit"
            className="w-full flex items-center justify-center gap-2 px-4 py-2.5 bg-blue-600 hover:bg-blue-500 rounded-lg text-white font-medium transition-colors"
          >
            <Radio className="w-4 h-4" />
            {submitText}
          </button>
        </form>
      </div>
    </div>
  );
}
