import { useEffect, useState } from 'react';
import { X, Radio, FileUp } from 'lucide-react';
import { DebouncedNumberInput } from './DebouncedNumberInput';
import {
  DEFAULT_SCAN_PARAMETERS,
  type ReturnType,
  type ScanParameters,
} from '../lib/scanParameters';
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

  // Reset form (and clear any stale import error) whenever the popup is
  // reopened so editing the same scan twice doesn't carry over stale state.
  useEffect(() => {
    if (isOpen) {
      setLabel(seedLabel());
      setParams(seedParams());
      setImportError(null);
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

  const setOrigin = (axis: 'x' | 'y' | 'z') => (e: React.ChangeEvent<HTMLInputElement>) => {
    const v = parseFloat(e.target.value);
    setParams(p => ({ ...p, origin: { ...p.origin, [axis]: Number.isFinite(v) ? v : 0 } }));
  };

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
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
            <label className="block text-sm font-medium text-neutral-300 mb-1.5">Origin (m)</label>
            <div className="grid grid-cols-3 gap-2">
              {(['x', 'y', 'z'] as const).map(axis => (
                <div key={axis}>
                  <label className="block text-xs text-neutral-500 mb-1 uppercase">{axis}</label>
                  <input
                    data-testid={`scan-origin-${axis}`}
                    type="number"
                    step="any"
                    value={params.origin[axis]}
                    onChange={setOrigin(axis)}
                    className="w-full px-3 py-2 bg-neutral-700 border border-neutral-600 rounded-lg text-white text-sm focus:outline-none focus:ring-2 focus:ring-blue-500/50 focus:border-blue-500"
                  />
                </div>
              ))}
            </div>
          </div>

          <div>
            <label className="block text-sm font-medium text-neutral-300 mb-1.5">Scan size (# points)</label>
            <div className="grid grid-cols-2 gap-2">
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
              <div>
                <label className="block text-xs text-neutral-500 mb-1">Azimuth</label>
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
