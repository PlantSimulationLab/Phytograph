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
//   - Leica BLK360 (G1): beam divergence 0.4 mrad FWHM (full angle), ⌀ 2.25 mm
//                      at the front window (FWHM); vertical FOV 300° (mirror
//                      sweep → zenith 0–150°), horizontal 360°; single-return WFD
//                      time-of-flight, up to 360 kpts/s (830 nm, Class 1,
//                      2.16 MHz PRF); ⌀ 100 mm × 165 mm tall, ~1 kg. Leica BLK360
//                      G1 spec sheet + user manual (laser system performance).
//   - Leica BLK360 (G2): same laser front-end as the G1 — 830 nm, Class 1,
//                      0.4 mrad FWHM divergence, ⌀ 2.25 mm at the front window,
//                      single-return WFD. The G2 redesign is in the detector/
//                      electronics + imaging/VIS: the point rate ~doubles to
//                      680 kpts/s, range drops to 45 m (no preset field), and —
//                      unlike the G1 — the *vertical FOV is narrower*: 360°×270°
//                      (zenith 0–135°), not the G1's 360°×300°. Slightly smaller
//                      body (⌀ 80 mm × 155 mm, 0.85 kg). Reuses the same OBJ
//                      marker as the G1 (near-identical silhouette). Leica BLK360
//                      (G2) official spec sheet, 2022.
//   - FARO Focus S350: beam divergence 0.3 mrad @ 1/e, ⌀ 2.12 mm at exit @ 1/e;
//                      vertical FOV 300° given as 2×150° (→ zenith 0–150°),
//                      horizontal 360°; ~191 mm tall body. FARO Focus M/S tech
//                      sheet.
//   - Velodyne HDL-32E: spinning multibeam, 32 channels evenly spaced
//                      +10.67° → −30.67° (1.33° steps), 360° azimuth, beam
//                      divergence ~2.79 mrad from a rectangular ~1/2″ × 1/4″
//                      source spot (wide axis 12.7 mm); ~144 mm tall.
//                      Velodyne HDL-32E datasheet / user manual.
//   - RIEGL miniVUX-3UAV: a single-channel airborne profiler — one laser folded
//                      through a 45°-tilted *rotating mirror* spinning about a
//                      horizontal axis (mounted perpendicular to the flight
//                      line). That sweeps the beam through a flat PLANE (a 360°
//                      planar line scan), not a tilted cone — the conical 46°-FOV
//                      scan is the separate miniVUX-1DL, a different model. So it
//                      is the one-channel degenerate of a spinning multibeam: a
//                      single beam at 0° elevation whose azimuth sweep IS the
//                      mirror rotation. Modelled as spinning_multibeam with a
//                      one-element beamElevationAngles = [0]. Angular step width
//                      Δφ 0.018°–0.36° selectable → 1,000–20,000 points/rev; we
//                      preset the ~0.1° mid-setting (3,600 pts/rev). Selectable
//                      100/200/300 kHz PRR maps to 360°/180°/120° FOV — we preset
//                      the 360° @ 100 kHz mode (azimuth 0–360°, pulseRate 100 kHz).
//                      Waveform LiDAR, up to 5 target echoes/pulse → multi
//                      return. Beam divergence 1.6 × 0.5 mrad (footprint 160 ×
//                      50 mm @ 100 m); the scalar field takes the wide axis
//                      1.6 mrad (the divergence the footprint is keyed to), as
//                      with the HDL-32E. The datasheet quotes no exit aperture
//                      (only a footprint at range), so beam diameter is left at
//                      the form default, as with the VZ-400i. Body 243 × 99 ×
//                      85 mm, ~1.55 kg. RIEGL miniVUX-3UAV datasheet (2025-10-03).

import type { ScanParameters } from './scanParameters';

import sphereUrl from '../assets/models/sphere.ply?url';
import faroFocusUrl from '../assets/models/FaroFocus.obj?url';
import leicaP40Url from '../assets/models/LeicaP40.obj?url';
import leicaBlk360Url from '../assets/models/Leica_BLK360.obj?url';
import velodyneHdlUrl from '../assets/models/Velodyn_HDL.obj?url';
import rieglVzUrl from '../assets/models/riegl_vz.obj?url';
import rieglMiniVuxUrl from '../assets/models/riegl_miniVUX.obj?url';

export type ScannerModelId =
  | 'generic'
  | 'riegl_vz400i'
  | 'leica_p40'
  | 'leica_blk360'
  | 'leica_blk360_g2'
  | 'faro_focus_s350'
  | 'velodyne_hdl32e'
  | 'riegl_minivux3uav';

export type ScannerMeshFormat = 'ply' | 'obj';

