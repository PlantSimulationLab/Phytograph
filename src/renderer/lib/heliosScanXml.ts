// Parser for Helios-style scan XML files. Used by the "Import from XML"
// option in the Add Scan popup to bulk-create Scans.
//
// Format: zero or more <scan> elements, each with at minimum <origin> and
// <size>. Theta/phi bounds are in degrees, per the Helios documentation —
// no radian fallback. Internally we model angular sweeps in degrees too,
// so values pass through unchanged.
//
// A scan may also be a spinning-multibeam scan, flagged by
// <scanPattern>spinning_multibeam</scanPattern>. Those carry
// <beamElevationAngles> (space-separated per-channel elevation degrees above
// the horizon, required) and an azimuth count via <Nphi> (or size[1], or
// <azimuthStep> in degrees/step from PyHelios v0.1.24 exports) instead of a
// zenith grid.
//
// We extract the optional <filename> (relative path to the recorded point
// data) and <ASCII_format> (column layout descriptor) so the caller can
// auto-attach the referenced point cloud and forward the format hint to the
// backend.
//
// We also parse top-level <grid> blocks (siblings of <scan>, per the Helios
// LiDAR XML format) into HeliosXmlGrid descriptors so the caller can
// auto-create matching voxel-grid meshes. <translation> / per-scan <rotation>
// are still ignored.

import { DEFAULT_SCAN_PARAMETERS, type ScanParameters } from './scanParameters';
import { SCANNER_MODELS, type ScannerModelId } from './scannerModels';

// Valid scanner-model ids, for validating an imported <scannerModel> tag. An
// unknown value degrades to undefined (→ generic) rather than rendering nothing.
const SCANNER_MODEL_IDS = new Set<string>(SCANNER_MODELS.map(m => m.id));

// Recognised spellings of the spinning-multibeam <scanPattern> value, matching
// helios-core's case-insensitive acceptance (spinning_multibeam /
// spinning-multibeam / spinningmultibeam). We normalise to alpha-only and
// compare against this single canonical form.
const MULTIBEAM_PATTERN_NORM = 'spinningmultibeam';

// Helios defaults from the spec — applied in degrees when a tag is missing.
const DEFAULT_THETA_MIN_DEG = 0;
const DEFAULT_THETA_MAX_DEG = 180;
const DEFAULT_PHI_MIN_DEG = 0;
const DEFAULT_PHI_MAX_DEG = 360;

export interface HeliosXmlScan {
  params: ScanParameters;
  label: string;
  // Optional point-data file referenced by the scan. Trimmed; may be relative
  // to the XML's directory, or absolute. `null` if the tag is absent.
  filename: string | null;
  // Optional column layout string from <ASCII_format>. Forwarded to the
  // backend when present so it knows how to parse the referenced file.
  asciiFormat: string | null;
}

// A top-level <grid> block. Maps onto a voxel-box mesh: center → mesh
// position, size → mesh scale (full extents; the base geometry is a unit
// cube), subdivisions → gridSubdivisions, rotationDeg → mesh z-rotation
// (degrees, about the z-axis, per the Helios convention).
export interface HeliosXmlGrid {
  center: { x: number; y: number; z: number };
  size: { x: number; y: number; z: number };
  subdivisions: { x: number; y: number; z: number }; // Nx, Ny, Nz (>= 1)
  rotationDeg: number; // about z; 0 when absent
  label: string;       // "Grid N"
  // Terrain-following ("snapped") grid: per-(x,y)-column world-z offsets, row-major
  // [j*nx+i], length nx*ny — parsed from <columnOffsets>. Present only for a snapped
  // grid; the caller reattaches them as the mesh's gridGroundSnap. keptMask (from
  // <keptColumns>, same length, 0 = dropped outside the DEM footprint) defaults to
  // all-1 when offsets are present but the mask tag is absent.
  columnOffsets?: Float32Array;
  keptMask?: Uint8Array;
}

export interface HeliosXmlParseResult {
  scans: HeliosXmlScan[];
  grids: HeliosXmlGrid[];
}

export class HeliosXmlParseError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'HeliosXmlParseError';
  }
}

