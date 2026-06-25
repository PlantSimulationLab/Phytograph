import { Layers, Loader2, X } from 'lucide-react';
import { DebouncedNumberInput } from '../../DebouncedNumberInput';
import { InfoHint } from '../../InfoHint';

// Presentational tool panel for ground (cloth-simulation) segmentation. The
// `onSegment` handler and all state live in PointCloudViewer; the parent gates
// rendering on `showGroundSegmentPanel && selectedIds.size === 1`.
interface GroundSegmentPanelProps {
  clothResolution: number;
  classThreshold: number;
  rigidness: number;
  slopeSmooth: boolean;
  splitClouds: boolean;
  inProgress: boolean;
  error: string | null;
  onClose: () => void;
  onClothResolutionChange: (n: number) => void;
  onClassThresholdChange: (n: number) => void;
  onRigidnessChange: (n: number) => void;
  onSlopeSmoothChange: (v: boolean) => void;
  onSplitCloudsChange: (v: boolean) => void;
  onSegment: () => void;
}

export function GroundSegmentPanel({
  clothResolution,
  classThreshold,
  rigidness,
  slopeSmooth,
  splitClouds,
  inProgress,
  error,
  onClose,
  onClothResolutionChange,
  onClassThresholdChange,
  onRigidnessChange,
  onSlopeSmoothChange,
  onSplitCloudsChange,
  onSegment,
}: GroundSegmentPanelProps) {
  return (
    <div data-testid="ground-segment-panel" className="absolute top-4 right-[280px] bg-neutral-800/90 backdrop-blur-sm rounded-lg p-3 shadow-lg w-64">
      <div className="flex items-center justify-between mb-3">
        <div className="text-xs font-medium text-neutral-300 flex items-center gap-2">
          <Layers className="w-3 h-3" />
          Ground Segmentation
        </div>
        <button
          onClick={onClose}
          className="p-1 hover:bg-neutral-700 rounded"
        >
          <X className="w-3 h-3 text-neutral-400" />
        </button>
      </div>

      <div className="mb-3 p-2 bg-neutral-900/50 rounded text-[10px] text-neutral-400">
        Cloth Simulation Filter separates ground from plant points. Lower
        tolerance keeps low plant material separate; raise it to merge weeds
        and ground cover into the ground class. Tolerance is a height above the
        draped cloth, so larger / field-scale scans need larger values.
      </div>

      {/* Cloth resolution */}
      <div className="mb-3">
        <label className="text-[10px] text-neutral-400 mb-1 flex items-center gap-1">
          Cloth resolution (m)
          <InfoHint
            data-testid="ground-cloth-resolution-help"
            label="Cloth resolution"
            text="Grid spacing of the simulated cloth, in metres. Smaller follows finer ground relief but runs slower; larger is coarser and faster. Seeded from the cloud's size — a few centimetres for close-range scans, larger for field-scale tiles."
          />
        </label>
        <DebouncedNumberInput
          data-testid="ground-cloth-resolution"
          value={clothResolution}
          onCommit={(n) => onClothResolutionChange(n)}
          min={0.005}
          max={2}
          step={0.01}
          disabled={inProgress}
          className="w-full bg-neutral-700 text-neutral-200 text-xs rounded px-2 py-1 border border-neutral-600"
        />
      </div>

      {/* Ground tolerance (class threshold) */}
      <div className="mb-3">
        <label className="text-[10px] text-neutral-400 mb-1 flex items-center gap-1">
          Ground tolerance (m)
          <InfoHint
            data-testid="ground-class-threshold-help"
            label="Ground tolerance"
            text="Maximum height a point can sit above the draped cloth and still count as ground. Raise it to merge weeds and low ground cover into the ground class; lower it to keep the plant base separate. It's an absolute height, so field-scale scans need larger values (e.g. ~2 m on a 50 m orchard tile)."
          />
        </label>
        <DebouncedNumberInput
          data-testid="ground-class-threshold"
          value={classThreshold}
          onCommit={(n) => onClassThresholdChange(n)}
          min={0.001}
          max={5}
          step={0.01}
          disabled={inProgress}
          className="w-full bg-neutral-700 text-neutral-200 text-xs rounded px-2 py-1 border border-neutral-600"
        />
      </div>

      {/* Rigidness */}
      <div className="mb-3">
        <label className="text-[10px] text-neutral-400 mb-1 flex items-center gap-1">
          Rigidness (1–3)
          <InfoHint
            data-testid="ground-rigidness-help"
            label="Rigidness"
            text="Stiffness of the cloth (1–3). Use 3 for flat ground; lower it for undulating terrain so the cloth can bend to follow slopes instead of bridging over them."
          />
        </label>
        <DebouncedNumberInput
          data-testid="ground-rigidness"
          value={rigidness}
          onCommit={(n) => onRigidnessChange(Math.max(1, Math.min(3, Math.round(n))))}
          min={1}
          max={3}
          step={1}
          disabled={inProgress}
          className="w-full bg-neutral-700 text-neutral-200 text-xs rounded px-2 py-1 border border-neutral-600"
        />
      </div>

      {/* Slope smoothing */}
      <div className="flex items-center gap-1 mb-3">
        <label className="flex items-center gap-2 text-[10px] text-neutral-400">
          <input
            data-testid="ground-slope-smooth"
            type="checkbox"
            checked={slopeSmooth}
            onChange={(e) => onSlopeSmoothChange(e.target.checked)}
            className="rounded bg-neutral-700 border-neutral-600 accent-neutral-500"
            disabled={inProgress}
          />
          Slope smoothing
        </label>
        <InfoHint
          data-testid="ground-slope-smooth-help"
          label="Slope smoothing"
          align="right"
          text="Enable the cloth's slope-handling pass for undulating or steep terrain. Together with a low rigidness it lets the cloth conform to a slope instead of draping flat and bridging over it. Auto-enabled when the cloud's vertical relief is large relative to its footprint; leave off for flat ground."
        />
      </div>

      {/* Split checkbox */}
      <div className="flex items-center gap-1 mb-3">
        <label className="flex items-center gap-2 text-[10px] text-neutral-400">
          <input
            data-testid="ground-split-clouds"
            type="checkbox"
            checked={splitClouds}
            onChange={(e) => onSplitCloudsChange(e.target.checked)}
            className="rounded bg-neutral-700 border-neutral-600 accent-neutral-500"
            disabled={inProgress}
          />
          Split into ground + plant clouds
        </label>
        <InfoHint
          data-testid="ground-split-clouds-help"
          label="Split into ground + plant clouds"
          align="right"
          text="Also output two new clouds — ground and non-ground — alongside the classified original, so you can hide, export, or process them separately. The original is always kept and recoloured by class."
        />
      </div>

      {error && (
        <div className="mb-3 p-2 bg-red-900/30 border border-red-600/50 rounded text-[10px] text-red-300">
          {error}
        </div>
      )}

      <button
        data-testid="ground-segment-run-button"
        onClick={onSegment}
        disabled={inProgress}
        className={`w-full px-3 py-2 text-xs rounded font-medium flex items-center justify-center gap-2 ${
          inProgress
            ? 'bg-neutral-600 text-neutral-400 cursor-not-allowed'
            : 'bg-green-600 hover:bg-green-500 text-white'
        }`}
      >
        {inProgress ? (
          <>
            <Loader2 className="w-3 h-3 animate-spin" />
            Segmenting...
          </>
        ) : (
          <>
            <Layers className="w-3 h-3" />
            Segment Ground
          </>
        )}
      </button>
    </div>
  );
}
