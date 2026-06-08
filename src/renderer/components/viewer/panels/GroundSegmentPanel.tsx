import { Layers, Loader2, X } from 'lucide-react';
import { DebouncedNumberInput } from '../../DebouncedNumberInput';

// Presentational tool panel for ground (cloth-simulation) segmentation. The
// `onSegment` handler and all state live in PointCloudViewer; the parent gates
// rendering on `showGroundSegmentPanel && selectedIds.size === 1`.
interface GroundSegmentPanelProps {
  clothResolution: number;
  classThreshold: number;
  rigidness: number;
  splitClouds: boolean;
  inProgress: boolean;
  error: string | null;
  onClose: () => void;
  onClothResolutionChange: (n: number) => void;
  onClassThresholdChange: (n: number) => void;
  onRigidnessChange: (n: number) => void;
  onSplitCloudsChange: (v: boolean) => void;
  onSegment: () => void;
}

export function GroundSegmentPanel({
  clothResolution,
  classThreshold,
  rigidness,
  splitClouds,
  inProgress,
  error,
  onClose,
  onClothResolutionChange,
  onClassThresholdChange,
  onRigidnessChange,
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
        tolerance keeps low plant material; higher merges it into ground.
      </div>

      {/* Cloth resolution */}
      <div className="mb-3">
        <label className="text-[10px] text-neutral-400 block mb-1">Cloth resolution (m)</label>
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
        <label className="text-[10px] text-neutral-400 block mb-1">Ground tolerance (m)</label>
        <DebouncedNumberInput
          data-testid="ground-class-threshold"
          value={classThreshold}
          onCommit={(n) => onClassThresholdChange(n)}
          min={0.001}
          max={1}
          step={0.01}
          disabled={inProgress}
          className="w-full bg-neutral-700 text-neutral-200 text-xs rounded px-2 py-1 border border-neutral-600"
        />
      </div>

      {/* Rigidness */}
      <div className="mb-3">
        <label className="text-[10px] text-neutral-400 block mb-1">Rigidness (1–3)</label>
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

      {/* Split checkbox */}
      <label className="flex items-center gap-2 text-[10px] text-neutral-400 mb-3">
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
