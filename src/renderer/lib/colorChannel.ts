// Color channels — the per-object pseudocolor mapping, and the derivation of
// the viewer's legend stack from them.
//
// Background: the viewer used to hold exactly ONE `colormap` state variable,
// shared by every point cloud, mesh and LAD grid on screen. The colormap
// pickers that appeared per-mesh and per-LAD-result were all wired to that same
// setter, so "per-instance" colormaps were an illusion — changing one changed
// them all. Separately, each pseudocolored object type rendered its own legend
// overlay, so a scene could stack four unlabelled colorbars along the bottom
// edge with no indication of which belonged to what.
//
// A ColorChannel fixes both by moving the mapping onto the object that is being
// colored. Legends are then DERIVED from the set of active channels rather than
// hand-rolled per object type, which is what lets them be labelled, deduped and
// collapsed uniformly.
//
// Pure + stateless — no React, no three.js. Safe to unit-test directly.
import { ColormapName, RGB } from './colormaps';
import {
  CategoricalScheme,
  categoricalSchemeForRange,
  TREE_INSTANCE_ATTRIBUTE,
} from './classification';

// The pseudocolor mapping owned by a single object (cloud / mesh / LAD grid).
//
// `colormap` is deliberately OPTIONAL: absent means "inherit the scene
// default". That's what makes changing the scene default repaint every object
// the user hasn't explicitly overridden, without a sync pass writing the new
// name into every entry — and it's what lets an override be cleared by simply
// deleting the field.
export interface ColorChannel {
  // What the object is colored by. The vocabulary is per object type — a cloud
  // uses ColorMode ('height' | 'intensity' | 'scalar' | …), a mesh uses
  // MeshColorMode ('inclination' | 'azimuth' | 'area' | 'layer' | …), an LAD
  // grid is always 'lad'. Kept as a bare string so this module doesn't have to
  // union every object type's mode enum.
  mode: string;
  // The scalar field / DEM layer name, for modes that need one ('scalar',
  // 'layer'). Undefined for modes that are self-describing ('height', 'area').
  field?: string;
  // Undefined ⇒ inherit the scene default. See note above.
  colormap?: ColormapName;
  // User override of the mapped domain. Undefined ⇒ use the data-derived range.
  range?: { min: number; max: number };
  // Flip the colormap direction (low↔high) without picking a different map.
  reversed?: boolean;
}

// How a legend should be drawn for a channel.
//   'continuous'  — gradient bar with numeric min/mid/max ticks
//   'categorical' — one swatch + name per class
//   'none'        — the object is pseudocolored but gets NO legend entry
//
// 'none' exists for tree_instance: ids are arbitrary nominal labels, and a
// scene routinely holds 100+ trees, so neither a gradient (meaningless — tree 7
// is not "between" 6 and 8) nor a class list (fills the viewport) is useful.
// The points stay colored; only the legend is suppressed. Modelling this as an
// explicit kind keeps the decision here in the pure layer, rather than as a
// special case wired into the overlay JSX.
export type LegendKind = 'continuous' | 'categorical' | 'none';

// One object's contribution to the legend stack, before dedup/grouping.
export interface ChannelDescriptor {
  // Identity of the object this channel belongs to.
  objectId: string;
  // Display name of the object ("Oak scan 3", "DEM mesh"). The PRIMARY legend
  // caption — this is what tells the user which geometry a legend describes.
  objectName: string;
  // Plural noun for grouping several objects under one entry ("scans",
  // "meshes"). Used to caption a merged entry as "5 scans · Z Height".
  objectKindPlural: string;
  // What variable is mapped ("Z Height", "Inclination (°)", "LAD [m²/m³]").
  // The SECONDARY caption.
  variableLabel: string;
  // The resolved channel (colormap already inherited from the scene default).
  channel: ColorChannel & { colormap: ColormapName };
  // Data-derived domain, for continuous channels. The channel's own `range`
  // overrides this when present.
  dataRange?: { min: number; max: number };
  // Precomputed categorical scheme, when the channel is categorical.
  scheme?: CategoricalScheme;
  // Whether this object is currently selected in the viewer. Drives which
  // entry stays expanded when the stack collapses.
  selected?: boolean;
  // Which object family this came from. Carried onto the LegendEntry purely so
  // the overlay can keep emitting the per-family test ids the E2E suite has
  // asserted on since before the legends were unified ('colorbar' /
  // 'class-legend' for clouds, 'mesh-colorbar', 'lad-colorbar', …). It has no
  // effect on grouping — two clouds still merge with each other, never with a
  // mesh, because the mode/label/colormap already differ.
  origin?: 'cloud' | 'mesh' | 'lad';
}

