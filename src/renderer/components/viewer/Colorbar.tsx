import { ColormapName, colormapToCssGradient } from '../../lib/colormaps';
import { formatColorbarTick } from '../../lib/pointCloudHelpers';

export interface ColorbarProps {
  colormap: ColormapName;
  min: number;
  max: number;
  label?: string;
}

// Vertical colorbar overlay; min at the bottom, max at the top.
export function Colorbar({ colormap, min, max, label }: ColorbarProps) {
  const mid = (min + max) / 2;
  return (
    <div className="bg-neutral-800/90 backdrop-blur-sm rounded-lg shadow-lg px-2 py-2 border border-neutral-700/50 pointer-events-none select-none">
      {label && (
        <div className="text-[10px] text-neutral-300 text-center mb-1 max-w-[80px] truncate" title={label}>
          {label}
        </div>
      )}
      <div className="flex items-stretch gap-2">
        <div
          className="w-4 rounded-sm border border-neutral-600"
          style={{ height: 180, background: colormapToCssGradient(colormap, 32, 'to top') }}
        />
        <div className="flex flex-col justify-between text-[10px] text-neutral-300 leading-none" style={{ height: 180 }}>
          <span>{formatColorbarTick(max)}</span>
          <span className="text-neutral-400">{formatColorbarTick(mid)}</span>
          <span>{formatColorbarTick(min)}</span>
        </div>
      </div>
    </div>
  );
}
