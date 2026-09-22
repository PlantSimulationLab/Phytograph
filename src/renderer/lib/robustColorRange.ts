import { categoricalSchemeForCloud } from './classification';
import type { PointCloudData } from './pointCloudTypes';

/**
 * The [min, max] a CONTINUOUS scalar's colormap should be stretched across:
 * the backend's 1st-99th percentile of the column when one is available and
 * applicable, else the raw extrema the caller already has.
 *
 * Why the percentile is the right default. A colormap maps its domain onto the
 * full ramp, so the domain's endpoints are set by the single most extreme value
 * in the column. One multipath return a kilometre above the canopy, one
 * saturated specular spike in reflectance, one mis-registered scan — and every
 * real point is squeezed into a few percent of the ramp. The scene reads as one
 * flat colour and the variation the user is actually looking for is gone, with
 * nothing on screen to say why. Trimming a 1% tail from each end costs the
 * outliers their exact position (they clamp to the end colours, which is what a
 * user wants for noise) and buys back the whole ramp for the data.
 *
 * WHY THE CATEGORICAL GATE IS HERE AND NOT IN THE BACKEND. Trimming a class-ID
 * column is destructive in a way trimming a measurement is not: the rarest class
 * is, by definition, in the tail, so a 1% trim silently deletes it from the
 * palette and every point owning it is repainted as its neighbour. The backend
 * cannot avoid this on its own — whether a numeric column is a measurement or a
 * label is the user's import-wizard choice, it lives in this process's
 * module-level registries (`classification.ts`), and the user can flip it after
 * import. So the backend reports a percentile for every numeric column and the
 * decision is made here, against the same resolver the renderers use.
 *
 * The second reason the gate must be exact, and the one with teeth: in the
 * octree renderer the categorical STEP GRADIENT's bands are laid out against
 * this very range (`bandRange` in OctreePointCloud.tsx), while the class LIST is
 * resolved from the raw attribute range. Hand a trimmed range to a categorical
 * field and the two land in different value spaces — the bands shift against the
 * values they are meant to bracket and points systematically pick up the wrong
 * class. That is a silent mislabel, not a visual glitch, which is why this
 * resolves the scheme rather than pattern-matching on slug names.
 *
 * @param data   the cloud, for its robust ranges and observed class lists
 * @param field  attribute slug, as keyed in attributeRanges / robustAttributeRanges
 * @param raw    the absolute [min, max] to fall back to
 */
export function robustScalarRange(
  data: PointCloudData,
  field: string,
  raw: [number, number],
): [number, number] {
  const robust = data.octree?.robustAttributeRanges?.[field];
  if (!robust) return raw;

  // Resolve against the RAW range, matching how the renderers pick the class
  // list. A scheme here means the field is a label, and a percentile must not
  // touch it.
  //
  // Resolved through `categoricalSchemeForCloud` so a slug carrying a USER
  // PALETTE is recognised as a label here even if it never reached
  // DYNAMIC_CATEGORICAL — otherwise a hand-labelled column would be percentile-
  // trimmed like a measurement, dropping its rarest class off the colour ramp.
  // The palette path only ADDS resolutions; the nullness this gate reads is
  // otherwise identical, so this cannot disagree with the renderers.
  const observed = data.octree?.observedClasses?.[field];
  if (categoricalSchemeForCloud(field, raw, data.octree?.classPalettes, observed)) return raw;

  const [lo, hi] = robust;
  if (!isFinite(lo) || !isFinite(hi) || !(hi > lo)) return raw;

  // Never widen. The percentile range is a subset of the extrema whenever both
  // were measured over the same points, so a robust end outside the raw one
  // means they were not. That is defence in depth rather than a live bug: both
  // numbers now travel together on every response that carries either (import
  // and `_session_rebuild` alike), so a mismatched pairing should not arise.
  // It is cheap, and the failure it prevents is a domain containing no points.
  const clampedLo = Math.max(lo, raw[0]);
  const clampedHi = Math.min(hi, raw[1]);
  // ...but only when the two still overlap. A robust range that sits entirely
  // outside the raw one clamps to an INVERTED pair (min > max), which is worse
  // than either input: a negative span reverses the colormap and puts every
  // point off the end of the ramp. Non-overlap means the pairing is stale
  // enough that the percentile describes a different cloud, so distrust it
  // completely and keep the extrema we know match the rendered points.
  if (!(clampedHi > clampedLo)) return raw;
  return [clampedLo, clampedHi];
}
