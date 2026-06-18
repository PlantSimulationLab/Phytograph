// Catalog of selectable scanner instruments.
//
// Picking a model in the Add-Scan dialog does two things:
//   1. Chooses which mesh denotes the scan position in the viewer (a
//      manufacturer-shaped body, or a plain sphere for "generic"), rendered at
//      the instrument's *real-world* height (a Velodyne is a fist-sized puck; a
//      Leica P40 is a knee-high tripod head — see `heightMeters`).
//   2. Auto-fills the acquisition parameters that are a fixed property of the
//      instrument's optics and deflection unit — beam diameter/divergence, scan
//      pattern, return capability, per-channel elevations, and the maximum
//      angular sweep. Resolution (point counts) is a user choice, so it is left
//      alone. Every auto-filled value remains editable afterward.
//
// The "generic" model is the default: an unknown or user-customised scanner. It
// carries no preset (the form keeps DEFAULT_SCAN_PARAMETERS) and renders the
// neutral sphere marker.
//
// Instrument values are taken from manufacturer datasheets. The angular-sweep
// presets are the instrument's *maximum* vertical reach in zenith degrees
// (0° = straight up, 90° = horizon, 180° = straight down). A single-mirror TLS
// rotates 360° in azimuth, so its vertical mirror sweep of S degrees reaches
// from zenith 0° down to S/2 degrees from vertical, leaving a (360−S)/... blind
// cone beneath the tripod — which is why none of the terrestrial units reach
// zenith 180°.
//   - RIEGL VZ-400i:   beam divergence 0.35 mrad @ 1/e²; vertical (line) scan
//                      total 100° (+60°/−40° from horizon) → zenith 30–130°;
//                      horizontal max 360°; ~308 mm tall. Datasheet quotes no
//                      exit aperture. RIEGL VZ-400i datasheet (2025-09-16).
//   - Leica P40:       beam divergence < 0.23 mrad FWHM, ⌀ ≤ 3.5 mm at front
//                      window; vertical FOV 290° (mirror sweep → zenith 0–145°),
//                      horizontal 360°; ~395 mm tall. Leica P30/P40 datasheet.
//   - FARO Focus S350: beam divergence 0.3 mrad @ 1/e, ⌀ 2.12 mm at exit @ 1/e;
//                      vertical FOV 300° given as 2×150° (→ zenith 0–150°),
//                      horizontal 360°; ~191 mm tall body. FARO Focus M/S tech
//                      sheet.
//   - Velodyne HDL-32E: spinning multibeam, 32 channels evenly spaced
//                      +10.67° → −30.67° (1.33° steps), 360° azimuth, beam
//                      divergence ~2.79 mrad from a rectangular ~1/2″ × 1/4″
//                      source spot (wide axis 12.7 mm); ~144 mm tall.
//                      Velodyne HDL-32E datasheet / user manual.

import type { ScanParameters } from './scanParameters';

import sphereUrl from '../assets/models/sphere.ply?url';
import faroFocusUrl from '../assets/models/FaroFocus.obj?url';
import leicaP40Url from '../assets/models/LeicaP40.obj?url';
import velodyneHdlUrl from '../assets/models/Velodyn_HDL.obj?url';
import rieglVzUrl from '../assets/models/riegl_vz.obj?url';

export type ScannerModelId =
  | 'generic'
  | 'riegl_vz400i'
  | 'leica_p40'
  | 'faro_focus_s350'
  | 'velodyne_hdl32e';

export type ScannerMeshFormat = 'ply' | 'obj';

// The subset of ScanParameters an instrument fixes. Resolution (zenithPoints /
// azimuthPoints) and placement (origin, tilt) are never part of a preset.
export type ScannerModelPreset = Partial<
  Pick<
    ScanParameters,
    | 'pattern'
    | 'returnType'
    | 'beamExitDiameterM'
    | 'beamDivergenceMrad'
    | 'beamElevationAnglesDeg'
    | 'zenithMinDeg'
    | 'zenithMaxDeg'
    | 'azimuthMinDeg'
    | 'azimuthMaxDeg'
    | 'pulseRateHz'
  >
>;

export interface ScannerModel {
  id: ScannerModelId;
  label: string;
  // Marker mesh and its loader format.
  meshUrl: string;
  meshFormat: ScannerMeshFormat;
  // Real-world height of the instrument body in metres. The marker mesh is
  // uniformly scaled so its bounding-box height matches this, regardless of the
  // units the source mesh was authored in (the bundled OBJs are inconsistent —
  // some metres, the RIEGL mesh millimetres). Anchors visual scale to reality.
  heightMeters: number;
  // Instrument-fixed acquisition parameters. Empty for 'generic'.
  preset: ScannerModelPreset;
}

// The Velodyne HDL-32E's 32 channels span +10.67° to −30.67° in even 1.33°
// steps (manufacturer convention: positive = above horizon). Generated rather
// than transcribed so the spacing is exact.
function hdl32eElevations(): number[] {
  const top = 10.67;
  const step = 1.33333; // 41.33° total / 31 gaps
  return Array.from({ length: 32 }, (_, i) =>
    Math.round((top - i * step) * 100) / 100,
  );
}

