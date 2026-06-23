// Catalog of the per-hit scalar fields a synthetic LiDAR scan can produce, and
// the single source of truth for which fields the Synthetic Scan Options modal
// offers for retention. Consumed by the modal (to render the checklist) and by
// the scan→cloud builder (to decide which fields land on the cloud's color-by
// list — see assembleScanScalarFields in ./pointCloudHelpers and executeScan in
// PointCloudViewer).
//
// Two distinct categories gate at different layers:
//   - STANDARD fields (intensity/distance/timestamp/target_index/target_count)
//     are always read by the backend (mirrors _LIDAR_STANDARD_HIT_FIELDS in
//     backend-api/main.py). They're cheap; the only question is whether to keep
//     them on the cloud. An UNCHECKED standard is pruned in the cloud builder.
//   - OPTIONAL fields are only read when explicitly requested via the scan
//     request's `extra_fields`. `deviation`/`nRaysHit` are engine-produced for
//     multi-return scans (no primitive sampling); `reflectance` (and any custom
//     primitive label) is sampled from struck-surface primitive data, so it goes
//     through Helios `column_format` — flagged here by `isPrimitiveExtra`.
//
// `intensity` is in the catalog for its label/metadata but is EXCLUDED from the
// rendered checklist: it owns a dedicated "Intensity" color mode and always
// populates the cloud's `intensities` array regardless of this selection.
//
// Moving-platform fields (origin_x/y/z, pulse_id) are intentionally NOT in this
// catalog — the backend auto-appends them for moving scans and the leaf-area
// inversion needs them; they aren't a user retention choice here.

export type FieldAvailability = 'always' | 'multiReturn' | 'extra';

export interface ScanHitField {
  // Backend scalar key — matches the keys of LidarScanResult.scalars and the
  // labels sent in the scan request's `extra_fields`.
  slug: string;
  // Human-readable name shown in the checklist and in the color-by picker.
  label: string;
  // One-line explanation shown under the checkbox.
  description: string;
  // When the field actually resolves to data: always, only for multi-return
  // scans (rays per pulse > 1), or only when present as primitive data.
  availability: FieldAvailability;
  // One of the five always-read standard fields (mirrors the backend list).
  isStandard: boolean;
  // Sampled from primitive data → must be passed to Helios via column_format
  // (vs. engine-produced fields the backend only needs to add to fields_to_read).
  isPrimitiveExtra: boolean;
  // Whether this field is retained by default on a fresh install.
  defaultRetained: boolean;
}

export const SCAN_HIT_FIELDS: ScanHitField[] = [
  {
    slug: 'intensity',
    label: 'Intensity',
    description: 'Beam·normal return magnitude (0–1), scaled by reflectivity.',
    availability: 'always',
    isStandard: true,
    isPrimitiveExtra: false,
    defaultRetained: true,
  },
  {
    slug: 'distance',
    label: 'Distance (m)',
    description: 'Range from the scanner to the hit along the beam.',
    availability: 'always',
    isStandard: true,
    isPrimitiveExtra: false,
    defaultRetained: true,
  },
  {
    slug: 'timestamp',
    label: 'Timestamp (s)',
    description: 'Pulse-emission time. Constant for a single static sweep.',
    availability: 'always',
    isStandard: true,
    isPrimitiveExtra: false,
    defaultRetained: true,
  },
  {
    slug: 'target_index',
    label: 'Return index',
    description: 'Return number within a pulse (0 = first). 0 for single-return.',
    availability: 'always',
    isStandard: true,
    isPrimitiveExtra: false,
    defaultRetained: false,
  },
  {
    slug: 'target_count',
    label: 'Return count',
    description: 'Total returns from the pulse. 1 for single-return scans.',
    availability: 'always',
    isStandard: true,
    isPrimitiveExtra: false,
    defaultRetained: false,
  },
  {
    slug: 'deviation',
    label: 'Pulse deviation',
    description: 'Spread of sub-ray ranges within a pulse.',
    availability: 'multiReturn',
    isStandard: false,
    isPrimitiveExtra: false,
    defaultRetained: false,
  },
  {
    slug: 'nRaysHit',
    label: 'Sub-rays hit',
    description: 'Sub-rays in the beam cone that returned a hit.',
    availability: 'multiReturn',
    isStandard: false,
    isPrimitiveExtra: false,
    defaultRetained: false,
  },
  {
    slug: 'reflectance',
    label: 'Reflectance',
    description: 'Surface reflectance (dB), sampled from primitive data if present.',
    availability: 'extra',
    isStandard: false,
    isPrimitiveExtra: true,
    defaultRetained: false,
  },
  {
    // Organ type carried from a generated plant (leaf/petiole/shoot/peduncle/
    // fruit). Sampled from the "organ" primitive data the scan mesh loader stamps
    // when this field is checked; colors categorically via ORGAN_SCHEME. Imported
    // (non-plant) meshes have no organ data, so those hits read as unknown.
    slug: 'organ',
    label: 'Organ type',
    description: 'Plant organ each hit struck (leaf, petiole, shoot, peduncle, fruit). Plant meshes only.',
    availability: 'extra',
    isStandard: false,
    isPrimitiveExtra: true,
    defaultRetained: false,
  },
];

// The five standard slugs the backend always reads (mirrors
// _LIDAR_STANDARD_HIT_FIELDS in backend-api/main.py).
export const STANDARD_HIT_FIELD_SLUGS: string[] = SCAN_HIT_FIELDS
  .filter((f) => f.isStandard)
  .map((f) => f.slug);

// Slugs retained by default (used for fresh options and as the coercion fallback).
export const DEFAULT_RETAINED_FIELDS: string[] = SCAN_HIT_FIELDS
  .filter((f) => f.defaultRetained)
  .map((f) => f.slug);

// All catalog slugs — used by coercion to drop unknown stored values.
export const SCAN_HIT_FIELD_SLUGS: string[] = SCAN_HIT_FIELDS.map((f) => f.slug);

// Explanation shown under a field whose data may not resolve for the current
// scan settings. `null` for always-available fields (no caveat needed).
export function availabilityNote(availability: FieldAvailability): string | null {
  switch (availability) {
    case 'multiReturn':
      return 'Only recorded for multi-return scans — set rays per pulse > 1.';
    case 'extra':
      return 'Sampled from primitive data if present; otherwise dropped.';
    default:
      return null;
  }
}
