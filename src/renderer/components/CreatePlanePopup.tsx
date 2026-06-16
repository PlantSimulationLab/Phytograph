import { useState, useCallback } from 'react';
import { X, Square } from 'lucide-react';
import { DebouncedNumberInput } from './DebouncedNumberInput';

export interface CreatePlaneParams {
  center: { x: number; y: number; z: number };
  scale: { x: number; y: number; z: number };   // x=width, y=length, z=1
  rotation: { x: number; y: number; z: number }; // Euler degrees
}

interface CreatePlanePopupProps {
  isOpen: boolean;
  onClose: () => void;
  onCreate: (params: CreatePlaneParams) => void;
}

type Vec3 = { x: number; y: number; z: number };

export function CreatePlanePopup({ isOpen, onClose, onCreate }: CreatePlanePopupProps) {
  const [center, setCenter] = useState<Vec3>({ x: 0, y: 0, z: 0 });
  const [width, setWidth] = useState(1);
  const [length, setLength] = useState(1);
  const [rotation, setRotation] = useState<Vec3>({ x: 0, y: 0, z: 0 });

  const handleSubmit = useCallback(() => {
    onCreate({
      center,
      scale: { x: width, y: length, z: 1 },
      rotation,
    });
    onClose();
  }, [center, width, length, rotation, onCreate, onClose]);

  if (!isOpen) return null;

  const numCls =
    'w-full px-2 py-1.5 bg-neutral-700 border border-neutral-600 rounded text-xs text-white focus:outline-none focus:ring-1 focus:ring-green-500/50';
  const axes: Array<keyof Vec3> = ['x', 'y', 'z'];

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center"
      onKeyDown={(e) => e.stopPropagation()}
    >
      <div className="absolute inset-0 bg-black/60 backdrop-blur-sm" onClick={onClose} />

      <div
        data-testid="create-plane-popup"
        className="relative bg-neutral-800 rounded-xl shadow-2xl border border-neutral-700 w-full max-w-md mx-4 overflow-hidden"
      >
        <div className="flex items-center justify-between px-4 py-3 border-b border-neutral-700 bg-neutral-800/90">
          <div className="flex items-center gap-2">
            <Square className="w-4 h-4 text-green-400" />
            <h2 className="text-sm font-semibold text-white">Create Plane</h2>
          </div>
          <button onClick={onClose} className="p-1 rounded hover:bg-neutral-700 transition-colors">
            <X className="w-4 h-4 text-neutral-400" />
          </button>
        </div>

        <div className="p-4 space-y-4 max-h-[72vh] overflow-y-auto">
          {/* Center coordinate */}
          <div>
            <label className="text-xs font-medium text-neutral-300 block mb-1.5">Center</label>
            <div className="grid grid-cols-3 gap-2">
              {axes.map((axis) => (
                <div key={axis}>
                  <label className="text-[10px] text-neutral-400 block mb-1 uppercase">{axis}</label>
                  <DebouncedNumberInput
                    data-testid={`plane-center-${axis}`}
                    step={0.1}
                    value={center[axis]}
                    format={(n) => n.toFixed(3)}
                    onCommit={(n) => setCenter((prev) => ({ ...prev, [axis]: n }))}
                    className={numCls}
                  />
                </div>
              ))}
            </div>
          </div>

          {/* Size (in-plane dimensions) */}
          <div>
            <label className="text-xs font-medium text-neutral-300 block mb-1.5">Size</label>
            <div className="grid grid-cols-2 gap-2">
              <div>
                <label className="text-[10px] text-neutral-400 block mb-1">Width</label>
                <DebouncedNumberInput
                  data-testid="plane-width"
                  step={0.1}
                  min={0}
                  value={width}
                  format={(n) => n.toFixed(3)}
                  onCommit={(n) => setWidth(n)}
                  className={numCls}
                />
              </div>
              <div>
                <label className="text-[10px] text-neutral-400 block mb-1">Length</label>
                <DebouncedNumberInput
                  data-testid="plane-length"
                  step={0.1}
                  min={0}
                  value={length}
                  format={(n) => n.toFixed(3)}
                  onCommit={(n) => setLength(n)}
                  className={numCls}
                />
              </div>
            </div>
            <p className="text-[9px] text-neutral-500 mt-1">
              A plane is flat — width &amp; length are its two in-plane dimensions.
            </p>
          </div>

          {/* Euler rotation */}
          <div>
            <label className="text-xs font-medium text-neutral-300 block mb-1.5">Rotation (°)</label>
            <div className="grid grid-cols-3 gap-2">
              {axes.map((axis) => (
                <div key={axis}>
                  <label className="text-[10px] text-neutral-400 block mb-1 uppercase">{axis}</label>
                  <DebouncedNumberInput
                    data-testid={`plane-rot-${axis}`}
                    step={1}
                    value={rotation[axis]}
                    format={(n) => n.toFixed(1)}
                    onCommit={(n) => setRotation((prev) => ({ ...prev, [axis]: n }))}
                    className={numCls}
                  />
                </div>
              ))}
            </div>
          </div>
        </div>

        <div className="px-4 py-3 border-t border-neutral-700 bg-neutral-800/90 flex items-center justify-end gap-2">
          <button
            onClick={onClose}
            className="px-3 py-2 text-xs rounded font-medium bg-neutral-700 hover:bg-neutral-600 text-neutral-200"
          >
            Cancel
          </button>
          <button
            data-testid="create-plane-submit"
            onClick={handleSubmit}
            className="px-4 py-2 text-xs rounded font-medium flex items-center gap-2 bg-green-600 hover:bg-green-500 text-white"
          >
            <Square className="w-3.5 h-3.5" /> Create Plane
          </button>
        </div>
      </div>
    </div>
  );
}