export const SCANNER_MODELS: ScannerModel[] = [
  {
    id: 'generic',
    label: 'Generic / custom',
    meshUrl: sphereUrl,
    meshFormat: 'ply',
    // A neutral sphere has no real instrument size. Render it at 75% of the
    // historical 0.35 m marker height so it reads as a modest point-marker
    // rather than a tripod-sized body.
    heightMeters: 0.2625,
    preset: {},
  },
  {
    id: 'riegl_vz400i',
    label: 'RIEGL VZ-400i',
    meshUrl: rieglVzUrl,
    meshFormat: 'obj',
    heightMeters: 0.308,
    preset: {
      pattern: 'raster',
      returnType: 'multi', // full-waveform, up to 15 targets/pulse
      beamDivergenceMrad: 0.35, // 0.35 mrad @ 1/e² (datasheet)
      // Datasheet quotes only divergence, not an exit aperture, so leave the
      // beam diameter at the form default rather than invent a figure.
      // Vertical (line) scan range total 100° (+60°/−40° from horizon) →
      // zenith 30–130°; horizontal (frame) max 360°.
      zenithMinDeg: 30,
      zenithMaxDeg: 130,
      azimuthMinDeg: 0,
      azimuthMaxDeg: 360,
      // Effective measurement rate up to ~1.2 MHz (datasheet PRR modes).
      pulseRateHz: 1200000,
    },
  },
  {
    id: 'leica_p40',
    label: 'Leica ScanStation P40',
    meshUrl: leicaP40Url,
    meshFormat: 'obj',
    heightMeters: 0.395,
    preset: {
      pattern: 'raster',
      returnType: 'single', // single-pulse TLS
      beamDivergenceMrad: 0.23, // < 0.23 mrad FWHM (datasheet)
      beamExitDiameterM: 0.0035, // ≤ 3.5 mm at front window (datasheet)
      // Vertical FOV 290°, horizontal 360°. The single vertical mirror sweeps
      // 290° of arc, so combined with the 360° head rotation it reaches from
      // straight up (zenith 0°) to 290/2 = 145° from vertical — i.e. 55° below
      // horizon — leaving a ~70° blind cone under the instrument (zenith
      // 145–180°). So the full vertical sweep is zenith 0–145°, not 0–180°.
      zenithMinDeg: 0,
      zenithMaxDeg: 145,
      azimuthMinDeg: 0,
      azimuthMaxDeg: 360,
      // ~1 MHz effective scan rate (datasheet).
      pulseRateHz: 1000000,
    },
  },
  {
    id: 'faro_focus_s350',
    label: 'FARO Focus S350',
    meshUrl: faroFocusUrl,
    meshFormat: 'obj',
    heightMeters: 0.191,
    preset: {
      pattern: 'raster',
      returnType: 'single',
      beamDivergenceMrad: 0.3, // 0.3 mrad @ 1/e (datasheet)
      beamExitDiameterM: 0.00212, // 2.12 mm at exit @ 1/e (datasheet)
      // Vertical FOV 300°, given on the datasheet as 2×150°: the mirror sweeps
      // ±150° from straight up, so it reaches zenith 0° to 150° (60° below
      // horizon) with a ~60° blind cone underneath (zenith 150–180°).
      // Horizontal 360°.
      zenithMinDeg: 0,
      zenithMaxDeg: 150,
      azimuthMinDeg: 0,
      azimuthMaxDeg: 360,
      // Up to ~976 kHz points/s (datasheet measurement rate).
      pulseRateHz: 976000,
    },
  },
  {
    id: 'velodyne_hdl32e',
    label: 'Velodyne HDL-32E',
    meshUrl: velodyneHdlUrl,
    meshFormat: 'obj',
    heightMeters: 0.144,
    preset: {
      pattern: 'spinning_multibeam',
      returnType: 'multi', // dual-return (strongest + last)
      beamDivergenceMrad: 2.79,
      // The HDL-32E emits a rectangular spot ~1/2″ × 1/4″ at the source (12.7 ×
      // 6.35 mm), which is what yields the 2.79 mrad divergence. This field is a
      // single scalar (round-beam assumption), so use the wide axis — the
      // dimension the divergence figure is keyed to. (manual, p.26)
      beamExitDiameterM: 0.0127,
      beamElevationAnglesDeg: hdl32eElevations(),
      azimuthMinDeg: 0,
      azimuthMaxDeg: 360,
      // ~695 kHz: 32 channels firing at ~21.7 kHz each (datasheet, single return).
      pulseRateHz: 695000,
    },
  },
];

export const DEFAULT_SCANNER_MODEL: ScannerModelId = 'generic';

export function getScannerModel(id: ScannerModelId | undefined): ScannerModel {
  return (
    SCANNER_MODELS.find(m => m.id === id) ??
    SCANNER_MODELS.find(m => m.id === DEFAULT_SCANNER_MODEL)!
  );
}
