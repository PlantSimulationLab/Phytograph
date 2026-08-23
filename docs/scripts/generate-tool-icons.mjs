// Generate docs icons from the APP's own tool glyphs.
//
// Why: the workflow cards in docs/docs/workflows/index.md map one-to-one onto
// tools in the toolbar / command palette, so they must draw the SAME mark the
// user clicks. Hand-picking Material Design lookalikes drifted — `:material-graph:`
// for a tool that ships lucide's `Dna`, `:material-radar:` for `Compass`, and so
// on — which is worse than no icon, because it teaches the wrong glyph.
//
// This reads the path data straight out of lucide-react (the app's icon set,
// ISC-licensed) and writes docs/overrides/.icons/phytograph/*.svg, which mkdocs
// exposes as `:phytograph-<name>:` via the custom_icons setting in mkdocs.yml.
//
// Run from the REPO ROOT (needs node_modules/lucide-react):
//   node docs/scripts/generate-tool-icons.mjs
//
// Re-run when a tool's `icon:` changes in the registry (the `commands` useMemo in
// src/renderer/components/PointCloudViewer.tsx) and update MAP below to match.
//
// NOT generated here — the two icons the app draws itself, kept in sync by hand
// from src/renderer/components/icons/:
//   qsm.svg            <- QsmIcon.tsx
//   segment-ground.svg <- GroundSegmentIcon.tsx
// Note GroundSegmentIcon exists precisely because lucide's `Layers3` is a
// deprecated ALIAS of `Layers`; don't "simplify" it back to a lucide glyph or
// Segment Ground and Cross-section collide again.

import fs from 'fs';
import path from 'path';
const SRC = 'node_modules/lucide-react/dist/esm/icons';
const OUT = 'docs/overrides/.icons/phytograph';
// docs icon name -> lucide icon the tool registry actually uses
const MAP = {
  'transform': 'move-3d', 'crop': 'crop', 'erase': 'eraser', 'filter': 'filter',
  'resample': 'chart-scatter', 'cross-section': 'layers-3', 'backfill': 'cloud-fog',
  'align-icp': 'globe', 'auto-register': 'sparkles', 'stitch': 'merge',
  'label-points': 'brush', 'segment-wood': 'git-branch', 'segment-trees': 'trees',
  'triangulate': 'triangle', 'dem': 'mountain', 'skeleton': 'dna', 'lad': 'grid-3x3',
  'fit-crown': 'tree-deciduous', 'generate-plant': 'sprout', 'simulate-scan': 'compass',
};

function loadNodes(file, depth = 0) {
  if (depth > 3) throw new Error('alias loop: ' + file);
  const js = fs.readFileSync(path.join(SRC, file + '.js'), 'utf8');
  const alias = js.match(/export \{ default \} from ["']\.\/([a-z0-9-]+)\.js["']/);
  if (alias) return loadNodes(alias[1], depth + 1);
  const m = js.match(/__iconNode\s*=\s*(\[[\s\S]*?\]);/);
  if (!m) throw new Error('no __iconNode in ' + file);
  return JSON.parse(m[1].replace(/([{,]\s*)([A-Za-z][\w-]*)\s*:/g, '$1"$2":').replace(/'/g, '"'));
}

for (const [name, file] of Object.entries(MAP)) {
  const nodes = loadNodes(file);
  const body = nodes.map(([tag, attrs]) => {
    const a = Object.entries(attrs)
      .filter(([k]) => k !== 'key')
      .map(([k, v]) => `${k}="${v}"`).join(' ');
    return `<${tag} ${a}/>`;
  }).join('');
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">${body}</svg>`;
  fs.writeFileSync(path.join(OUT, name + '.svg'), svg + '\n');
  console.log('wrote', name + '.svg', '<-', file);
}
