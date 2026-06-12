// Parser for Helios-style scan XML files. Used by the "Import from XML"
// option in the Add Scan popup to bulk-create Scans.
//
// Format: zero or more <scan> elements, each with at minimum <origin> and
// <size>. Theta/phi bounds are in degrees, per the Helios documentation —
// no radian fallback. Internally we model angular sweeps in degrees too,
// so values pass through unchanged.
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

  return {
    center: { x: center[0], y: center[1], z: center[2] },
    size: { x: size[0], y: size[1], z: size[2] },
    subdivisions: { x: nx, y: ny, z: nz },
    rotationDeg,
    label: `Grid ${index + 1}`,
  };
}

function parseScanElement(el: Element, index: number): HeliosXmlScan {
  const origin = parseVec3Tag(el, 'origin');
  if (!origin) {
    throw new HeliosXmlParseError(`<scan> at index ${index} is missing required <origin>.`);
  }

  const size = parseIntPairTag(el, 'size');
  if (!size) {
    throw new HeliosXmlParseError(`<scan> at index ${index} is missing required <size>.`);
  }
  // Helios <size> is "n_theta n_phi" — number of samples along zenith and
  // azimuth respectively. Maps directly onto our zenith/azimuth point counts.
  const [zenithPoints, azimuthPoints] = size;

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

  const filenameRaw = tagText(el, 'filename');
  const asciiFormatRaw = tagText(el, 'ASCII_format');

  const params: ScanParameters = {
    origin: { x: origin[0], y: origin[1], z: origin[2] },
    zenithPoints: Math.max(1, zenithPoints),
    azimuthPoints: Math.max(1, azimuthPoints),
    zenithMinDeg: thetaMinDeg,
    zenithMaxDeg: thetaMaxDeg,
    azimuthMinDeg: phiMinDeg,
    azimuthMaxDeg: phiMaxDeg,
    returnType: isMulti ? 'multi' : 'single',
    beamExitDiameterM: exitDiameterM ?? DEFAULT_SCAN_PARAMETERS.beamExitDiameterM,
    beamDivergenceMrad: beamDivergenceRad !== null
      ? beamDivergenceRad * 1000
      : DEFAULT_SCAN_PARAMETERS.beamDivergenceMrad,
    tiltRollDeg: tilt ? tilt[0] : DEFAULT_SCAN_PARAMETERS.tiltRollDeg,
    tiltPitchDeg: tilt ? tilt[1] : DEFAULT_SCAN_PARAMETERS.tiltPitchDeg,
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
