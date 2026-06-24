import type { CategoricalScheme } from '../../lib/classification';

export interface ClassLegendProps {
  scheme: CategoricalScheme;
  label?: string;
}

// Discrete legend overlay for a categorical scalar attribute (e.g. ground
// classification). Shows one swatch + name per class, replacing the continuous
// Colorbar when the active attribute is categorical.
//
// The class list can be long (tree segmentation routinely yields 100+ trees),
// so the whole legend is capped to the viewport height and the rows scroll
// inside it — otherwise it overruns the bottom *and* top of the window. The
// scroll area opts back into pointer events (the overlay above it is
// pointer-events-none) so the wheel/drag actually scrolls the list. The header
// label stays pinned above the scroll region.
export function ClassLegend({ scheme, label }: ClassLegendProps) {
  return (
    <div className="flex flex-col max-h-[calc(100vh-7rem)] bg-neutral-800/90 backdrop-blur-sm rounded-lg shadow-lg px-2.5 py-2 border border-neutral-700/50 pointer-events-none select-none">
      {label && (
        <div className="text-[10px] text-neutral-300 text-center mb-1.5 max-w-[120px] truncate shrink-0" title={label}>
          {label}
        </div>
      )}
      <div className="flex flex-col gap-1 min-h-0 overflow-y-auto pointer-events-auto">
        {scheme.classes.map((cls) => (
          <div key={cls.value} className="flex items-center gap-2">
            <span
              className="w-3 h-3 rounded-sm border border-neutral-600 shrink-0"
              style={{
                backgroundColor: `rgb(${Math.round(cls.color[0] * 255)}, ${Math.round(
                  cls.color[1] * 255,
                )}, ${Math.round(cls.color[2] * 255)})`,
              }}
            />
            <span className="text-[10px] text-neutral-200 leading-none whitespace-nowrap">{cls.label}</span>
          </div>
        ))}
      </div>
    </div>
  );
}