// Parse the textual XML content. Throws HeliosXmlParseError with a
// human-readable message if the document is malformed or has no usable scans.
export function parseHeliosScanXml(xmlText: string): HeliosXmlParseResult {
  // The fixture format is a fragment (multiple top-level <scan> siblings),
  // which DOMParser only accepts if wrapped in a single root. Wrap defensively
  // — wrapping an already-rooted document is harmless because we query <scan>
  // by tag name regardless of nesting. Strip a leading <?xml ?> prolog and
  // any comments first; XML declarations are only legal at offset 0 of a
  // document, so they'd error if we wrapped around them.
  const stripped = xmlText
    .replace(/^﻿/, '')
    .replace(/<\?xml[\s\S]*?\?>/g, '')
    .trim();
  const wrapped = `<helios-root>${stripped}</helios-root>`;
  const doc = new DOMParser().parseFromString(wrapped, 'application/xml');

  const parseError = doc.getElementsByTagName('parsererror')[0];
  if (parseError) {
    throw new HeliosXmlParseError(`XML parse error: ${parseError.textContent ?? 'invalid XML'}`);
  }

  const scanEls = Array.from(doc.getElementsByTagName('scan'));
  const gridEls = Array.from(doc.getElementsByTagName('grid'));
  // Grids can stand alone — a grid-only XML still imports. Only a document with
  // neither scans nor grids is an error.
  if (scanEls.length === 0 && gridEls.length === 0) {
    throw new HeliosXmlParseError('No <scan> or <grid> elements found in XML.');
  }

  const scans: HeliosXmlScan[] = scanEls.map((el, idx) => parseScanElement(el, idx));
  const grids: HeliosXmlGrid[] = gridEls.map((el, idx) => parseGridElement(el, idx));
  return { scans, grids };
}

function parseGridElement(el: Element, index: number): HeliosXmlGrid {
  const center = parseVec3Tag(el, 'center');
  if (!center) {
    throw new HeliosXmlParseError(`<grid> at index ${index} is missing required <center>.`);
  }
  const size = parseVec3Tag(el, 'size');
  if (!size) {
    throw new HeliosXmlParseError(`<grid> at index ${index} is missing required <size>.`);
  }
  if (size.some(v => !(v > 0))) {
    throw new HeliosXmlParseError(
      `<grid> at index ${index} has a non-positive <size> component (${size.join(' ')}).`,
    );
  }

  // Nx/Ny/Nz default to 1 (single cell); rotation defaults to 0 degrees.
  const nx = Math.max(1, Math.round(parseNumberTag(el, 'Nx') ?? 1));
  const ny = Math.max(1, Math.round(parseNumberTag(el, 'Ny') ?? 1));
  const nz = Math.max(1, Math.round(parseNumberTag(el, 'Nz') ?? 1));
  const rotationDeg = parseNumberTag(el, 'rotation') ?? 0;

  const grid: HeliosXmlGrid = {
    center: { x: center[0], y: center[1], z: center[2] },
    size: { x: size[0], y: size[1], z: size[2] },
    subdivisions: { x: nx, y: ny, z: nz },
    rotationDeg,
    label: `Grid ${index + 1}`,
  };

  // Terrain-following offsets (Phytograph extension; Helios ignores these tags).
  // Only accept them when the list length matches the column count nx*ny — the
  // invariant the whole snap pipeline relies on. A wrong-length or absent list
  // simply leaves the grid flat. keptColumns is optional; when offsets are present
  // without it, every column is kept.
  const ncols = nx * ny;
  const offsets = parseFloatListTag(el, 'columnOffsets');
  if (offsets && offsets.length === ncols) {
    grid.columnOffsets = Float32Array.from(offsets);
    const kept = parseFloatListTag(el, 'keptColumns');
    grid.keptMask =
      kept && kept.length === ncols
        ? Uint8Array.from(kept, v => (v !== 0 ? 1 : 0))
        : new Uint8Array(ncols).fill(1);
  }

  return grid;
}

