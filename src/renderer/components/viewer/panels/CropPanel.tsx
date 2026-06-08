import { Crop, X } from 'lucide-react';
import { DebouncedNumberInput } from '../../DebouncedNumberInput';

type CropMode = 'box' | 'rect' | 'polygon';
// Crop interaction state machine (subset relevant to the panel).
type CropDrawState =
  | 'idle'
  | 'awaiting-box-corner-1'
  | 'awaiting-box-corner-2'
  | 'drawing-polygon'
  | 'drawing-rect'
  | string;

interface CropBox {
  min: { x: number; y: number; z: number };
  max: { x: number; y: number; z: number };
}

// Presentational crop panel handling all three shapes (Box AABB, screen-space
// Rect, freeform Polygon) and the Keep-Inside / Keep-Outside / Segment modes.
// The crop predicate, world-box reset, draw-state machine, and apply logic live
// in PointCloudViewer; this component renders the controls and forwards intent.
// The data-* attributes (asserted by crop regression tests) are computed by the
// parent and passed through. Parent gates on `editMode === 'crop' && selectedIds.size > 0`.
interface CropPanelProps {
  selectionCount: number;
  cropMode: CropMode;
  cropDrawState: CropDrawState;
  cropBox: CropBox | null;
  // Truthy when a screen-space region (rect/polygon) has been committed.
  hasCropPolygon: boolean;
  polygonVertexCount: number;
  cropPolygonPointCount: number;
  cropInvert: boolean;
  cropSegment: boolean;
  applyDisabled: boolean;
  // data-* diagnostics for regression tests.
  cropBoxMinStr: string;
  cropBoxMaxStr: string;
  cropProjectionKind: 'orthographic' | 'perspective' | '';
  onClose: () => void;
  onSelectShape: (mode: CropMode) => void;
  onKeepInside: () => void;
  onKeepOutside: () => void;
  onSegment: () => void;
  onSetBoxSize: (axis: 'x' | 'y' | 'z', newSize: number) => void;
  onSetBoxCenter: (axis: 'x' | 'y' | 'z', newCenter: number) => void;
  onDrawBox: () => void;
  onResetBox: () => void;
  onRedrawPolygon: () => void;
  onStartPolygon: () => void;
  onRedrawRect: () => void;
  onStartRect: () => void;
  onApply: () => void;
}

const AXES = ['x', 'y', 'z'] as const;

