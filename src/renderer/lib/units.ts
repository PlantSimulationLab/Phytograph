// Length units — the renderer's half of the per-scan unit contract.
//
// Phytograph works in METRES everywhere. That is not a hope: a cloud whose
// source declares another unit is scaled at import (backend
// `_scale_positions_to_metres`), so every physically-dimensioned constant in
// the app — CSF's cloth resolution, LAD's m²/m³, QSM's 4.23 mm twig radius,
// ICP's voxel floors — is measuring what it claims to measure.
//
// This module is the display/selection half: the slugs the wizard offers, their
// human names, and the conversion factors. THE FACTORS MUST MATCH
// `_UNIT_TO_METRES` in backend-api/main.py — they are asserted against each
// other by units.test.ts reading the backend source, because a silent
// disagreement would scale a cloud by one factor and label it with another.
//
// Pure — no React, no three.js.

export type LengthUnit = 'm' | 'km' | 'cm' | 'mm' | 'ft' | 'ftUS' | 'in';

/** Metres per one of each unit. Mirrors `_UNIT_TO_METRES` in main.py. */
export const UNIT_TO_METRES: Record<LengthUnit, number> = {
  m: 1.0,
  km: 1000.0,
  cm: 0.01,
  mm: 0.001,
  ft: 0.3048,
  // The US survey foot is 1200/3937 m exactly — it differs from the
  // international foot in the 7th significant figure, which is ~2 mm over a
  // 1 km survey. Most US State Plane zones use it, so the distinction is real
  // data rather than pedantry.
  ftUS: 1200.0 / 3937.0,
  in: 0.0254,
};

/** What the user sees in the dropdown. */
export const UNIT_LABELS: Record<LengthUnit, string> = {
  m: 'Metres',
  km: 'Kilometres',
  cm: 'Centimetres',
  mm: 'Millimetres',
  ft: 'Feet (international)',
  ftUS: 'Feet (US survey)',
  in: 'Inches',
};

/** Dropdown order: metric descending, then imperial. Metres first — it is the
 *  default and the overwhelmingly common case. */
export const UNIT_ORDER: LengthUnit[] = ['m', 'cm', 'mm', 'km', 'ft', 'ftUS', 'in'];

/** The unit assumed when a format cannot say and the user does not choose.
 *  Metres, because that is what every import implicitly assumed before units
 *  existed — so an unchanged workflow behaves exactly as it did. */
export const DEFAULT_UNIT: LengthUnit = 'm';

export function isLengthUnit(v: unknown): v is LengthUnit {
  return typeof v === 'string' && Object.prototype.hasOwnProperty.call(UNIT_TO_METRES, v);
}

/** Metres per unit, or null for an unrecognised slug (never a silent 1.0 —
 *  treating an unknown unit as metres is how a wrong scale ships unnoticed). */
export function metresPerUnit(unit: string | null | undefined): number | null {
  return isLengthUnit(unit) ? UNIT_TO_METRES[unit] : null;
}

/** Human name for a slug, falling back to the slug itself. */
export function unitLabel(unit: string | null | undefined): string {
  return isLengthUnit(unit) ? UNIT_LABELS[unit] : String(unit ?? '');
}

/**
 * Whether importing under `unit` would rescale the cloud.
 *
 * Drives the wizard's "will convert to metres" line: there is no point telling
 * a user their metre cloud is about to be converted to metres.
 */
export function wouldConvert(unit: string | null | undefined): boolean {
  const f = metresPerUnit(unit);
  return f !== null && f !== 1.0;
}

/**
 * A one-line explanation of what import will do, for the wizard.
 *
 * `certain` distinguishes a unit the FORMAT declared from one the user is
 * picking — the first is a statement of fact, the second a choice they own.
 */
export function unitSummary(unit: LengthUnit, certain: boolean): string {
  if (!wouldConvert(unit)) {
    return certain
      ? 'This file declares metres — no conversion needed.'
      : 'Coordinates will be used as-is.';
  }
  const name = unitLabel(unit).toLowerCase();
  return certain
    ? `This file declares ${name} — coordinates will be converted to metres.`
    : `Coordinates will be read as ${name} and converted to metres.`;
}
