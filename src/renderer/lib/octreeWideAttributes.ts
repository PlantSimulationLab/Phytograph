// Wide (>4-byte) octree attributes and potree's pre-normalisation of them.
//
// potree's binary decoder fills a Float32Array GPU buffer for every scalar
// attribute. A value wider than a float32 — a `double` gps-time, an int64 —
// would lose precision on the way in, so for those (and ONLY those) the
// decoder rescales into 0..1 first:
//
//     if (attribute.type.size > 4) {
//       const [lo, hi] = attribute.range;
//       offset = lo; scale = 1 / (hi - lo);
//     }
//     buffer[i] = (value - offset) * scale;     // → 0..1
//
// Everything that reads such a buffer back — the colour shader's value range
// (OctreePointCloud) and the point picker's attribute bubble (PointPicker) —
// has to know this, or it reports 0.034 where the file says 105. The shader
// side was fixed first and the picker missed it: an ASCII time column used to
// arrive as a float32 extra dim (no normalisation) until the import writers
// moved it to the LAS gps_time field for precision, at which point every
// picked timestamp silently became a fraction. Keeping the rule in one place
// means the next reader of a wide buffer cannot miss it either.
//
// The attribute table is potree's OWN parsed one rather than the backend's
// metadata: it is the same object the decoder branched on, so the two can
// never disagree, and it needs no extra plumbing through the octree ref.

type PotreeAttribute = { name?: string; type?: { size?: number }; range?: unknown };

function attributeTable(octree: unknown): PotreeAttribute[] | null {
  const o = octree as {
    pcoGeometry?: { pointAttributes?: { attributes?: unknown } };
    geometry?: { pointAttributes?: { attributes?: unknown } };
    octreeGeometry?: { pointAttributes?: { attributes?: unknown } };
  } | null | undefined;
  const attrs = o?.pcoGeometry?.pointAttributes?.attributes
    ?? o?.geometry?.pointAttributes?.attributes
    ?? o?.octreeGeometry?.pointAttributes?.attributes;
  return Array.isArray(attrs) ? (attrs as PotreeAttribute[]) : null;
}

function findAttribute(octree: unknown, field: string): PotreeAttribute | null {
  return attributeTable(octree)?.find((a) => a?.name === field) ?? null;
}

/** True when the octree attribute is wider than a float32 — i.e. potree's
 *  decoder pre-normalised its GPU buffer into 0..1. */
export function isWideOctreeAttribute(octree: unknown, field: string): boolean {
  const a = findAttribute(octree, field);
  return typeof a?.type?.size === 'number' && a.type.size > 4;
}

/** The [lo, hi] potree normalised a WIDE attribute against, or null when the
 *  attribute is not wide (its buffer holds raw values) or has no usable range.
 *  A degenerate range (hi <= lo) also yields null: potree's scale would be
 *  infinite there and the buffer holds garbage no inverse can recover. */
export function wideOctreeAttributeRange(octree: unknown, field: string): [number, number] | null {
  const a = findAttribute(octree, field);
  if (!(typeof a?.type?.size === 'number' && a.type.size > 4)) return null;
  const r = a.range;
  if (!Array.isArray(r) || r.length < 2) return null;
  const lo = Number(r[0]);
  const hi = Number(r[1]);
  if (!Number.isFinite(lo) || !Number.isFinite(hi) || hi <= lo) return null;
  return [lo, hi];
}

/** Map one normalised buffer value back onto its real range.
 *
 *  The buffer is a float32, so the value it carries is only good to about
 *  (hi − lo) · 2⁻²⁴ absolute — anything finer is rounding noise from the
 *  normalise/denormalise round trip, and it shows: a file value of exactly 105
 *  over [100, 247.5] came back as 105.00000009 and printed as "105.0000" where
 *  the source column says "105". Rounding to the decimal place one order
 *  coarser than that quantum discards only digits the buffer never had. */
export function denormalizeWideValue(v: number, lo: number, hi: number): number {
  const raw = lo + v * (hi - lo);
  const quantum = (hi - lo) * 2 ** -24;
  const decimals = Math.floor(-Math.log10(quantum)) - 1;
  if (!Number.isFinite(decimals) || decimals > 12) return raw;
  if (decimals <= 0) return Math.round(raw);
  return Number(raw.toFixed(decimals));
}

/** Undo potree's 0..1 normalisation on the wide entries of a picked point's
 *  {attribute: value} bag, in place. Non-wide entries are left untouched (their
 *  buffers hold the raw values), as is anything non-numeric. */
export function denormalizeWideAttributes(octree: unknown, values: Record<string, unknown>): void {
  for (const key of Object.keys(values)) {
    const v = values[key];
    if (typeof v !== 'number' || !Number.isFinite(v)) continue;
    const range = wideOctreeAttributeRange(octree, key);
    if (!range) continue;
    values[key] = denormalizeWideValue(v, range[0], range[1]);
  }
}