// The subset of ScanParameters an instrument fixes. Placement (origin, tilt)
// and the zenith point count are never part of a preset. Resolution is normally
// the user's choice too, but a spinning sensor whose datasheet pins an angular
// step width per revolution may preset `azimuthPoints` (points/revolution) as a
// datasheet-faithful starting value — still freely editable afterward.
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
    | 'azimuthPoints'
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
    id: 'leica_blk360',
    label: 'Leica BLK360 (G1)',
    meshUrl: leicaBlk360Url,
    meshFormat: 'obj',
    heightMeters: 0.165,
    preset: {
      pattern: 'raster',
      returnType: 'single', // single-return WFD time-of-flight
      beamDivergenceMrad: 0.4, // 0.4 mrad FWHM, full angle (user manual)
      beamExitDiameterM: 0.00225, // 2.25 mm at front window, FWHM (user manual)
      // Vertical FOV 300°, horizontal 360°. The single vertical mirror sweeps
      // 300° of arc, so combined with the 360° head rotation it reaches from
      // straight up (zenith 0°) to 300/2 = 150° from vertical — 60° below
      // horizon — leaving a ~60° blind cone under the instrument (zenith
      // 150–180°).
      zenithMinDeg: 0,
      zenithMaxDeg: 150,
      azimuthMinDeg: 0,
      azimuthMaxDeg: 360,
      // Up to 360,000 points/s (datasheet measurement rate).
      pulseRateHz: 360000,
    },
  },
  {
    id: 'leica_blk360_g2',
    label: 'Leica BLK360 (G2)',
    // Reuses the G1 OBJ — the G2 is near-identical in silhouette. It is slightly
    // smaller (⌀ 80 mm × 155 mm vs the G1's ⌀ 100 × 165), reflected in the height.
    meshUrl: leicaBlk360Url,
    meshFormat: 'obj',
    heightMeters: 0.155,
    preset: {
      // Same laser front-end as the G1 (830 nm, Class 1): identical beam optics
      // and single-return. The G2 redesign is the detector/electronics, which
      // ~doubles the point rate.
      pattern: 'raster',
      returnType: 'single',
      beamDivergenceMrad: 0.4, // 0.4 mrad FWHM, full angle (same optics as G1)
      beamExitDiameterM: 0.00225, // 2.25 mm at front window, FWHM (same as G1)
      // Vertical FOV 270° (NOT the G1's 300°) → mirror reaches zenith 0–135°,
      // a 90° blind cone under the instrument. Horizontal 360°. (G2 spec sheet)
      zenithMinDeg: 0,
      zenithMaxDeg: 135,
      azimuthMinDeg: 0,
      azimuthMaxDeg: 360,
      // Up to 680,000 points/s — ~1.9× the G1 (G2 spec sheet).
      pulseRateHz: 680000,
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
      // Datasheet: "Single and Dual Returns (Strongest, Last)" — only single OR
      // strongest+last dual, never arbitrary multi-return. Helios has no
      // dual-return mode; its 'multi' is full-waveform (many returns/pulse),
      // which doesn't model the HDL-32E. Single return is the faithful default
      // and matches the single-return pulse rate below (~695 kHz).
      returnType: 'single',
      beamDivergenceMrad: 2.79,
      // The HDL-32E emits a rectangular spot ~1/2″ × 1/4″ at the source (12.7 ×
      // 6.35 mm), which is what yields the 2.79 mrad divergence. This field is a
      // single scalar (round-beam assumption), so use the wide axis — the
      // dimension the divergence figure is keyed to. (manual, p.26)
      beamExitDiameterM: 0.0127,
      beamElevationAnglesDeg: hdl32eElevations(),
      azimuthMinDeg: 0,
      azimuthMaxDeg: 360,
      // Azimuth resolution is 0.1°–0.4° (datasheet) over the 5–20 Hz spin range
      // (finer when slower); preset the typical 10 Hz setting ≈ 0.2° → 1,800
      // points/rev. Editable like every resolution field.
      azimuthPoints: 1800,
      // ~695 kHz: 32 channels firing at ~21.7 kHz each (datasheet, single return).
      pulseRateHz: 695000,
    },
  },
  {
    id: 'riegl_minivux3uav',
    label: 'RIEGL miniVUX-3UAV',
    meshUrl: rieglMiniVuxUrl,
    meshFormat: 'obj',
    // Body 85 mm tall (243 × 99 × 85 mm without the cooling fan).
    heightMeters: 0.085,
    preset: {
      // A single laser folded through a 45°-tilted rotating mirror whose spin
      // axis lies horizontal (mounted perpendicular to the flight line). That
      // geometry sweeps the beam through a *flat plane* — a 360° planar line
      // scan, NOT a tilted cone. (The conical 46°-FOV scan belongs to the
      // separate miniVUX-1DL, a different instrument.) So in the multibeam
      // convention this is the one-channel case: a single beam at 0° elevation
      // sweeping the plane normal to the spin axis, the spin being the azimuth.
      pattern: 'spinning_multibeam',
      beamElevationAnglesDeg: [0],
      // Waveform LiDAR with up to 5 target echoes per pulse (datasheet).
      returnType: 'multi',
      beamDivergenceMrad: 1.6, // 1.6 × 0.5 mrad → wide axis (footprint 160 × 50 mm @ 100 m)
      // Datasheet gives a footprint at range, not an exit aperture, so leave the
      // beam diameter at the form default rather than invent a figure.
      // 100 kHz PRR mode → full 360° FOV (180° @ 200 kHz, 120° @ 300 kHz).
      azimuthMinDeg: 0,
      azimuthMaxDeg: 360,
      // Angular step width Δφ is 0.018°–0.36° selectable (datasheet) → 1,000–
      // 20,000 points/revolution. Preset the ~0.1° mid-setting (3,600 pts/rev)
      // as a datasheet-faithful default; editable like every resolution field.
      azimuthPoints: 3600,
      // Selectable PRR; the 100 kHz mode is the one that yields the 360° FOV.
      pulseRateHz: 100000,
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
