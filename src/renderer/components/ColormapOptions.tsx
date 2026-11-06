import { COLORMAP_GROUPS, COLORMAP_LABELS } from '../lib/colormaps';

// The <option>s of every colormap picker, grouped so the discrete label maps
// (which color by value, cycling) read as a different kind of thing from the
// gradients. One component so the pickers can't drift apart.
//
// `gradientsOnly` is for pickers whose values are never labels (an LAD grid's
// densities): a label map would draw a continuous field as a handful of flat
// bands, which is never what that picker is for.
export function ColormapOptions({ gradientsOnly = false }: { gradientsOnly?: boolean }) {
  const groups = gradientsOnly ? COLORMAP_GROUPS.slice(0, 1) : COLORMAP_GROUPS;
  if (groups.length === 1) {
    return <>{groups[0].names.map((name) => <option key={name} value={name}>{COLORMAP_LABELS[name]}</option>)}</>;
  }
  return (
    <>
      {groups.map((group) => (
        <optgroup key={group.label} label={group.label}>
          {group.names.map((name) => <option key={name} value={name}>{COLORMAP_LABELS[name]}</option>)}
        </optgroup>
      ))}
    </>
  );
}