function parseScanElement(el: Element, index: number): HeliosXmlScan {
  const origin = parseVec3Tag(el, 'origin');
  if (!origin) {
    throw new HeliosXmlParseError(`<scan> at index ${index} is missing required <origin>.`);
  }

  // Scan pattern: 'spinning_multibeam' (any helios spelling) vs the default
  // 'raster'. Normalise to alpha-only for the case-insensitive compare.
  const patternRaw = tagText(el, 'scanPattern');
  const isMultibeam =
    patternRaw !== null &&
    patternRaw.toLowerCase().replace(/[^a-z]/g, '') === MULTIBEAM_PATTERN_NORM;

  // <size> is "n_theta n_phi". Required for raster; for multibeam Ntheta comes
  // from the per-channel angle list so <size> may be absent — Nphi then comes
  // from <Nphi> or, as a fallback, size[1].
  const size = parseIntPairTag(el, 'size');

  // Beam elevation angles (degrees above horizon) — required for multibeam.
  const beamElevationAnglesDeg = isMultibeam
    ? parseFloatListTag(el, 'beamElevationAngles')
    : null;
  if (isMultibeam && (!beamElevationAnglesDeg || beamElevationAnglesDeg.length === 0)) {
    throw new HeliosXmlParseError(
      `<scan> at index ${index} is a spinning_multibeam scan but is missing required <beamElevationAngles>.`,
    );
  }

  // Azimuth sample count (Nphi). Multibeam may carry an explicit <Nphi>; both
  // patterns fall back to size[1]. PyHelios v0.1.24 (helios-core 1.3.76) exports a
  // spinning scan with <azimuthStep> (degrees per firing step) instead of <Nphi>,
  // deriving the per-revolution count internally; recover Nphi = round(360/step)
  // so a Phytograph-exported spinning bundle still re-imports.
  const nPhiTag = parseNumberTag(el, 'Nphi');
  const azimuthStepDeg = parseNumberTag(el, 'azimuthStep');
  const azimuthPoints =
    nPhiTag !== null
      ? nPhiTag
      : size
        ? size[1]
        : azimuthStepDeg !== null && azimuthStepDeg > 0
          ? Math.round(360 / azimuthStepDeg)
          : null;

  if (isMultibeam) {
    if (azimuthPoints === null) {
      throw new HeliosXmlParseError(
        `<scan> at index ${index} is a spinning_multibeam scan but is missing the azimuth count (<Nphi>, <size>, or <azimuthStep>).`,
      );
    }
  } else if (!size) {
    throw new HeliosXmlParseError(`<scan> at index ${index} is missing required <size>.`);
  }

  // Helios <size> is "n_theta n_phi" — number of samples along zenith and
  // azimuth respectively. For raster, zenith count is size[0]; for multibeam
  // it's irrelevant (Ntheta = number of channels) and stays at the default.
  const zenithPoints = size ? size[0] : DEFAULT_SCAN_PARAMETERS.zenithPoints;

  // Theta/phi min/max map directly onto our zenith/azimuth sweep boundaries —
  // stored verbatim so asymmetric sweeps survive a round-trip.
  const thetaMinDeg = parseNumberTag(el, 'thetaMin') ?? DEFAULT_THETA_MIN_DEG;
  const thetaMaxDeg = parseNumberTag(el, 'thetaMax') ?? DEFAULT_THETA_MAX_DEG;
  const phiMinDeg = parseNumberTag(el, 'phiMin') ?? DEFAULT_PHI_MIN_DEG;
  const phiMaxDeg = parseNumberTag(el, 'phiMax') ?? DEFAULT_PHI_MAX_DEG;

  // <exitDiameter> / <beamDivergence> present → treat as multi-return.
  // beamDivergence in the Helios spec is radians; pyhelios/our UI use mrad.
  const exitDiameterM = parseNumberTag(el, 'exitDiameter');
  const beamDivergenceRad = parseNumberTag(el, 'beamDivergence');
  const isMulti = exitDiameterM !== null || beamDivergenceRad !== null;

  // <scanTilt> is "roll pitch" in degrees (helios-core lidar fileIO.cpp converts
  // to radians on load). Maps directly onto our degree-based tilt fields. Absent
  // tag → level (0/0).
  const tilt = parseFloatPairTag(el, 'scanTilt');

  // <scanAzimuthOffset> is the initial scanner heading in degrees (a single
  // float). Maps directly onto our degree-based azimuthOffsetDeg. Absent tag →
  // default heading (0), so XML written before this field existed still loads.
  const azimuthOffsetDeg = parseNumberTag(el, 'scanAzimuthOffset');

  // <scannerModel> is the instrument id (e.g. 'riegl_vz400i'). Validate against the
  // catalog so a junk / unknown value degrades to undefined (→ the generic marker)
  // rather than rendering nothing. Absent tag → undefined → generic (the default).
  const scannerModelRaw = tagText(el, 'scannerModel');
  const scannerModel =
    scannerModelRaw && SCANNER_MODEL_IDS.has(scannerModelRaw)
      ? (scannerModelRaw as ScannerModelId)
      : undefined;

  const filenameRaw = tagText(el, 'filename');
  const asciiFormatRaw = tagText(el, 'ASCII_format');

  const params: ScanParameters = {
    origin: { x: origin[0], y: origin[1], z: origin[2] },
    // Instrument identity. undefined when absent/unknown so the consumer's default
    // ('generic') applies; a valid id flows straight through to the scanner marker.
    scannerModel,
    pattern: isMultibeam ? 'spinning_multibeam' : 'raster',
    zenithPoints: Math.max(1, zenithPoints),
    // azimuthPoints is guaranteed non-null here (raster requires <size>;
    // multibeam requires <Nphi> or <size>).
    azimuthPoints: Math.max(1, azimuthPoints!),
    zenithMinDeg: thetaMinDeg,
    zenithMaxDeg: thetaMaxDeg,
    azimuthMinDeg: phiMinDeg,
    azimuthMaxDeg: phiMaxDeg,
    // The presence of beam optics is our proxy for a multi-return scan (the same
    // heuristic as before); everything else imports as single-return.
    returnMode: isMulti ? 'multi' : 'single',
    maxReturns: DEFAULT_SCAN_PARAMETERS.maxReturns,
    returnSelection: DEFAULT_SCAN_PARAMETERS.returnSelection,
    beamExitDiameterM: exitDiameterM ?? DEFAULT_SCAN_PARAMETERS.beamExitDiameterM,
    beamDivergenceMrad: beamDivergenceRad !== null
      ? beamDivergenceRad * 1000
      : DEFAULT_SCAN_PARAMETERS.beamDivergenceMrad,
    tiltRollDeg: tilt ? tilt[0] : DEFAULT_SCAN_PARAMETERS.tiltRollDeg,
    tiltPitchDeg: tilt ? tilt[1] : DEFAULT_SCAN_PARAMETERS.tiltPitchDeg,
    azimuthOffsetDeg: azimuthOffsetDeg ?? DEFAULT_SCAN_PARAMETERS.azimuthOffsetDeg,
    beamElevationAnglesDeg: beamElevationAnglesDeg ?? DEFAULT_SCAN_PARAMETERS.beamElevationAnglesDeg,
  };

  return {
    params,
    label: `Scan ${index + 1}`,
    filename: filenameRaw && filenameRaw.length > 0 ? filenameRaw : null,
    asciiFormat: asciiFormatRaw && asciiFormatRaw.length > 0 ? asciiFormatRaw : null,
  };
}