// A ready-to-render legend: one or more objects sharing an identical channel.
export interface LegendEntry {
  // Stable identity for React keys and for remembering expand/collapse state.
  key: string;
  // Every object folded into this entry (>1 ⇒ merged group).
  objectIds: string[];
  // Caption. Either the single object's name, or "5 scans" for a merged group.
  objectLabel: string;
  variableLabel: string;
  kind: Exclude<LegendKind, 'none'>;
  colormap: ColormapName;
  reversed: boolean;
  // Continuous entries only — the domain actually being mapped.
  min?: number;
  max?: number;
  // Categorical entries only.
  scheme?: CategoricalScheme;
  // True when any folded object is selected.
  selected: boolean;
  // See ChannelDescriptor.origin — drives the legacy per-family test ids.
  origin?: 'cloud' | 'mesh' | 'lad';
}

// Resolve a possibly-partial channel against the scene default, so downstream
// code never has to think about inheritance.
export function resolveChannel(
  channel: ColorChannel | undefined,
  sceneDefault: ColormapName,
): (ColorChannel & { colormap: ColormapName }) | null {
  if (!channel) return null;
  return { ...channel, colormap: channel.colormap ?? sceneDefault };
}

// Whether an object's channel is using the scene default or its own override.
// Drives the "Reset to default" affordance in the object panels.
export function isChannelOverridden(channel: ColorChannel | undefined): boolean {
  return !!channel && channel.colormap !== undefined;
}

// Clear a colormap override, restoring inheritance from the scene default.
export function clearColormapOverride(channel: ColorChannel): ColorChannel {
  const { colormap: _dropped, ...rest } = channel;
  return rest;
}

// Classify a channel's legend treatment. Categorical detection defers entirely
// to `classification.ts` (which already knows about registered schemes,
// user-marked slugs, and the "force continuous" escape hatch) so the legend can
// never disagree with the colors the renderers actually paint.
export function legendKindFor(
  channel: ColorChannel,
  dataRange?: { min: number; max: number },
): LegendKind {
  return schemeAndKind(channel, dataRange).kind;
}

// The categorical scheme a channel resolves to, or null when it's continuous /
// legend-less. Callers don't have to precompute this — a descriptor may supply
// its own `scheme` (e.g. one already built while painting), but when it doesn't
// we derive it here from the same classification helpers the renderers use.
export function schemeFor(
  channel: ColorChannel,
  dataRange?: { min: number; max: number },
): CategoricalScheme | null {
  return schemeAndKind(channel, dataRange).scheme;
}

// Single source of truth for "is this categorical, and if so with what
// classes" — computed once so the kind and the scheme can never disagree.
function schemeAndKind(
  channel: ColorChannel,
  dataRange?: { min: number; max: number },
): { kind: LegendKind; scheme: CategoricalScheme | null } {
  // Modes that carry no mapped variable at all paint flat/looked-up colors —
  // there is nothing to put on a scale.
  if (channel.mode === 'solid' || channel.mode === 'single'
    || channel.mode === 'rgb' || channel.mode === 'per-scan') {
    return { kind: 'none', scheme: null };
  }
  if (channel.field === TREE_INSTANCE_ATTRIBUTE) return { kind: 'none', scheme: null };
  if (channel.field) {
    const range: [number, number] | null = dataRange
      ? [dataRange.min, dataRange.max]
      : null;
    const scheme = categoricalSchemeForRange(channel.field, range);
    if (scheme) return { kind: 'categorical', scheme };
  }
  return { kind: 'continuous', scheme: null };
}

