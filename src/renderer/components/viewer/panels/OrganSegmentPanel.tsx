import { Clover, Loader2, X } from 'lucide-react';
import { InfoHint } from '../../InfoHint';
import { MlModelControls } from './MlModelControls';
import { type OrganUnits } from '../../../utils/backendApi';
import { CloudTargetPicker, type CloudPicker } from './CloudTargetPicker';
import { STICKY_PANEL_HEADER } from './stickyPanelHeader';

// What the result is colored by once the columns are written. Both columns are
// always written; this only picks the color mode the cloud is left in.
export type OrganColorBy = 'organ' | 'leaflet';

// Presentational tool panel for ML plant-organ segmentation (soil / stem / leaf
// plus one id per leaflet). State and the `onSegment` handler live in
// PointCloudViewer; the parent gates on `showOrganSegmentPanel && selectedIds.size >= 1`.
// With several clouds selected, each is segmented on its own, in turn.
interface OrganSegmentPanelProps {
  /** Every point cloud in the scene, with the ones to segment checked. */
  picker: CloudPicker;
  /** How many clouds are checked; with none, only the picker is shown. */
  selectedCount: number;
  /** Which scan is running, while a multi-selection runs; null otherwise. */
  progress: { index: number; total: number } | null;
  units: OrganUnits;
  colorBy: OrganColorBy;
  modelId: string | null;
  inProgress: boolean;
  error: string | null;
  onClose: () => void;
  onUnitsChange: (u: OrganUnits) => void;
  onColorByChange: (c: OrganColorBy) => void;
  onModelIdChange: (id: string | null) => void;
  onSegment: () => void;
  onCancel: () => void;
}

export function OrganSegmentPanel({
  picker,
  selectedCount,
  progress,
  units,
  colorBy,
  modelId,
  inProgress,
  error,
  onClose,
  onUnitsChange,
  onColorByChange,
  onModelIdChange,
  onSegment,
  onCancel,
}: OrganSegmentPanelProps) {
  return (
    <div data-testid="organ-segment-panel" data-target-count={selectedCount} className="absolute top-4 right-[280px] z-20 bg-neutral-800/90 backdrop-blur-sm rounded-lg p-3 shadow-lg w-64 max-h-[calc(100%-2rem)] overflow-y-auto">
      <div className={`flex items-center justify-between ${STICKY_PANEL_HEADER}`}>
        <div className="text-xs font-medium text-neutral-300 flex items-center gap-2">
          <Clover className="w-3 h-3" />
          Plant Organs
        </div>
        <button onClick={onClose} aria-label="Close" title="Close" className="p-1 hover:bg-neutral-700 rounded">
          <X className="w-3 h-3 text-neutral-400" />
        </button>
      </div>
      <CloudTargetPicker
        picker={picker}
        targetCount={selectedCount}
        testIdPrefix="organ"
        noneHint="Check the clouds to segment."
        locked={inProgress}
      />
      {selectedCount > 0 && (<>

      <div className="mb-3 p-2 bg-neutral-900/50 rounded text-[10px] text-neutral-400">
        Labels a single herbaceous plant (potted or in a row) as soil, stem and
        leaf, and numbers each leaflet. Petioles count as stem. Leave the soil
        or pot in; it is one of the classes. Needs about 3 mm point spacing or
        finer.
      </div>

      {selectedCount > 1 && (
        <div data-testid="organ-multi-note" className="mb-3 text-[10px] text-neutral-400">
          {selectedCount} clouds checked. Each is segmented on its own, one
          after another, so each should hold one plant.
        </div>
      )}

      <div className="mb-3">
        <label className="text-[10px] text-neutral-400 mb-1 flex items-center gap-1">
          Units
          <InfoHint
            data-testid="organ-units-help"
            label="Units"
            text="What the cloud's coordinates are in. The model works in meters, and an XYZ file does not say which unit it was written in. Auto reads it from the cloud's size: anything more than 30 units across is taken as millimeters, anything smaller as meters. The result says which it used; if that is wrong, pick the units here and run again."
          />
        </label>
        <select
          data-testid="organ-units"
          value={units}
          onChange={(e) => onUnitsChange(e.target.value as OrganUnits)}
          disabled={inProgress}
          className="w-full bg-neutral-700 text-neutral-200 text-xs rounded px-2 py-1 border border-neutral-600"
        >
          <option value="auto">Auto (from the cloud's size)</option>
          <option value="m">Meters</option>
          <option value="cm">Centimeters</option>
          <option value="mm">Millimeters</option>
        </select>
      </div>

      <div className="mb-3">
        <label className="text-[10px] text-neutral-400 mb-1 flex items-center gap-1">
          Color result by
          <InfoHint
            data-testid="organ-color-help"
            label="Color result by"
            text="Both are written to the cloud as attributes (Plant organ and Leaflet), so you can switch between them later in the color menu. Leaflets are numbered by height, lowest first; soil and stem points are leaflet 0."
          />
        </label>
        <select
          data-testid="organ-color-by"
          value={colorBy}
          onChange={(e) => onColorByChange(e.target.value as OrganColorBy)}
          disabled={inProgress}
          className="w-full bg-neutral-700 text-neutral-200 text-xs rounded px-2 py-1 border border-neutral-600"
        >
          <option value="organ">Organ (soil / stem / leaf)</option>
          <option value="leaflet">Leaflet</option>
        </select>
      </div>

      <MlModelControls
        task="plant_organ"
        testIdPrefix="organ"
        noModelText="No plant-organ model is installed."
        modelId={modelId}
        onModelIdChange={onModelIdChange}
        disabled={inProgress}
      />

      {error && (
        <div className="mt-3 p-2 bg-red-900/30 border border-red-600/50 rounded text-[10px] text-red-300">
          {error}
        </div>
      )}

      <div className="mt-3">
        {inProgress ? (
          <div className="flex gap-2">
            <button
              data-testid="organ-segment-run-button"
              disabled
              className="flex-1 px-3 py-2 text-xs rounded font-medium flex items-center justify-center gap-2 bg-neutral-600 text-neutral-400 cursor-not-allowed"
            >
              <Loader2 className="w-3 h-3 animate-spin" />
              {progress ? `Segmenting ${progress.index} of ${progress.total}…` : 'Segmenting…'}
            </button>
            <button
              data-testid="organ-segment-cancel-button"
              onClick={onCancel}
              className="px-3 py-2 text-xs rounded font-medium flex items-center justify-center gap-1 bg-red-600 hover:bg-red-500 text-white"
            >
              <X className="w-3 h-3" />
              Cancel
            </button>
          </div>
        ) : (
          <button
            data-testid="organ-segment-run-button"
            onClick={onSegment}
            className="w-full px-3 py-2 text-xs rounded font-medium flex items-center justify-center gap-2 bg-green-600 hover:bg-green-500 text-white"
          >
            <Clover className="w-3 h-3" />
            {selectedCount > 1 ? `Segment ${selectedCount} Clouds` : 'Segment Organs'}
          </button>
        )}
      </div>
      </>)}
    </div>
  );
}
