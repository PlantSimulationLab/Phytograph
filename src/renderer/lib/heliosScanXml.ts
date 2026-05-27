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
// backend. <translation> / <rotation> / the surrounding <grid> are still
// ignored.

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

export interface HeliosXmlParseResult {
  scans: HeliosXmlScan[];
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
  if (scanEls.length === 0) {
    throw new HeliosXmlParseError('No <scan> elements found in XML.');
  }

  const scans: HeliosXmlScan[] = scanEls.map((el, idx) => parseScanElement(el, idx));
  return { scans };
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

  const thetaMinDeg = parseNumberTag(el, 'thetaMin') ?? DEFAULT_THETA_MIN_DEG;
  const thetaMaxDeg = parseNumberTag(el, 'thetaMax') ?? DEFAULT_THETA_MAX_DEG;
  const phiMinDeg = parseNumberTag(el, 'phiMin') ?? DEFAULT_PHI_MIN_DEG;
  const phiMaxDeg = parseNumberTag(el, 'phiMax') ?? DEFAULT_PHI_MAX_DEG;

  // Clamp negative spans (from min > max) to zero rather than throwing —
  // Helios itself tolerates this and we'd rather import than refuse.
  const zenithRangeDeg = Math.max(0, thetaMaxDeg - thetaMinDeg);
  const azimuthRangeDeg = Math.max(0, phiMaxDeg - phiMinDeg);

  // <exitDiameter> / <beamDivergence> present → treat as multi-return.
  // beamDivergence in the Helios spec is radians; pyhelios/our UI use mrad.
  const exitDiameterM = parseNumberTag(el, 'exitDiameter');
  const beamDivergenceRad = parseNumberTag(el, 'beamDivergence');
  const isMulti = exitDiameterM !== null || beamDivergenceRad !== null;

  const filenameRaw = tagText(el, 'filename');
  const asciiFormatRaw = tagText(el, 'ASCII_format');

  const params: ScanParameters = {
    origin: { x: origin[0], y: origin[1], z: origin[2] },
    zenithPoints: Math.max(1, zenithPoints),
    azimuthPoints: Math.max(1, azimuthPoints),
    zenithRangeDeg,
    azimuthRangeDeg,
    returnType: isMulti ? 'multi' : 'single',
    beamExitDiameterM: exitDiameterM ?? DEFAULT_SCAN_PARAMETERS.beamExitDiameterM,
    beamDivergenceMrad: beamDivergenceRad !== null
      ? beamDivergenceRad * 1000
      : DEFAULT_SCAN_PARAMETERS.beamDivergenceMrad,
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