// The domain a continuous channel actually maps: the user's override when set,
// else the data-derived range.
export function effectiveRange(
  channel: ColorChannel,
  dataRange?: { min: number; max: number },
): { min: number; max: number } | null {
  if (channel.range) return channel.range;
  return dataRange ?? null;
}

// Identity of a mapping, for deciding whether two objects can share one legend.
// Two clouds both colored by height with the same colormap and domain produce
// the same string and fold together; change either one's colormap and they
// split apart. The variable label is included so two different variables that
// coincidentally share a domain never merge.
// Quantize a domain for identity purposes. Two objects a user reads as "the
// same scale" must fold into one legend, and exact float equality is far too
// strict for that: two Poisson reconstructions of the same cloud produce
// inclination ranges like 0.012119–89.5436 and 0.012106–89.5436, which are
// indistinguishable on screen but not bit-equal. Splitting those into two
// legends printing the same numbers is precisely the clutter this redesign
// removes.
//
// Both bounds are quantized RELATIVE TO THE SPAN rather than to themselves.
// That matters: the two mins above differ by 0.1% of their own magnitude — a
// gap a per-bound rounding can't reliably close without also merging genuinely
// different scales — but by only 1.5e-7 of the span they sit in. A legend
// describes a scale, so the span is the right yardstick. The 1e-4 step keeps
// ~4 digits of the rendered ticks significant.
const IDENTITY_STEPS = 1e4;

function quantizeRange(min: number, max: number): string {
  if (!isFinite(min) || !isFinite(max)) return `${min}:${max}`;
  const span = Math.abs(max - min);
  // A degenerate (zero-width) domain has no span to normalize against, so fall
  // back to the raw values — there is nothing to smooth over.
  if (span === 0) return `${min}:${max}`;
  // The SPAN carries the scale (0–10 must never merge with 0–99), quantized to
  // 4 significant figures. The min is then placed within that span, so two
  // domains merge only when they have both the same width and the same offset.
  const offset = Math.round((min / span) * IDENTITY_STEPS);
  return `${span.toPrecision(4)}@${offset}`;
}

function channelIdentity(
  d: ChannelDescriptor,
  kind: LegendKind,
  scheme: CategoricalScheme | null,
): string {
  const range = effectiveRange(d.channel, d.dataRange);
  return [
    kind,
    d.channel.mode,
    d.channel.field ?? '',
    d.channel.colormap,
    d.channel.reversed ? 'rev' : '',
    d.variableLabel,
    range ? quantizeRange(range.min, range.max) : '',
    // Categorical schemes with different class lists must not merge even when
    // they share an attribute name (tree schemes are generated per max-id).
    scheme ? scheme.classes.map(c => c.value).join(',') : '',
  ].join('|');
}

// Build the legend stack from the active channels.
//
// Objects whose channel maps nothing ('none') are dropped — they stay colored,
// they just contribute no legend. Identical channels fold into a single entry
// captioned by the group, which is what removes most of the clutter in the
// common case (many scans, one shared color mode).
//
// Order is stable and meaningful: selected entries first (so the thing the user
// is working on stays visible when the stack collapses), then by first
// appearance in the input. Callers pass descriptors in scene order.
export function buildLegendEntries(descriptors: ChannelDescriptor[]): LegendEntry[] {
  // The plural noun rides alongside the entry rather than inside it — it's an
  // input to the group caption, not part of the rendered legend.
  const byIdentity = new Map<string, { entry: LegendEntry; plural: string }>();

  for (const d of descriptors) {
    const derivedResult = schemeAndKind(d.channel, d.dataRange);
    // A caller-supplied scheme is AUTHORITATIVE — and it also settles the kind.
    // Some palettes aren't registered in classification.ts at all (a mesh's
    // source-scan colouring uses the scans' own identifier swatches), so the
    // derivation would call them continuous and quietly drop the class list.
    // When the descriptor hands us classes, this is categorical by definition.
    const scheme = d.scheme ?? derivedResult.scheme ?? undefined;
    const kind: LegendKind = d.scheme ? 'categorical' : derivedResult.kind;
    if (kind === 'none') continue;

    const identity = channelIdentity(d, kind, scheme ?? null);
    const existing = byIdentity.get(identity);
    if (existing) {
      existing.entry.objectIds.push(d.objectId);
      existing.entry.selected = existing.entry.selected || !!d.selected;
      continue;
    }

    const range = effectiveRange(d.channel, d.dataRange);
    byIdentity.set(identity, {
      plural: d.objectKindPlural,
      entry: {
        key: identity,
        objectIds: [d.objectId],
        // Provisional — a group caption replaces this below once we know the
        // final fold count.
        objectLabel: d.objectName,
        variableLabel: d.variableLabel,
        kind,
        colormap: d.channel.colormap,
        reversed: !!d.channel.reversed,
        min: kind === 'continuous' ? range?.min : undefined,
        max: kind === 'continuous' ? range?.max : undefined,
        scheme: kind === 'categorical' ? scheme : undefined,
        selected: !!d.selected,
        origin: d.origin,
      },
    });
  }

  // Caption merged entries by count ("5 scans"), single entries by name.
  const entries = Array.from(byIdentity.values()).map(({ entry, plural }) => {
    if (entry.objectIds.length > 1) {
      entry.objectLabel = `${entry.objectIds.length} ${plural}`;
    }
    return entry;
  });

  // Selected first, otherwise stable. Array.prototype.sort is stable in every
  // engine we target, so equal keys keep insertion (scene) order.
  return entries.sort((a, b) => Number(b.selected) - Number(a.selected));
}