export function CropPanel({
  selectionCount,
  cropMode,
  cropDrawState,
  cropBox,
  hasCropPolygon,
  polygonVertexCount,
  cropPolygonPointCount,
  cropInvert,
  cropSegment,
  applyDisabled,
  cropBoxMinStr,
  cropBoxMaxStr,
  cropProjectionKind,
  onClose,
  onSelectShape,
  onKeepInside,
  onKeepOutside,
  onSegment,
  onSetBoxSize,
  onSetBoxCenter,
  onDrawBox,
  onResetBox,
  onRedrawPolygon,
  onStartPolygon,
  onRedrawRect,
  onStartRect,
  onApply,
}: CropPanelProps) {
  return (
    <div
      data-testid="crop-panel"
      data-selection-count={selectionCount}
      data-crop-mode={cropMode}
      data-crop-min={cropBoxMinStr}
      data-crop-max={cropBoxMaxStr}
      data-crop-projection-kind={cropProjectionKind}
      // z-20 keeps the panel above the polygon lasso overlay (z-10), which fills
      // the whole viewport while drawing — without this the transparent SVG would
      // swallow clicks on the panel's controls.
      className="absolute top-4 right-[280px] bg-neutral-800/90 backdrop-blur-sm rounded-lg p-3 shadow-lg w-56 z-20"
    >
      <div className="text-xs font-medium text-neutral-300 mb-3 flex items-center justify-between">
        <span className="flex items-center gap-2">
          <Crop className="w-3 h-3" />
          Crop Region
        </span>
        <button
          data-testid="crop-close"
          onClick={onClose}
          className="p-1 rounded hover:bg-neutral-700 transition-colors"
          aria-label="Close"
          title="Close (don't apply crop)"
        >
          <X className="w-4 h-4 text-neutral-400" />
        </button>
      </div>

      {selectionCount > 1 && (
        <div data-testid="crop-multi-hint" className="text-[10px] text-blue-300 text-center mb-2 py-1 bg-blue-900/20 rounded">
          Applies to {selectionCount} scans
        </div>
      )}

      {/* Shape: Box (world AABB) vs Rect (screen-space rectangle, any view) vs
          Polygon (freeform lasso, any view). */}
      <div className="mb-3 p-2 bg-neutral-900/50 rounded">
        <div className="text-[10px] text-neutral-400 mb-2">Shape</div>
        <div className="flex gap-1">
          <button
            data-testid="crop-shape-box"
            onClick={() => onSelectShape('box')}
            className={`flex-1 px-2 py-1.5 text-xs rounded ${cropMode === 'box' ? 'bg-blue-600 text-white' : 'bg-neutral-700 text-neutral-400 hover:bg-neutral-600'}`}
          >
            Box
          </button>
          <button
            data-testid="crop-shape-rect"
            onClick={() => onSelectShape('rect')}
            className={`flex-1 px-2 py-1.5 text-xs rounded ${cropMode === 'rect' ? 'bg-blue-600 text-white' : 'bg-neutral-700 text-neutral-400 hover:bg-neutral-600'}`}
          >
            Rect
          </button>
          <button
            data-testid="crop-shape-polygon"
            onClick={() => onSelectShape('polygon')}
            className={`flex-1 px-2 py-1.5 text-xs rounded ${cropMode === 'polygon' ? 'bg-blue-600 text-white' : 'bg-neutral-700 text-neutral-400 hover:bg-neutral-600'}`}
          >
            Polygon
          </button>
        </div>
      </div>

      {/* Mode: Keep Inside / Keep Outside / Segment. Mutually exclusive; map onto
          cropInvert (which half the original keeps) and cropSegment (whether the
          other half is discarded or spun off as a new cloud). */}
      <div className="mb-3 p-2 bg-neutral-900/50 rounded">
        <div className="text-[10px] text-neutral-400 mb-2">Mode</div>
        <div className="flex gap-1">
          <button
            data-testid="crop-mode-inside"
            aria-pressed={!cropInvert && !cropSegment}
            onClick={onKeepInside}
            className={`flex-1 px-2 py-1.5 text-xs rounded ${!cropInvert && !cropSegment ? 'bg-green-600 text-white' : 'bg-neutral-700 text-neutral-400 hover:bg-neutral-600'}`}
          >
            Keep Inside
          </button>
          <button
            data-testid="crop-mode-outside"
            aria-pressed={cropInvert && !cropSegment}
            onClick={onKeepOutside}
            className={`flex-1 px-2 py-1.5 text-xs rounded ${cropInvert && !cropSegment ? 'bg-red-600 text-white' : 'bg-neutral-700 text-neutral-400 hover:bg-neutral-600'}`}
          >
            Keep Outside
          </button>
          <button
            data-testid="crop-mode-segment"
            aria-pressed={cropSegment}
            onClick={onSegment}
            className={`flex-1 px-2 py-1.5 text-xs rounded ${cropSegment ? 'bg-amber-500 text-white' : 'bg-neutral-700 text-neutral-400 hover:bg-neutral-600'}`}
          >
            Segment
          </button>
        </div>
        <div className="text-[10px] text-neutral-500 mt-1.5 leading-tight">
          {cropSegment
            ? 'Splits in two: original keeps the in-region points, a new cloud gets the rest.'
            : 'Cropped-out points are discarded.'}
        </div>
      </div>

      {cropMode === 'box' && cropBox && (
        <>
          {/* Box dimensions */}
          <div className="mb-3 p-2 bg-neutral-900/50 rounded">
            <div className="text-[10px] text-neutral-400 mb-2">Dimensions</div>
            <div className="grid grid-cols-3 gap-1">
              {AXES.map((axisKey) => {
                const size = cropBox.max[axisKey] - cropBox.min[axisKey];
                return (
                  <div key={axisKey} className="flex flex-col">
                    <label className="text-[9px] text-neutral-500 mb-0.5">{axisKey.toUpperCase()}</label>
                    <DebouncedNumberInput
                      data-testid={`crop-dim-${axisKey}`}
                      step={0.1}
                      value={parseFloat(size.toFixed(2))}
                      onCommit={(newSize) => onSetBoxSize(axisKey, newSize)}
                      className="w-full px-1 py-0.5 text-[10px] bg-neutral-700 border border-neutral-600 rounded text-white text-center"
                    />
                  </div>
                );
              })}
            </div>
          </div>
          {/* Center position */}
          <div className="mb-3 p-2 bg-neutral-900/50 rounded">
            <div className="text-[10px] text-neutral-400 mb-2">Center Position</div>
            <div className="grid grid-cols-3 gap-1">
              {AXES.map((axisKey) => {
                const center = (cropBox.max[axisKey] + cropBox.min[axisKey]) / 2;
                return (
                  <div key={axisKey} className="flex flex-col">
                    <label className="text-[9px] text-neutral-500 mb-0.5">{axisKey.toUpperCase()}</label>
                    <DebouncedNumberInput
                      data-testid={`crop-center-${axisKey}`}
                      step={0.1}
                      value={parseFloat(center.toFixed(2))}
                      onCommit={(newCenter) => onSetBoxCenter(axisKey, newCenter)}
                      className="w-full px-1 py-0.5 text-[10px] bg-neutral-700 border border-neutral-600 rounded text-white text-center"
                    />
                  </div>
                );
              })}
            </div>
          </div>
          <button
            data-testid="crop-draw-box"
            onClick={onDrawBox}
            className={`w-full px-2 py-1.5 text-xs rounded mb-2 ${cropDrawState === 'awaiting-box-corner-1' || cropDrawState === 'awaiting-box-corner-2' ? 'bg-amber-600 text-white' : 'bg-neutral-700 hover:bg-neutral-600 text-neutral-200'}`}
          >
            {cropDrawState === 'awaiting-box-corner-1'
              ? 'Click first corner on ground…'
              : cropDrawState === 'awaiting-box-corner-2'
                ? 'Click second corner on ground…'
                : 'Draw box in viewport'}
          </button>
          <button
            onClick={onResetBox}
            className="w-full px-2 py-1.5 text-xs bg-neutral-700 hover:bg-neutral-600 rounded mb-2"
          >
            Reset Crop Box
          </button>
        </>
      )}

      {cropMode === 'polygon' && (
        <div className="mb-3 p-2 bg-neutral-900/50 rounded text-[10px] text-neutral-300">
          {cropDrawState === 'drawing-polygon' ? (
            <>
              <div className="font-medium text-neutral-200 mb-1">Drawing polygon</div>
              Click in the viewport to add vertices. Right-click or Backspace removes the last. Press Enter to close, Esc to cancel.
              <div className="mt-2 text-neutral-400">Vertices: {polygonVertexCount}</div>
            </>
          ) : hasCropPolygon ? (
            <>
              <div className="font-medium text-neutral-200 mb-1">Polygon ({cropPolygonPointCount} vertices)</div>
              Preview shown above. Press Enter to apply, or click below to redraw.
              <button
                onClick={onRedrawPolygon}
                className="mt-2 w-full px-2 py-1.5 text-xs bg-neutral-700 hover:bg-neutral-600 rounded text-neutral-200"
              >
                Redraw polygon
              </button>
            </>
          ) : (
            <>
              No polygon yet.
              <button
                onClick={onStartPolygon}
                className="mt-2 w-full px-2 py-1.5 text-xs bg-neutral-700 hover:bg-neutral-600 rounded text-neutral-200"
              >
                Start drawing
              </button>
            </>
          )}
        </div>
      )}

      {cropMode === 'rect' && (
        <div className="mb-3 p-2 bg-neutral-900/50 rounded text-[10px] text-neutral-300">
          {cropDrawState === 'drawing-rect' ? (
            <>
              <div className="font-medium text-neutral-200 mb-1">Drawing rectangle</div>
              Drag in the viewport to draw a rectangle from any angle. Esc to cancel.
            </>
          ) : hasCropPolygon ? (
            <>
              <div className="font-medium text-neutral-200 mb-1">Rectangle ready</div>
              Preview shown above. Press Apply, or click below to redraw.
              <button
                onClick={onRedrawRect}
                className="mt-2 w-full px-2 py-1.5 text-xs bg-neutral-700 hover:bg-neutral-600 rounded text-neutral-200"
              >
                Redraw rectangle
              </button>
            </>
          ) : (
            <>
              No rectangle yet.
              <button
                onClick={onStartRect}
                className="mt-2 w-full px-2 py-1.5 text-xs bg-neutral-700 hover:bg-neutral-600 rounded text-neutral-200"
              >
                Start drawing
              </button>
            </>
          )}
        </div>
      )}

      <button
        data-testid="crop-apply"
        onClick={onApply}
        disabled={applyDisabled}
        className="w-full px-2 py-1.5 mt-1 text-xs font-medium rounded bg-green-600 hover:bg-green-500 disabled:bg-neutral-700 disabled:text-neutral-500 text-white disabled:cursor-not-allowed transition-colors"
      >
        {cropSegment ? 'Segment' : 'Apply crop to'} {selectionCount} scan{selectionCount === 1 ? '' : 's'}
      </button>
    </div>
  );
}
