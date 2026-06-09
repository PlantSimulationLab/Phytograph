import { createLucideIcon } from 'lucide-react';

// Custom QSM (Quantitative Structure Model) icon.
//
// Why a custom icon: the app previously borrowed lucide's `Dna` glyph for QSMs,
// but `Dna` is ALSO used by the Morph-Plant feature, so the two read as the same
// thing. A QSM reconstructs a tree as connected woody segments classified by
// shoot rank (trunk = 0, scaffolds = 1, …), so the mark is a branching axis: a
// trunk that CONTINUES straight up through its forks (the axis-continuation idea
// that defines a shoot), with scaffolds sweeping up-and-out and each ending in a
// shorter twig (rank progression). That distinguishes it from a plain tree icon
// and from the Strahler skeleton mark.
//
// Built with lucide's own `createLucideIcon` factory, so the result is a true
// drop-in for `Dna` — same props (`className`, `size`, `color`, all SVG props),
// same 24×24 viewBox, `currentColor` stroke, width 2, round caps/joins. Replace
// `<Dna .../>` with `<QsmIcon .../>` at every QSM site, unchanged otherwise.
//
// Geometry (on the 24-unit lucide grid, y pointing down):
//   - trunk:          vertical axis base (12,22) → apex (12,4)
//   - right scaffold: forks at (12,15), sweeps up-right to (18,9), twig → (17,5)
//   - left scaffold:  forks higher at (12,11), sweeps up-left to (7,6), twig → (7.5,3)
export const QsmIcon = createLucideIcon('Qsm', [
  ['path', { d: 'M12 22V4', key: 'trunk' }],
  ['path', { d: 'M12 15l6-6', key: 'scaffold-right' }],
  ['path', { d: 'M18 9l-1-4', key: 'twig-right' }],
  ['path', { d: 'M12 11L7 6', key: 'scaffold-left' }],
  ['path', { d: 'M7 6l.5-3', key: 'twig-left' }],
]);

export default QsmIcon;