// Parse a CSS colour string into the 0–1 RGB triplet the legend schemes use.
// Handles the two forms the app actually stores: `#rgb` / `#rrggbb` swatch
// hexes (scan + mesh identifier colours) and `rgb(r, g, b)`. Anything else
// falls back to mid-grey rather than throwing — a legend swatch is not worth
// crashing a render over.
export function cssColorToRgb(css: string): RGB {
  const s = css.trim();
  if (s.startsWith('#')) {
    const hex = s.slice(1);
    const full = hex.length === 3
      ? hex.split('').map(c => c + c).join('')
      : hex;
    if (full.length >= 6) {
      const n = parseInt(full.slice(0, 6), 16);
      if (!Number.isNaN(n)) {
        return [((n >> 16) & 255) / 255, ((n >> 8) & 255) / 255, (n & 255) / 255];
      }
    }
    return [0.5, 0.5, 0.5];
  }
  const m = s.match(/^rgba?\(\s*([\d.]+)[\s,]+([\d.]+)[\s,]+([\d.]+)/i);
  if (m) {
    return [
      Math.min(1, Math.max(0, parseFloat(m[1]) / 255)),
      Math.min(1, Math.max(0, parseFloat(m[2]) / 255)),
      Math.min(1, Math.max(0, parseFloat(m[3]) / 255)),
    ];
  }
  return [0.5, 0.5, 0.5];
}

// How many legend entries stay fully expanded before the stack collapses the
// remainder into compact slivers. Three is the point where the bottom edge of
// a typical window starts to feel crowded.
export const LEGEND_EXPAND_LIMIT = 3;

export interface LegendLayout {
  expanded: LegendEntry[];
  collapsed: LegendEntry[];
}

// Split the stack into the entries drawn in full and the ones drawn as
// one-line slivers. At or below the limit everything stays expanded; above it,
// selected entries win the expanded slots (falling back to leading order, which
// buildLegendEntries has already put selection at the front of).
//
// `promotedKey` force-expands one entry regardless of selection — that's the
// click-a-sliver-to-read-it interaction.
export function layoutLegend(
  entries: LegendEntry[],
  promotedKey?: string,
  limit = LEGEND_EXPAND_LIMIT,
): LegendLayout {
  if (entries.length <= limit) return { expanded: entries, collapsed: [] };

  const promoted = promotedKey
    ? entries.filter(e => e.key === promotedKey)
    : [];
  const rest = entries.filter(e => e.key !== promotedKey);
  const slots = Math.max(0, limit - promoted.length);
  // Anything beyond the limit collapses; selection has already been sorted to
  // the front, so a plain prefix take honours it.
  const expanded = [...promoted, ...rest.slice(0, slots)];
  const expandedKeys = new Set(expanded.map(e => e.key));
  return {
    expanded,
    collapsed: entries.filter(e => !expandedKeys.has(e.key)),
  };
}