function tagText(parent: Element, tag: string): string | null {
  // Direct children only — avoids picking up nested values from a different
  // section if the document is wrapped or contains unexpected nesting.
  // Compare case-insensitively because some XML DOM implementations
  // (e.g. happy-dom) uppercase tagName even in XML mode.
  const target = tag.toLowerCase();
  for (const child of Array.from(parent.children)) {
    if (child.tagName.toLowerCase() === target) return (child.textContent ?? '').trim();
  }
  return null;
}

function parseNumberTag(parent: Element, tag: string): number | null {
  const text = tagText(parent, tag);
  if (text === null || text === '') return null;
  const n = Number(text);
  return Number.isFinite(n) ? n : null;
}

// Parse a whitespace-separated list of floats (e.g. <beamElevationAngles>).
// Returns null if the tag is absent or yields no finite values.
function parseFloatListTag(parent: Element, tag: string): number[] | null {
  const text = tagText(parent, tag);
  if (text === null) return null;
  const parts = text.split(/\s+/).filter(Boolean).map(Number).filter(Number.isFinite);
  return parts.length > 0 ? parts : null;
}

function parseVec3Tag(parent: Element, tag: string): [number, number, number] | null {
  const text = tagText(parent, tag);
  if (text === null) return null;
  const parts = text.split(/\s+/).filter(Boolean).map(Number);
  if (parts.length < 3 || parts.some(n => !Number.isFinite(n))) return null;
  return [parts[0], parts[1], parts[2]];
}

function parseIntPairTag(parent: Element, tag: string): [number, number] | null {
  const text = tagText(parent, tag);
  if (text === null) return null;
  const parts = text.split(/\s+/).filter(Boolean).map(s => parseInt(s, 10));
  if (parts.length < 2 || parts.some(n => !Number.isFinite(n))) return null;
  return [parts[0], parts[1]];
}

function parseFloatPairTag(parent: Element, tag: string): [number, number] | null {
  const text = tagText(parent, tag);
  if (text === null) return null;
  const parts = text.split(/\s+/).filter(Boolean).map(Number);
  if (parts.length < 2 || parts.some(n => !Number.isFinite(n))) return null;
  return [parts[0], parts[1]];
}
