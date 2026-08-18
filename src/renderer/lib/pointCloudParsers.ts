import * as THREE from 'three';
import type { PointCloudData, ScalarField } from './pointCloudTypes';
import type { ClassPalette } from './classPalettes';
import { OCTREE_GPS_TIME_ATTRIBUTE, TIMESTAMP_SLUG } from './pointCloudHelpers';
import {
  importPointCloudByPath,
  importPointCloudLasLaz,
  createCloudSession,
  createCloudSessions,
  type OctreeMetadata,
  type ColumnPlan,
  type ScanParamsFromFile,
  type ImportProgressOptions,
} from '../utils/backendApi';

export type { ImportProgressOptions };

// Calculate bounds from position array
function calculateBounds(positions: Float32Array, pointCount: number): PointCloudData['bounds'] {
  const min = new THREE.Vector3(Infinity, Infinity, Infinity);
  const max = new THREE.Vector3(-Infinity, -Infinity, -Infinity);

  for (let i = 0; i < pointCount; i++) {
    const x = positions[i * 3];
    const y = positions[i * 3 + 1];
    const z = positions[i * 3 + 2];
    min.x = Math.min(min.x, x);
    min.y = Math.min(min.y, y);
    min.z = Math.min(min.z, z);
    max.x = Math.max(max.x, x);
    max.y = Math.max(max.y, y);
    max.z = Math.max(max.z, z);
  }

  const center = new THREE.Vector3().addVectors(min, max).multiplyScalar(0.5);
  const size = new THREE.Vector3().subVectors(max, min);

  return { min, max, center, size };
}

// Helper to detect if a string looks like a header column name
function isHeaderValue(value: string): boolean {
  const trimmed = value.trim();
  // Check if it contains letters (likely a header)
  if (/[a-zA-Z]/.test(trimmed)) return true;
  // Check if it contains brackets (like XYZ[0][m])
  if (/[\[\]]/.test(trimmed)) return true;
  return false;
}

// Helper to find column index by patterns
function findColumnIndex(headers: string[], patterns: RegExp[]): number {
  for (const pattern of patterns) {
    const idx = headers.findIndex(h => pattern.test(h.toLowerCase()));
    if (idx !== -1) return idx;
  }
  return -1;
}

// Parse XYZ/CSV/TXT format (simple space/comma/tab delimited)
export async function parseXYZ(file: File): Promise<PointCloudData> {
  const text = await file.text();
  const lines = text.trim().split('\n');

  // Filter out comment lines
  const dataLines = lines.filter(l => {
    const trimmed = l.trim();
    return trimmed && !trimmed.startsWith('#') && !trimmed.startsWith('//');
  });

  if (dataLines.length === 0) throw new Error('No data found in file');

  // Detect delimiter for the first line (which may or may not be a header).
  // Some exporters use a comma-delimited header above space-delimited data
  // (e.g. RIEGL exports: "XYZ[0][m],XYZ[1][m],..." then "2.79 -21.54 ..."),
  // so we have to detect the data delimiter independently from the header.
  function detectDelimiter(line: string): string | RegExp {
    if (line.includes(',')) return ',';
    if (line.includes('\t')) return '\t';
    if (line.includes(';')) return ';';
    return /\s+/;
  }

  const firstLine = dataLines[0];
  const headerDelimiter = detectDelimiter(firstLine);

  // Split first line using its own delimiter to check for header tokens
  const firstParts = firstLine.split(headerDelimiter).map(s => s.trim());

  // Detect if first line is a header row
  const hasHeader = firstParts.some(isHeaderValue);

  // For data rows, detect delimiter from the first actual data row
  // (which may differ from the header's delimiter).
  const delimiter: string | RegExp = hasHeader && dataLines.length > 1
    ? detectDelimiter(dataLines[1])
    : headerDelimiter;

  // Determine column indices
  let xIdx = 0, yIdx = 1, zIdx = 2;
  let rIdx = -1, gIdx = -1, bIdx = -1;
  let intensityIdx = -1;
  let startLine = 0;

  // Track scalar field columns: { headerName: columnIndex }
  const scalarFieldColumns: { name: string; index: number }[] = [];

  if (hasHeader) {
    startLine = 1; // Skip header row
    const headers = firstParts;

    // Find X column (matches: x, xyz[0], X, easting, etc.)
    const xPatterns = [/^x$/, /xyz\[0\]/, /^easting/, /^lon/, /^_x$/];
    const foundX = findColumnIndex(headers, xPatterns);
    if (foundX !== -1) xIdx = foundX;

    // Find Y column
    const yPatterns = [/^y$/, /xyz\[1\]/, /^northing/, /^lat/, /^_y$/];
    const foundY = findColumnIndex(headers, yPatterns);
    if (foundY !== -1) yIdx = foundY;

    // Find Z column
    const zPatterns = [/^z$/, /xyz\[2\]/, /^elevation/, /^altitude/, /^height/, /^_z$/];
    const foundZ = findColumnIndex(headers, zPatterns);
    if (foundZ !== -1) zIdx = foundZ;

    // Find RGB columns
    const rPatterns = [/^r$/, /^red/];
    const gPatterns = [/^g$/, /^green/];
    const bPatterns = [/^b$/, /^blue/];
    rIdx = findColumnIndex(headers, rPatterns);
    gIdx = findColumnIndex(headers, gPatterns);
    bIdx = findColumnIndex(headers, bPatterns);

    // Find intensity/reflectance column
    const intensityPatterns = [/intensity/, /reflectance/, /^i$/, /return_intensity/];
    intensityIdx = findColumnIndex(headers, intensityPatterns);

    // Identify scalar field columns (all numeric columns not used for x, y, z, r, g, b, intensity)
    const usedIndices = new Set([xIdx, yIdx, zIdx]);
    if (rIdx !== -1) usedIndices.add(rIdx);
    if (gIdx !== -1) usedIndices.add(gIdx);
    if (bIdx !== -1) usedIndices.add(bIdx);
    if (intensityIdx !== -1) usedIndices.add(intensityIdx);

    for (let colIdx = 0; colIdx < headers.length; colIdx++) {
      if (usedIndices.has(colIdx)) continue;
      const headerName = headers[colIdx].trim();
      if (headerName) {
        scalarFieldColumns.push({ name: headerName, index: colIdx });
      }
    }
  }

  const points: number[][] = [];
  const colors: number[][] = [];
  const intensities: number[] = [];
  // Collect scalar field values: { name: number[] }
  const scalarFieldValues: Record<string, number[]> = {};
  for (const sf of scalarFieldColumns) {
    scalarFieldValues[sf.name] = [];
  }

  for (let i = startLine; i < dataLines.length; i++) {
    const line = dataLines[i];
    const trimmed = line.trim();
    if (!trimmed) continue;

    const parts = typeof delimiter === 'string'
      ? trimmed.split(delimiter).map(s => s.trim())
      : trimmed.split(delimiter).map(s => s.trim());

    if (parts.length < 3) continue;

    const x = parseFloat(parts[xIdx]);
    const y = parseFloat(parts[yIdx]);
    const z = parseFloat(parts[zIdx]);

    if (isNaN(x) || isNaN(y) || isNaN(z)) continue;

    points.push([x, y, z]);

    // Handle RGB if columns were found in header
    if (rIdx !== -1 && gIdx !== -1 && bIdx !== -1) {
      const r = parseFloat(parts[rIdx]);
      const g = parseFloat(parts[gIdx]);
      const b = parseFloat(parts[bIdx]);
      if (!isNaN(r) && !isNaN(g) && !isNaN(b)) {
        const scale = r > 1 || g > 1 || b > 1 ? 1 / 255 : 1;
        colors.push([r * scale, g * scale, b * scale]);
      }
    }
    // Fallback: check for RGB in columns 4-6 (no header case)
    else if (!hasHeader && parts.length >= 6) {
      const r = parseFloat(parts[3]);
      const g = parseFloat(parts[4]);
      const b = parseFloat(parts[5]);
      if (!isNaN(r) && !isNaN(g) && !isNaN(b)) {
        const scale = r > 1 || g > 1 || b > 1 ? 1 / 255 : 1;
        colors.push([r * scale, g * scale, b * scale]);
      }
    }

    // Handle intensity if column was found in header
    if (intensityIdx !== -1) {
      const intensity = parseFloat(parts[intensityIdx]);
      if (!isNaN(intensity)) {
        intensities.push(intensity);
      }
    }
    // Fallback: check for intensity in column 4 (no header case)
    else if (!hasHeader && parts.length >= 4 && colors.length !== points.length) {
      const intensity = parseFloat(parts[3]);
      if (!isNaN(intensity)) {
        intensities.push(intensity > 1 ? intensity / 255 : intensity);
      }
    }

    // Collect scalar field values
    for (const sf of scalarFieldColumns) {
      if (sf.index < parts.length) {
        const val = parseFloat(parts[sf.index]);
        scalarFieldValues[sf.name].push(isNaN(val) ? 0 : val);
      } else {
        scalarFieldValues[sf.name].push(0);
      }
    }
  }

  const pointCount = points.length;
  if (pointCount === 0) {
    // Lines were present but none yielded a valid X Y Z triplet. Failing here
    // prevents a silent "0 points / NaN center" import (e.g. an XML or other
    // non-coordinate text file slipping through the parser).
    throw new Error(
      `No point coordinates found in "${file.name}". ` +
      `Expected lines of numeric X Y Z values — check that this is a point ` +
      `cloud file and not a header-only or metadata file.`,
    );
  }
  const positions = new Float32Array(pointCount * 3);

  for (let i = 0; i < pointCount; i++) {
    positions[i * 3] = points[i][0];
    positions[i * 3 + 1] = points[i][1];
    positions[i * 3 + 2] = points[i][2];
  }

  const result: PointCloudData = {
    positions,
    pointCount,
    bounds: calculateBounds(positions, pointCount),
    fileName: file.name,
  };

  if (colors.length === pointCount) {
    const colorArray = new Float32Array(pointCount * 3);
    for (let i = 0; i < pointCount; i++) {
      colorArray[i * 3] = colors[i][0];
      colorArray[i * 3 + 1] = colors[i][1];
      colorArray[i * 3 + 2] = colors[i][2];
    }
    result.colors = colorArray;
  }

  if (intensities.length === pointCount) {
    // Normalize intensities to 0-1 range
    let minIntensity = Infinity;
    let maxIntensity = -Infinity;
    for (const val of intensities) {
      minIntensity = Math.min(minIntensity, val);
      maxIntensity = Math.max(maxIntensity, val);
    }

    const intensityRange = maxIntensity - minIntensity || 1;
    const normalizedIntensities = new Float32Array(pointCount);
    for (let i = 0; i < pointCount; i++) {
      normalizedIntensities[i] = (intensities[i] - minIntensity) / intensityRange;
    }
    result.intensities = normalizedIntensities;
  }

  // Build scalar fields from collected values
  const scalarFields: Record<string, ScalarField> = {};
  for (const sf of scalarFieldColumns) {
    const values = scalarFieldValues[sf.name];
    if (values.length === pointCount) {
      let min = Infinity;
      let max = -Infinity;
      for (const v of values) {
        if (v < min) min = v;
        if (v > max) max = v;
      }
      // Only include if there's actual variance in the data
      if (min !== max || !isFinite(min)) {
        scalarFields[sf.name] = {
          values: new Float32Array(values),
          min: isFinite(min) ? min : 0,
          max: isFinite(max) ? max : 1,
        };
      }
    }
  }

  if (Object.keys(scalarFields).length > 0) {
    result.scalarFields = scalarFields;
  }

  return result;
}

// Parse PLY (Stanford Polygon) format
export async function parsePLY(file: File): Promise<PointCloudData> {
  const buffer = await file.arrayBuffer();
  const text = new TextDecoder().decode(buffer);

  // Find header end
  const headerEnd = text.indexOf('end_header');
  if (headerEnd === -1) throw new Error('Invalid PLY file: no end_header found');

  const header = text.substring(0, headerEnd);
  const lines = header.split('\n');

  let pointCount = 0;
  let format = 'ascii';
  const properties: { name: string; type: string }[] = [];

  for (const line of lines) {
    const parts = line.trim().split(/\s+/);
    if (parts[0] === 'format') {
      format = parts[1];
    } else if (parts[0] === 'element' && parts[1] === 'vertex') {
      pointCount = parseInt(parts[2]);
    } else if (parts[0] === 'property') {
      properties.push({ type: parts[1], name: parts[2] });
    }
  }

  if (pointCount === 0) throw new Error('No vertices found in PLY file');

  // Find property indices
  const xIdx = properties.findIndex(p => p.name === 'x');
  const yIdx = properties.findIndex(p => p.name === 'y');
  const zIdx = properties.findIndex(p => p.name === 'z');
  const rIdx = properties.findIndex(p => p.name === 'red' || p.name === 'r');
  const gIdx = properties.findIndex(p => p.name === 'green' || p.name === 'g');
  const bIdx = properties.findIndex(p => p.name === 'blue' || p.name === 'b');
  const intensityIdx = properties.findIndex(p => p.name === 'intensity' || p.name === 'scalar_intensity');

  if (xIdx === -1 || yIdx === -1 || zIdx === -1) {
    throw new Error('PLY file must have x, y, z properties');
  }

  const positions = new Float32Array(pointCount * 3);
  let colors: Float32Array | undefined;
  let intensities: Float32Array | undefined;

  if (rIdx !== -1 && gIdx !== -1 && bIdx !== -1) {
    colors = new Float32Array(pointCount * 3);
  }
  if (intensityIdx !== -1) {
    intensities = new Float32Array(pointCount);
  }

  if (format === 'ascii') {
    // Parse ASCII PLY
    const dataStart = headerEnd + 'end_header'.length + 1;
    const dataLines = text.substring(dataStart).trim().split('\n');

    for (let i = 0; i < Math.min(pointCount, dataLines.length); i++) {
      const values = dataLines[i].trim().split(/\s+/).map(parseFloat);

      positions[i * 3] = values[xIdx];
      positions[i * 3 + 1] = values[yIdx];
      positions[i * 3 + 2] = values[zIdx];

      if (colors && rIdx !== -1) {
        const r = values[rIdx];
        const g = values[gIdx];
        const b = values[bIdx];
        const scale = r > 1 || g > 1 || b > 1 ? 1 / 255 : 1;
        colors[i * 3] = r * scale;
        colors[i * 3 + 1] = g * scale;
        colors[i * 3 + 2] = b * scale;
      }

      if (intensities && intensityIdx !== -1) {
        const val = values[intensityIdx];
        intensities[i] = val > 1 ? val / 255 : val;
      }
    }
  } else {
    // Binary PLY - for now throw error, can implement later
    throw new Error('Binary PLY format not yet supported. Please convert to ASCII PLY.');
  }

  const result: PointCloudData = {
    positions,
    pointCount,
    bounds: calculateBounds(positions, pointCount),
    fileName: file.name,
  };

  if (colors) result.colors = colors;
  if (intensities) result.intensities = intensities;

  return result;
}

// Parse PCD (Point Cloud Data) format
export async function parsePCD(file: File): Promise<PointCloudData> {
  const text = await file.text();
  const lines = text.split('\n');

  let pointCount = 0;
  let dataFormat = 'ascii';
  const fields: string[] = [];
  let headerEndLine = 0;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim();
    if (line.startsWith('FIELDS')) {
      fields.push(...line.split(/\s+/).slice(1));
    } else if (line.startsWith('POINTS')) {
      pointCount = parseInt(line.split(/\s+/)[1]);
    } else if (line.startsWith('DATA')) {
      dataFormat = line.split(/\s+/)[1];
      headerEndLine = i + 1;
      break;
    }
  }

  if (pointCount === 0) throw new Error('No points found in PCD file');
  if (dataFormat !== 'ascii') {
    throw new Error('Binary PCD format not yet supported. Please convert to ASCII PCD.');
  }

  // Find field indices
  const xIdx = fields.indexOf('x');
  const yIdx = fields.indexOf('y');
  const zIdx = fields.indexOf('z');
  const rgbIdx = fields.indexOf('rgb');
  const intensityIdx = fields.indexOf('intensity');

  if (xIdx === -1 || yIdx === -1 || zIdx === -1) {
    throw new Error('PCD file must have x, y, z fields');
  }

  const positions = new Float32Array(pointCount * 3);
  let colors: Float32Array | undefined;
  let intensities: Float32Array | undefined;

  if (rgbIdx !== -1) {
    colors = new Float32Array(pointCount * 3);
  }
  if (intensityIdx !== -1) {
    intensities = new Float32Array(pointCount);
  }

  let pointIdx = 0;
  for (let i = headerEndLine; i < lines.length && pointIdx < pointCount; i++) {
    const line = lines[i].trim();
    if (!line) continue;

    const values = line.split(/\s+/).map(parseFloat);

    positions[pointIdx * 3] = values[xIdx];
    positions[pointIdx * 3 + 1] = values[yIdx];
    positions[pointIdx * 3 + 2] = values[zIdx];

    if (colors && rgbIdx !== -1) {
      // RGB is packed as a float in PCD format
      const rgbFloat = values[rgbIdx];
      const rgbInt = new Float32Array([rgbFloat]);
      const view = new DataView(rgbInt.buffer);
      const packed = view.getUint32(0, true);
      colors[pointIdx * 3] = ((packed >> 16) & 0xff) / 255;
      colors[pointIdx * 3 + 1] = ((packed >> 8) & 0xff) / 255;
      colors[pointIdx * 3 + 2] = (packed & 0xff) / 255;
    }

    if (intensities && intensityIdx !== -1) {
      intensities[pointIdx] = values[intensityIdx];
    }

    pointIdx++;
  }

  const result: PointCloudData = {
    positions: positions.slice(0, pointIdx * 3),
    pointCount: pointIdx,
    bounds: calculateBounds(positions, pointIdx),
    fileName: file.name,
  };

  if (colors) result.colors = colors.slice(0, pointIdx * 3);
  if (intensities) result.intensities = intensities.slice(0, pointIdx);

  return result;
}

// Parse LAS format (simplified - handles LAS 1.2-1.4)
export async function parseLAS(file: File): Promise<PointCloudData> {
  const buffer = await file.arrayBuffer();
  const view = new DataView(buffer);

  // Check signature
  const signature = String.fromCharCode(view.getUint8(0), view.getUint8(1), view.getUint8(2), view.getUint8(3));
  if (signature !== 'LASF') {
    throw new Error('Invalid LAS file: signature mismatch');
  }

  // Read header
  const versionMajor = view.getUint8(24);
  const versionMinor = view.getUint8(25);
  const pointDataOffset = view.getUint32(96, true);
  const pointDataFormat = view.getUint8(104);

  let pointCount: number;
  let pointRecordLength: number;

  if (versionMajor === 1 && versionMinor >= 4) {
    // LAS 1.4
    pointCount = Number(view.getBigUint64(247, true));
    pointRecordLength = view.getUint16(105, true);
  } else {
    // LAS 1.0-1.3
    pointCount = view.getUint32(107, true);
    pointRecordLength = view.getUint16(105, true);
  }

  // Scale and offset
  const scaleX = view.getFloat64(131, true);
  const scaleY = view.getFloat64(139, true);
  const scaleZ = view.getFloat64(147, true);
  const offsetX = view.getFloat64(155, true);
  const offsetY = view.getFloat64(163, true);
  const offsetZ = view.getFloat64(171, true);

  // Limit points for performance
  const maxPoints = 5_000_000;
  const actualPointCount = Math.min(pointCount, maxPoints);

  const positions = new Float32Array(actualPointCount * 3);
  const intensities = new Float32Array(actualPointCount);
  let colors: Float32Array | undefined;

  // Scalar field arrays for LAS-specific attributes
  const classifications = new Float32Array(actualPointCount);
  const returnNumbers = new Float32Array(actualPointCount);
  const numberOfReturns = new Float32Array(actualPointCount);
  const scanAngles = new Float32Array(actualPointCount);
  const pointSourceIds = new Float32Array(actualPointCount);

  // Check if format has RGB
  const hasRGB = [2, 3, 5, 7, 8, 10].includes(pointDataFormat);
  if (hasRGB) {
    colors = new Float32Array(actualPointCount * 3);
  }

  // Track min/max for scalar fields
  let classMin = Infinity, classMax = -Infinity;
  let returnNumMin = Infinity, returnNumMax = -Infinity;
  let numReturnsMin = Infinity, numReturnsMax = -Infinity;
  let scanAngleMin = Infinity, scanAngleMax = -Infinity;
  let pointSourceMin = Infinity, pointSourceMax = -Infinity;

  // Determine if using new (format 6-10) or old (format 0-5) point record structure
  const isNewFormat = pointDataFormat >= 6;

  for (let i = 0; i < actualPointCount; i++) {
    const offset = pointDataOffset + i * pointRecordLength;

    // XYZ as scaled integers
    const xi = view.getInt32(offset, true);
    const yi = view.getInt32(offset + 4, true);
    const zi = view.getInt32(offset + 8, true);

    positions[i * 3] = xi * scaleX + offsetX;
    positions[i * 3 + 1] = yi * scaleY + offsetY;
    positions[i * 3 + 2] = zi * scaleZ + offsetZ;

    // Intensity
    intensities[i] = view.getUint16(offset + 12, true) / 65535;

    if (isNewFormat) {
      // LAS 1.4 format 6-10: different byte layout
      // Return number/number of returns at offset 14 (combined byte)
      const returnByte = view.getUint8(offset + 14);
      returnNumbers[i] = returnByte & 0x0F;  // bits 0-3
      numberOfReturns[i] = (returnByte >> 4) & 0x0F;  // bits 4-7

      // Classification at offset 16
      classifications[i] = view.getUint8(offset + 16);

      // Scan angle at offset 18 (scaled by 0.006 degrees)
      scanAngles[i] = view.getInt16(offset + 18, true) * 0.006;

      // Point source ID at offset 22
      pointSourceIds[i] = view.getUint16(offset + 22, true);
    } else {
      // LAS 1.0-1.3 format 0-5: original byte layout
      // Return number/number of returns at offset 14 (combined byte)
      const returnByte = view.getUint8(offset + 14);
      returnNumbers[i] = returnByte & 0x07;  // bits 0-2
      numberOfReturns[i] = (returnByte >> 3) & 0x07;  // bits 3-5

      // Classification at offset 15
      classifications[i] = view.getUint8(offset + 15);

      // Scan angle rank at offset 16 (signed byte, degrees)
      scanAngles[i] = view.getInt8(offset + 16);

      // Point source ID at offset 18
      pointSourceIds[i] = view.getUint16(offset + 18, true);
    }

    // Update min/max
    if (classifications[i] < classMin) classMin = classifications[i];
    if (classifications[i] > classMax) classMax = classifications[i];
    if (returnNumbers[i] < returnNumMin) returnNumMin = returnNumbers[i];
    if (returnNumbers[i] > returnNumMax) returnNumMax = returnNumbers[i];
    if (numberOfReturns[i] < numReturnsMin) numReturnsMin = numberOfReturns[i];
    if (numberOfReturns[i] > numReturnsMax) numReturnsMax = numberOfReturns[i];
    if (scanAngles[i] < scanAngleMin) scanAngleMin = scanAngles[i];
    if (scanAngles[i] > scanAngleMax) scanAngleMax = scanAngles[i];
    if (pointSourceIds[i] < pointSourceMin) pointSourceMin = pointSourceIds[i];
    if (pointSourceIds[i] > pointSourceMax) pointSourceMax = pointSourceIds[i];

    // RGB (if available)
    if (colors && hasRGB) {
      let rgbOffset = offset + 20;
      // Adjust offset based on format
      if (pointDataFormat >= 6) {
        rgbOffset = offset + 28;
      }

      const r = view.getUint16(rgbOffset, true);
      const g = view.getUint16(rgbOffset + 2, true);
      const b = view.getUint16(rgbOffset + 4, true);

      colors[i * 3] = r / 65535;
      colors[i * 3 + 1] = g / 65535;
      colors[i * 3 + 2] = b / 65535;
    }
  }

  const result: PointCloudData = {
    positions,
    intensities,
    pointCount: actualPointCount,
    bounds: calculateBounds(positions, actualPointCount),
    fileName: file.name,
  };

  if (colors) result.colors = colors;

  // Build scalar fields from LAS attributes (only if there's variance)
  const scalarFields: Record<string, ScalarField> = {};

  if (classMin !== classMax) {
    scalarFields['Classification'] = {
      values: classifications,
      min: classMin,
      max: classMax,
    };
  }

  if (returnNumMin !== returnNumMax) {
    scalarFields['Return Number'] = {
      values: returnNumbers,
      min: returnNumMin,
      max: returnNumMax,
    };
  }

  if (numReturnsMin !== numReturnsMax) {
    scalarFields['Number of Returns'] = {
      values: numberOfReturns,
      min: numReturnsMin,
      max: numReturnsMax,
    };
  }

  if (scanAngleMin !== scanAngleMax) {
    scalarFields['Scan Angle'] = {
      values: scanAngles,
      min: scanAngleMin,
      max: scanAngleMax,
    };
  }

  if (pointSourceMin !== pointSourceMax) {
    scalarFields['Point Source ID'] = {
      values: pointSourceIds,
      min: pointSourceMin,
      max: pointSourceMax,
    };
  }

  if (Object.keys(scalarFields).length > 0) {
    result.scalarFields = scalarFields;
  }

  return result;
}

// Parse LAS/LAZ via the backend (laspy + lazrs). This is the no-disk-path
// fallback — a File blob with no real path can't use the binary import_by_path
// route. The endpoint now streams a packed PHX1 binary frame (decoded into
// Float32Array views by importPointCloudLasLaz), so the result is reused
// directly via buildPointCloudFromBackend — no per-point number[][] copy and no
// V8 string-size ceiling on the response.
export async function parseLAZ(file: File): Promise<PointCloudData> {
  try {
    const result = await importPointCloudLasLaz(file);
    return buildPointCloudFromBackend(result, file.name);
  } catch (error) {
    // If backend is not available, provide helpful error message
    if (error instanceof TypeError && error.message.includes('fetch')) {
      throw new Error('Backend not available for LAZ import. Please ensure the backend server is running.');
    }
    throw error;
  }
}

// Extensions that the renderer parses via the path-based backend endpoint
// instead of reading into memory. The TS parsers (parseXYZ, parsePLY,
// parsePCD) all materialise the file as a JS string and throw RangeError
// past V8's ~512 MB max string size, so the multi-hundred-MB scans that
// are typical of TLS surveys have to be parsed in Python.
//
// LAS/LAZ aren't here: they already go through importPointCloudLasLaz as
// a multipart upload and don't share the string-limit issue (laspy reads
// binary chunks).
const BACKEND_PATH_EXTENSIONS = new Set([
  // ASCII delimited (pandas, honours Helios <ASCII_format>)
  'xyz', 'txt', 'csv', 'pts', 'asc',
  // PLY / PCD (open3d — handles ASCII and binary variants both)
  'ply', 'pcd',
]);

// Read a file from disk via the main-process fs IPC and parse it. Used when
// the renderer has a path string (e.g. resolved from a Helios XML <filename>)
// rather than a File handle from a dropzone or <input type=file>.
//
// Extensions in BACKEND_PATH_EXTENSIONS go to the Python backend; everything
// else (LAS, OBJ-points, …) falls back to the in-renderer parsers via
// `parsePointCloud`. `asciiFormat` is forwarded to the backend when known
// (Helios <ASCII_format>) and ignored on the PLY/PCD route.
// Every path-backed point cloud goes through the Potree 2.0 octree pipeline —
// the flat-Float32Array path can't fit clouds large enough to matter on a real
// workload. The backend's `_source_to_las` converts each format to LAS before
// PotreeConverter: XYZ-family via pandas, PLY via plyfile (scalar fields
// preserved as LAS extra dims), PCD via open3d (position + RGB only), and
// LAS/LAZ pass straight through. PLY/PCD stay in BACKEND_PATH_EXTENSIONS as the
// flat fallback for Blob/no-path inputs that can't be octree'd. E57 is
// octree-only (binary structured scan format; converted via pye57, recovering
// sky/miss points) with no flat fallback.
const OCTREE_PATH_EXTENSIONS = new Set(['xyz', 'txt', 'csv', 'pts', 'asc', 'ply', 'pcd', 'las', 'laz', 'e57', 'ptx']);

export async function parsePointCloudFromPath(
  path: string,
  asciiFormat?: string | null,
  columnPlan?: ColumnPlan | null,
  categoricalAttributes?: string[],
  worldShift?: [number, number, number] | null,
  continuousAttributes?: string[],
  // Far-field distance (m) for miss auto-detection's distance fallback, sourced
  // from AppSettings by the importer. Forwarded to createCloudSession; null →
  // backend default (1001 m). Only the octree path consumes it.
  missDistanceThreshold?: number | null,
  // Scanner head position [x, y, z] from an imported Helios scan XML bundle's
  // <origin>, when known. Forwarded to createCloudSession so the backend can
  // reproject sky/miss points onto the display shell instead of far-field.
  origin?: [number, number, number] | null,
  // Cancellation + progress for the (slow) octree import. Grouped into an
  // options object rather than three more positionals — the list is already
  // long. Only the octree path consumes them; the flat fallbacks are fast.
  opts?: ImportProgressOptions,
): Promise<PointCloudData> {
  const sepIdx = Math.max(path.lastIndexOf('/'), path.lastIndexOf('\\'));
  const name = sepIdx >= 0 ? path.slice(sepIdx + 1) : path;
  const ext = name.toLowerCase().split('.').pop() ?? '';

  if (OCTREE_PATH_EXTENSIONS.has(ext)) {
    // Editable octree flow: load into a mutable backend session (positions held
    // in RAM as the source of truth) and stream its derived octree. Crop/erase
    // then route through delete_region; downstream ops read the masked array.
    // The optional CloudCompare-style global shift is subtracted at session
    // create (the array + octree get small coords); the backend echoes it back.
    const meta = await createCloudSession(
      path, asciiFormat ?? null, columnPlan ?? null, worldShift ?? null,
      missDistanceThreshold ?? null, origin ?? null,
      opts?.signal, opts?.onProgress, opts?.onRunId,
    );
    return buildPointCloudFromOctree(meta, path, name, {
      asciiFormat,
      columnPlan,
      categoricalAttributes,
      sessionId: meta.session_id,
      worldShift: meta.world_shift ?? null,
      continuousAttributes,
    });
  }

  if (BACKEND_PATH_EXTENSIONS.has(ext)) {
    const result = await importPointCloudByPath(path, asciiFormat ?? null, columnPlan ?? null, worldShift ?? null);
    return buildPointCloudFromBackend(result, name);
  }

  // Reject a known-unreadable format before readBinary — pulling a multi-GB
  // scan across the IPC boundary just to throw is the slow failure this guard
  // exists to prevent.
  const unreadable = UNREADABLE_POINT_CLOUD_FORMATS[ext];
  if (unreadable) throw new Error(unreadableFormatMessage(name, unreadable));

  const buf = await window.electronAPI.fs.readBinary(path);
  const file = new File([buf], name);
  return parsePointCloud(file);
}

/** One imported scan position: its cloud plus the display name for it. */
export interface ImportedScanPosition {
  data: PointCloudData;
  /** File stem for a single-scan source; `<stem> — scan N` for a multi-scan one. */
  name: string;
  scanIndex: number;
}

/**
 * Import a path as one cloud PER SCAN POSITION.
 *
 * The plural sibling of {@link parsePointCloudFromPath}. Only the octree route
 * can fan out — a multi-scan E57 or multi-block PTX is decoded position by
 * position in the backend, each getting its own session, octree and
 * `ScanParameters`, because a scan is defined by its pose and merging positions
 * leaves one origin standing in for all of them.
 *
 * Every other format (and every non-octree route) yields exactly one element, so
 * callers never branch on the extension.
 */
export async function parsePointCloudsFromPath(
  path: string,
  asciiFormat?: string | null,
  columnPlan?: ColumnPlan | null,
  categoricalAttributes?: string[],
  worldShift?: [number, number, number] | null,
  continuousAttributes?: string[],
  missDistanceThreshold?: number | null,
  origin?: [number, number, number] | null,
  opts?: ImportProgressOptions,
): Promise<ImportedScanPosition[]> {
  const sepIdx = Math.max(path.lastIndexOf('/'), path.lastIndexOf('\\'));
  const name = sepIdx >= 0 ? path.slice(sepIdx + 1) : path;
  const ext = name.toLowerCase().split('.').pop() ?? '';

  if (!OCTREE_PATH_EXTENSIONS.has(ext)) {
    // Flat / in-renderer routes are inherently 1:1; reuse the singular path
    // verbatim rather than duplicating its fallbacks.
    const data = await parsePointCloudFromPath(
      path, asciiFormat, columnPlan, categoricalAttributes, worldShift,
      continuousAttributes, missDistanceThreshold, origin, opts,
    );
    return [{ data, name, scanIndex: 0 }];
  }

  const positions = await createCloudSessions(
    path, asciiFormat ?? null, columnPlan ?? null, worldShift ?? null,
    missDistanceThreshold ?? null, origin ?? null,
    opts?.signal, opts?.onProgress, opts?.onRunId,
  );

  const ok = positions.filter(p => p.session && !p.error);
  if (ok.length === 0) {
    // Every position failed. Surface the first real reason rather than a bare
    // "no scans" — the backend already isolated and described each failure.
    const first = positions.find(p => p.error)?.error;
    throw new Error(first ?? `No scan positions could be imported from ${name}.`);
  }

  return ok.map(p => ({
    data: buildPointCloudFromOctree(p.session!, path, p.name, {
      asciiFormat,
      columnPlan,
      categoricalAttributes,
      sessionId: p.session!.session_id,
      worldShift: p.session!.world_shift ?? null,
      continuousAttributes,
    }),
    name: p.name,
    scanIndex: p.scan_index,
  }));
}

/**
 * Construct a PointCloudData backed by a Potree 2.0 octree. The cloud's
 * positions/colors arrays are LEFT EMPTY — the renderer dispatches to
 * `OctreePointCloud` based on `data.octree`, which streams visible
 * tiles directly from the cache via the `app://` protocol. Bounds and
 * pointCount come from the converter's metadata.
 *
 * `sourceXyzPath` is preserved so M3's crop-apply can re-run the
 * converter against the original file with an AABB filter.
 */
export interface BuildOctreeCloudOptions {
  asciiFormat?: string | null;
  columnPlan?: ColumnPlan | null;
  /** Slugs the user marked categorical ("Label") in the import wizard. */
  categoricalAttributes?: string[];
  sessionId?: string | null;
  worldShift?: [number, number, number] | null;
  /** Slugs the user forced continuous ("Scalar") over a registered scheme. */
  continuousAttributes?: string[];
  /**
   * User-defined class palettes, keyed by attribute slug. Must be threaded
   * through every rebuild path or a cloud comes back with invented "Class N"
   * names — see OctreeRef.classPalettes.
   */
  classPalettes?: Record<string, ClassPalette>;
}

export function buildPointCloudFromOctree(
  meta: OctreeMetadata,
  sourceXyzPath: string,
  fileName: string,
  options: BuildOctreeCloudOptions = {},
): PointCloudData {
  const {
    asciiFormat,
    columnPlan,
    categoricalAttributes,
    sessionId,
    worldShift,
    continuousAttributes,
    classPalettes,
  } = options;
  // Prefer the tight data extent over the cube-padded octree bounds.
  // Crop-box init, fit-to-bounds camera framing, and the bounds shown in
  // the right-pane scan list all expect "where the data actually lives"
  // not "where the octree's spatial index extends to".
  const bnd = meta.tight_bounds ?? meta.bounds;
  const min = new THREE.Vector3(bnd.min[0], bnd.min[1], bnd.min[2]);
  const max = new THREE.Vector3(bnd.max[0], bnd.max[1], bnd.max[2]);
  const center = new THREE.Vector3().addVectors(min, max).multiplyScalar(0.5);
  const size = new THREE.Vector3().subVectors(max, min);

  // Index attribute ranges by name. The shader needs intensity range
  // and (eventually) other per-attribute extrema to set its gradient
  // uniforms; without them every point maps to the same texel and the
  // mode renders as a solid colour.
  const attributeRanges: Record<string, { min: number[]; max: number[] }> = {};
  const attributeLabels: Record<string, string> = {};
  for (const a of meta.attributes ?? []) {
    // PotreeConverter names the per-point time column by its LAS dimension,
    // `gps-time`, but EVERY Phytograph consumer keys off the slug `timestamp`:
    // the export allowlist (_SCAN_EXPORT_SCALAR_COLUMNS), missColumnsAvailable
    // (which gates Backfill Misses), and _MULTI_RETURN_SLUGS. Left unmapped the
    // column is carried but invisible to all of them — it showed up in the
    // colour-by picker under the wrong name and was absent from the export
    // picker entirely. Normalise here, at the one seam where the octree's
    // attribute view is built, rather than teaching each consumer both names.
    let name = a.name;
    if (name === OCTREE_GPS_TIME_ATTRIBUTE) {
      // A cloud can carry BOTH: an ASCII import with an explicit `timestamp`
      // column still gets PotreeConverter's degenerate all-zero `gps-time`
      // alongside it. Renaming unconditionally would then either clobber the
      // real column with zeros or offer it twice, so defer to an existing
      // `timestamp` and drop this one — the degenerate-range check would have
      // suppressed it anyway.
      if (meta.attributes?.some((o) => o.name === TIMESTAMP_SLUG)) continue;
      name = TIMESTAMP_SLUG;
    }
    if (Array.isArray(a.min) && Array.isArray(a.max)) {
      attributeRanges[name] = { min: a.min, max: a.max };
    }
    if (a.label) {
      attributeLabels[name] = a.label;
    }
  }

  return {
    // No flat arrays — the OctreePointCloud renderer reads from the
    // octree directly. An empty Float32Array satisfies the type without
    // consuming heap on a multi-gigabyte source.
    positions: new Float32Array(0),
    pointCount: meta.point_count,
    bounds: { min, max, center, size },
    // Outlier-resistant floor from the cloud-session create response (a superset
    // of OctreeMetadata); plain OctreeMetadata callers leave it undefined and
    // consumers fall back to bounds.min.z.
    groundZ: typeof (meta as OctreeMetadata & { ground_z?: number | null }).ground_z === 'number'
      ? (meta as OctreeMetadata & { ground_z: number }).ground_z
      : undefined,
    // Same provenance as groundZ: present on the cloud-session create response,
    // undefined for plain OctreeMetadata callers (who fall back to the raw size).
    robustExtent: (() => {
      const e = (meta as OctreeMetadata & { robust_extent?: unknown }).robust_extent;
      return Array.isArray(e) && e.length === 3 && e.every((v) => typeof v === 'number' && isFinite(v))
        ? ([e[0], e[1], e[2]] as [number, number, number])
        : undefined;
    })(),
    robustBounds: (() => {
      const b = (meta as OctreeMetadata & { robust_bounds?: unknown }).robust_bounds as
        | { min?: unknown; max?: unknown } | null | undefined;
      const ok = (v: unknown): v is [number, number, number] =>
        Array.isArray(v) && v.length === 3 && v.every((n) => typeof n === 'number' && isFinite(n));
      return b && ok(b.min) && ok(b.max) ? { min: b.min, max: b.max } : undefined;
    })(),
    fileName,
    octree: {
      cacheId: meta.cache_id,
      sourceXyzPath,
      sessionId: sessionId ?? null,
      worldShift: worldShift ?? null,
      asciiFormat: asciiFormat ?? null,
      attributeRanges,
      attributeLabels,
      columnPlan: columnPlan ?? null,
      categoricalAttributes: categoricalAttributes && categoricalAttributes.length
        ? categoricalAttributes
        : undefined,
      continuousAttributes: continuousAttributes && continuousAttributes.length
        ? continuousAttributes
        : undefined,
      classPalettes: classPalettes && Object.keys(classPalettes).length
        ? classPalettes
        : undefined,
      // Sky/miss info comes from the cloud-session create response (a superset
      // of OctreeMetadata); plain OctreeMetadata callers leave these undefined.
      hasMisses: 'has_misses' in meta ? Boolean((meta as { has_misses?: boolean }).has_misses) : undefined,
      scanOrigin: 'scan_origin' in meta
        ? ((meta as { scan_origin?: [number, number, number] }).scan_origin ?? null)
        : undefined,
      // sha1 of the projected-miss octree the backend built alongside the hits
      // octree; streamed by MissOctree when "Show misses" is on. null when the
      // scan has no placeable misses.
      missOctreeCacheId: 'miss_octree_cache_id' in meta
        ? ((meta as { miss_octree_cache_id?: string | null }).miss_octree_cache_id ?? null)
        : undefined,
      // Full scan-pattern params recovered from the file header (E57/PCD), used
      // to auto-populate the Scan's ScanParameters at import. Absent for plain
      // OctreeMetadata callers and for files that carried no scan metadata.
      scanParams: 'scan_params' in meta
        ? ((meta as { scan_params?: ScanParamsFromFile }).scan_params ?? null)
        : undefined,
    },
  };
}

export function buildPointCloudFromBackend(
  result: { pointCount: number; positions: Float32Array; colors: Float32Array | null; intensity: Float32Array | null },
  fileName: string,
): PointCloudData {
  // Reuse the backend response's Float32Array views directly. The decoder
  // already created Float32Array views over the response ArrayBuffer
  // (see decodePointCloudBinary); copying them here would double peak
  // memory transiently for no benefit — for a ~14M-point post-crop
  // result that's an extra ~400 MB external memory at the exact moment
  // the apply path is also holding the OLD scan in React state and
  // every other live cloud's typed arrays. That extra ~400 MB is what
  // was tipping V8's 4 GB old-space ceiling on multi-cloud apply.
  //
  // The shared ArrayBuffer stays alive as long as any view references
  // it, which is exactly what we want — these views are the new
  // cloud.data and they're meant to outlive the response object.
  const positions = result.positions;
  const data: PointCloudData = {
    positions,
    pointCount: result.pointCount,
    bounds: calculateBounds(positions, result.pointCount),
    fileName,
  };

  if (result.colors) {
    data.colors = result.colors;
  }

  if (result.intensity) {
    // Match parseXYZ's behaviour: normalise intensity to 0-1 for the
    // viewer. Done in place on the view so we don't allocate a fresh
    // Float32Array of the same length.
    const arr = result.intensity;
    let min = Infinity;
    let max = -Infinity;
    for (let i = 0; i < arr.length; i++) {
      const v = arr[i];
      if (v < min) min = v;
      if (v > max) max = v;
    }
    const range = max - min || 1;
    for (let i = 0; i < arr.length; i++) {
      arr[i] = (arr[i] - min) / range;
    }
    data.intensities = arr;
  }

  return data;
}

// Scan formats we deliberately don't read, named so the rejection is instant
// and says something useful. They have to be listed explicitly for two
// reasons. The binary ones (RCS, FLS, …) would otherwise be handed to the XYZ
// parser, which reads the WHOLE file into a string before it can fail. And
// PTX used to head this list for the second reason — it is plain numeric ASCII,
// so it sailed past the sniff and then parsed *wrongly* (header block as junk
// points, RGB read one column left). It is now genuinely supported: the backend
// reads its raster and recovers sky/miss points from it. PTG stays because it is
// PTX's BINARY sibling and shares nothing but the name.
const UNREADABLE_POINT_CLOUD_FORMATS: Record<string, string> = {
  ptg: 'a PTG structured scan (Leica, binary)',
  fls: 'a FARO scan (FLS)',
  fws: 'a FARO workspace (FWS)',
  zfs: 'a Z+F scan (ZFS)',
  zfprj: 'a Z+F project (ZFPRJ)',
  rcp: 'an Autodesk ReCap project (RCP)',
  rcs: 'an Autodesk ReCap scan (RCS)',
  lgs: 'a Leica Cyclone published scan (LGS)',
  cl3: 'a Topcon scan (CL3)',
};

function unreadableFormatMessage(fileName: string, what: string): string {
  return (
    `"${fileName}" is ${what}, which Phytograph can't read directly. ` +
    `Export it as E57, LAS/LAZ, or plain XYZ text from your scanner software ` +
    `and import that instead.`
  );
}

/** Bytes of an unknown-extension file inspected before committing to a parse. */
const ASCII_SNIFF_BYTES = 64 * 1024;

/**
 * Cheap head-sniff deciding whether an unknown-extension file is worth handing
 * to `parseXYZ`. Reads only the first {@link ASCII_SNIFF_BYTES} — matching the
 * budget `plyHasFaces`/`isQsmCsvFile` use — because `parseXYZ` reads the
 * ENTIRE file into a string, splits it into one string per line and
 * accumulates a `number[][]`. On a multi-GB scan that is minutes of frozen
 * renderer and several GB of heap spent to arrive at "unsupported format".
 */
export async function looksLikeAsciiPointCloud(file: File): Promise<boolean> {
  let text: string;
  try {
    text = await file.slice(0, ASCII_SNIFF_BYTES).text();
  } catch {
    return false;
  }

  // A binary container decodes to NULs / replacement characters, usually well
  // before the first newline. Bail without tokenising anything.
  if (text.includes('\0') || text.includes('�')) return false;

  const lines = text.split('\n');
  // The last line is probably cut mid-number by the slice — drop it, unless
  // the whole file fit inside the sniff window.
  if (file.size > ASCII_SNIFF_BYTES) lines.pop();

  let checked = 0;
  let numeric = 0;
  for (const raw of lines) {
    const line = raw.trim();
    if (!line || line.startsWith('#') || line.startsWith('//')) continue;
    checked++;
    const parts = line.split(/[,;\t ]+/);
    if (parts.length >= 3 && parts.slice(0, 3).every(p => p !== '' && Number.isFinite(Number(p)))) {
      numeric++;
    }
    if (checked >= 200) break;
  }

  // One header row of column names is normal (parseXYZ handles it), so allow a
  // few non-numeric lines — but demand a clear majority, otherwise prose, JSON
  // or XML with a stray numeric line would earn itself a full parse.
  return checked > 0 && numeric >= Math.ceil(checked * 0.8);
}

// Auto-detect format and parse
export async function parsePointCloud(file: File): Promise<PointCloudData> {
  const ext = file.name.toLowerCase().split('.').pop();

  switch (ext) {
    case 'las':
      return parseLAS(file);

    case 'laz':
      // Use backend for LAZ decompression
      return parseLAZ(file);

    case 'ply':
      return parsePLY(file);

    case 'pcd':
      return parsePCD(file);

    case 'xyz':
    case 'txt':
    case 'csv':
    case 'pts':
    case 'asc':
      return parseXYZ(file);

    case 'ptx':
      // PTX is octree-only: only the backend converter understands its raster
      // and scanner pose, which is what makes the sky/miss recovery possible.
      // It needs an explicit case rather than falling through to `default`,
      // because PTX is plain numeric ASCII — the head sniff there accepts it and
      // the XYZ parser then produces exactly the silently-wrong cloud this used
      // to be rejected for (the header block as junk points near the origin, RGB
      // read one column left).
      throw new Error(
        `"${file.name}" is a PTX structured scan, which has to be read from disk ` +
        `so its scan grid and scanner pose can be recovered. Drag the file in, or ` +
        `use File → Import — a PTX with no file path can't be imported.`,
      );

    case 'xml':
      // Helios scan XML describes scan *parameters* and references a separate
      // point cloud file — it contains no coordinates itself. Importing it
      // directly used to fall through to the XYZ parser, which silently
      // produced 0 points and a NaN center. Point users at the right path.
      throw new Error(
        `"${file.name}" is a scan definition (XML), not a point cloud. ` +
        `Use the "Add Scan" tool and choose "Import from XML file" to load it — ` +
        `that reads the scan parameters and the point cloud file it references.`,
      );

    default: {
      const unreadable = UNREADABLE_POINT_CLOUD_FORMATS[ext ?? ''];
      if (unreadable) throw new Error(unreadableFormatMessage(file.name, unreadable));

      // Unknown extension: it may still be a delimited ASCII cloud under a
      // house extension (.pt, .dat, a bare `scan1`). Decide from the first
      // 64 KB rather than committing to a full parse — see
      // looksLikeAsciiPointCloud for why that matters on a large file.
      if (!(await looksLikeAsciiPointCloud(file))) {
        throw new Error(
          `Unsupported file format: .${ext}. ` +
          `Supported formats: ${POINT_CLOUD_FORMATS.map(f => f.name).join(', ')}`,
        );
      }
      // Let parseXYZ's own failure through: "No point coordinates found in …"
      // names the real problem, which the old blanket catch here replaced with
      // a misleading "unsupported format".
      return parseXYZ(file);
    }
  }
}

// Export supported formats for UI - organized by type
export const POINT_CLOUD_FORMATS = [
  { ext: '.las', name: 'LAS', desc: 'LiDAR Data Exchange' },
  { ext: '.laz', name: 'LAZ', desc: 'Compressed LiDAR' },
  { ext: '.e57', name: 'E57', desc: 'Structured scan (recovers sky/miss)' },
  { ext: '.ptx', name: 'PTX', desc: 'Structured scan (recovers sky/miss)' },
  { ext: '.ply', name: 'PLY', desc: 'Stanford Polygon (ASCII)' },
  { ext: '.pcd', name: 'PCD', desc: 'Point Cloud Data (ASCII)' },
  { ext: '.xyz', name: 'XYZ', desc: 'X Y Z coordinates' },
  { ext: '.txt', name: 'TXT', desc: 'Text coordinates' },
  { ext: '.csv', name: 'CSV', desc: 'Comma-separated' },
  { ext: '.pts', name: 'PTS', desc: 'Points format' },
  { ext: '.asc', name: 'ASC', desc: 'ASCII point cloud' },
];

export const MESH_FORMATS = [
  { ext: '.obj', name: 'OBJ', desc: 'Wavefront mesh' },
  { ext: '.stl', name: 'STL', desc: 'Stereolithography (ASCII + binary)' },
  { ext: '.ply', name: 'PLY', desc: 'Stanford Polygon (mesh)' },
];

export const SKELETON_FORMATS = [
  { ext: '.json', name: 'JSON', desc: 'Skeleton data' },
];

// Combined list for backward compatibility
export const SUPPORTED_FORMATS = [...POINT_CLOUD_FORMATS, ...MESH_FORMATS, ...SKELETON_FORMATS];

// ==================== MESH PARSING ====================

export interface ParsedMesh {
  vertices: Float32Array;
  indices: Uint32Array;
  normals?: Float32Array;
  vertexColors?: Float32Array; // r, g, b interleaved (0-1), present iff PLY carried per-vertex color
  vertexCount: number;
  triangleCount: number;
  fileName: string;
}

// Parse OBJ mesh format
export async function parseOBJMesh(file: File): Promise<ParsedMesh> {
  const text = await file.text();
  const lines = text.trim().split('\n');

  const vertices: number[] = [];
  const normals: number[] = [];
  const faces: number[][] = [];
  const faceNormals: number[][] = [];

  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;

    const parts = trimmed.split(/\s+/);
    const cmd = parts[0];

    if (cmd === 'v') {
      vertices.push(parseFloat(parts[1]), parseFloat(parts[2]), parseFloat(parts[3]));
    } else if (cmd === 'vn') {
      normals.push(parseFloat(parts[1]), parseFloat(parts[2]), parseFloat(parts[3]));
    } else if (cmd === 'f') {
      const faceIndices: number[] = [];
      const faceNormalIndices: number[] = [];
      for (let i = 1; i < parts.length; i++) {
        const vertexData = parts[i].split('/');
        faceIndices.push(parseInt(vertexData[0]) - 1); // OBJ is 1-indexed
        if (vertexData[2]) {
          faceNormalIndices.push(parseInt(vertexData[2]) - 1);
        }
      }
      // Triangulate if more than 3 vertices (fan triangulation)
      for (let i = 1; i < faceIndices.length - 1; i++) {
        faces.push([faceIndices[0], faceIndices[i], faceIndices[i + 1]]);
        if (faceNormalIndices.length > 0) {
          faceNormals.push([faceNormalIndices[0], faceNormalIndices[i], faceNormalIndices[i + 1]]);
        }
      }
    }
  }

  if (vertices.length === 0 || faces.length === 0) {
    throw new Error('No mesh data found in OBJ file');
  }

  const vertexCount = vertices.length / 3;
  const triangleCount = faces.length;

  const vertexArray = new Float32Array(vertices);
  const indexArray = new Uint32Array(triangleCount * 3);

  for (let i = 0; i < triangleCount; i++) {
    indexArray[i * 3] = faces[i][0];
    indexArray[i * 3 + 1] = faces[i][1];
    indexArray[i * 3 + 2] = faces[i][2];
  }

  const result: ParsedMesh = {
    vertices: vertexArray,
    indices: indexArray,
    vertexCount,
    triangleCount,
    fileName: file.name,
  };

  if (normals.length > 0) {
    result.normals = new Float32Array(normals);
  }

  return result;
}

// A corrupt/misread triangle count is a uint32, so it can ask for up to 4.29e9
// triangles (~154 GB of typed arrays). Cap it so a bogus count becomes a clean
// classification miss rather than an unhandled allocation RangeError. The cap is
// a ceiling, not a policy — 50M triangles is already a 2.5 GB file.
const MAX_STL_TRIANGLES = 50_000_000;

export type StlKind = 'binary' | 'ascii';

/**
 * Decide whether an STL is binary or ASCII from its first 84 bytes and its size.
 *
 * The length test (84 + 50n vs size) is authoritative; the leading `solid` token
 * is deliberately NOT consulted. That heuristic fails in both directions: plenty
 * of binary writers put arbitrary text in the 80-byte header, and the file that
 * motivated this code (a Blender-exported binary STL) has a header of 80 zero
 * bytes — no `solid` prefix to key off at all. The arithmetic, by contrast, is
 * self-validating: a real ASCII file whose bytes 80..83 happen to satisfy
 * 84 + 50n == size is a coincidence we have never seen in practice.
 *
 * Anything not positively identified as binary falls through to 'ascii', so a
 * misclassification degrades to the text parser (which reports its own error)
 * rather than to a bogus read.
 */
export function detectStlKind(headerBytes: ArrayBuffer, fileSize: number): StlKind {
  if (headerBytes.byteLength < 84 || fileSize < 84) return 'ascii';

  const n = new DataView(headerBytes).getUint32(80, true);
  // An empty binary STL is indistinguishable from a header-only ASCII one; let
  // the ASCII path handle it so the "no mesh data" error stays the single voice
  // for empty files.
  if (n === 0) return 'ascii';
  if (n > MAX_STL_TRIANGLES) return 'ascii';

  const expected = 84 + 50 * n;
  // Exact match, or trailing bytes (some writers pad or append metadata).
  if (expected <= fileSize) return 'binary';
  // expected > fileSize: truncated if it really is binary. Fall to ASCII, which
  // either parses it (it was text) or raises the truncation error below.
  return 'ascii';
}

/**
 * Parse ASCII STL text. Output is unwelded — 3 fresh vertices per facet, with the
 * facet normal replicated to each — which parseBinarySTL matches exactly so the
 * two encodings behave identically downstream.
 */
function parseAsciiSTL(text: string, fileName: string): ParsedMesh {
  const lines = text.trim().split('\n');

  const vertices: number[] = [];
  const normals: number[] = [];
  const indices: number[] = [];
  let vertexIndex = 0;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim().toLowerCase();

    if (line.startsWith('facet normal')) {
      const parts = line.split(/\s+/);
      const nx = parseFloat(parts[2]);
      const ny = parseFloat(parts[3]);
      const nz = parseFloat(parts[4]);

      // Read this facet's vertices, bounded by its own `endfacet` (or the start
      // of the next facet, for files missing the terminator). Scanning past the
      // boundary would let a malformed facet with <3 vertices silently absorb the
      // NEXT facet's vertices — producing a spliced triangle and shifting every
      // facet after it, with no error raised.
      const triangleVertices: number[] = [];
      let j = i + 1;
      for (; j < lines.length; j++) {
        const vLine = lines[j].trim().toLowerCase();
        if (vLine.startsWith('endfacet')) break;
        if (vLine.startsWith('facet normal')) break;
        if (vLine.startsWith('vertex')) {
          const vParts = vLine.split(/\s+/);
          triangleVertices.push(parseFloat(vParts[1]), parseFloat(vParts[2]), parseFloat(vParts[3]));
        }
      }

      if (triangleVertices.length === 9) {
        for (let k = 0; k < 9; k++) vertices.push(triangleVertices[k]);
        // Same normal for all three vertices
        normals.push(nx, ny, nz, nx, ny, nz, nx, ny, nz);
        indices.push(vertexIndex, vertexIndex + 1, vertexIndex + 2);
        vertexIndex += 3;
      }

      // Resume after the lines this facet consumed. `j` sits on the terminator or
      // on the next `facet normal`; step back one so the loop's i++ lands on it.
      i = j - 1;
    }
  }

  if (vertices.length === 0) {
    throw new Error('No mesh data found in STL file');
  }

  const vertexCount = vertices.length / 3;
  const triangleCount = indices.length / 3;

  return {
    vertices: new Float32Array(vertices),
    indices: new Uint32Array(indices),
    normals: new Float32Array(normals),
    vertexCount,
    triangleCount,
    fileName,
  };
}

/**
 * Parse a binary STL. Layout, little-endian throughout:
 *   [0, 80)   header — ignored (may be zeros, may contain text including "solid")
 *   [80, 84)  uint32 triangle count
 *   then 50 bytes per triangle:
 *     12 bytes  float32 nx ny nz   facet normal
 *     36 bytes  float32 x y z ×3   the three vertices
 *      2 bytes  uint16             attribute byte count (see color note below)
 */
function parseBinarySTL(buffer: ArrayBuffer, fileName: string): ParsedMesh {
  const view = new DataView(buffer);
  const triangleCount = view.getUint32(80, true);

  // detectStlKind already guarantees this, but a future direct caller must not be
  // able to walk off the end and get a raw "Offset is outside the bounds" error.
  const needed = 84 + 50 * triangleCount;
  if (triangleCount > MAX_STL_TRIANGLES || needed > buffer.byteLength) {
    throw new Error(
      `STL file appears to be binary but is truncated: header declares ${triangleCount} triangles ` +
        `(expects ${needed} bytes), file is ${buffer.byteLength} bytes.`,
    );
  }

  const vertexCount = triangleCount * 3;
  const vertices = new Float32Array(vertexCount * 3);
  const normals = new Float32Array(vertexCount * 3);
  const indices = new Uint32Array(triangleCount * 3);

  // The 2-byte attribute word after each triangle is unstandardized. Two dialects
  // pack RGB555 into it and disagree with each other: VisCAM reads bit 15 as "this
  // facet carries a color", SolidWorks reads it as "ignore these bits, use the
  // default" — inverted — and they order the RGB bits oppositely. So "attribute is
  // nonzero" cannot mean color: under SolidWorks, 0x0000 would make every facet
  // black. We follow VisCAM (bit 15 = valid) and require at least one facet in the
  // file to set it before reading ANY color. A file that never opts in gets no
  // vertexColors at all, which is what keeps ordinary binary STLs untinted.
  let hasColor = false;
  for (let i = 0; i < triangleCount; i++) {
    if (view.getUint16(84 + i * 50 + 48, true) & 0x8000) {
      hasColor = true;
      break;
    }
  }
  const colors = hasColor ? new Float32Array(vertexCount * 3) : undefined;

  // Tracks whether every coordinate read was finite. A comparison-based min/max
  // cannot detect this: NaN < min and NaN > max are both false, so a NaN sails
  // through the extent untouched and only surfaces later as broken bounds.
  let allFinite = true;

  for (let i = 0; i < triangleCount; i++) {
    const off = 84 + i * 50;
    const nx = view.getFloat32(off, true);
    const ny = view.getFloat32(off + 4, true);
    const nz = view.getFloat32(off + 8, true);

    let r = 1, g = 1, b = 1;
    if (colors) {
      const attr = view.getUint16(off + 48, true);
      if (attr & 0x8000) {
        r = ((attr >> 10) & 0x1f) / 31;
        g = ((attr >> 5) & 0x1f) / 31;
        b = (attr & 0x1f) / 31;
      }
    }

    for (let v = 0; v < 3; v++) {
      const src = off + 12 + v * 12;
      const x = view.getFloat32(src, true);
      const y = view.getFloat32(src + 4, true);
      const z = view.getFloat32(src + 8, true);

      if (allFinite && !(Number.isFinite(x) && Number.isFinite(y) && Number.isFinite(z))) {
        allFinite = false;
      }

      const dst = (i * 3 + v) * 3;
      vertices[dst] = x;
      vertices[dst + 1] = y;
      vertices[dst + 2] = z;
      normals[dst] = nx;
      normals[dst + 1] = ny;
      normals[dst + 2] = nz;
      if (colors) {
        colors[dst] = r;
        colors[dst + 1] = g;
        colors[dst + 2] = b;
      }
    }

    // Unwelded, matching the ASCII path: every facet owns its three vertices.
    indices[i * 3] = i * 3;
    indices[i * 3 + 1] = i * 3 + 1;
    indices[i * 3 + 2] = i * 3 + 2;
  }

  // A NaN/Inf coordinate is silent poison downstream — it breaks bounds and camera
  // framing without ever raising. The flag is accumulated in the loop above, so
  // this costs no extra pass.
  if (!allFinite) {
    throw new Error('STL file contains invalid (NaN or infinite) vertex coordinates');
  }

  const result: ParsedMesh = {
    vertices,
    indices,
    normals,
    vertexCount,
    triangleCount,
    fileName,
  };
  if (colors) result.vertexColors = colors;
  return result;
}

// Parse STL mesh format — binary or ASCII, detected from the file's own bytes.
export async function parseSTLMesh(file: File): Promise<ParsedMesh> {
  // One read serves both branches: binary reads the buffer directly, ASCII decodes
  // it as text (same shape as parsePLYMesh).
  const buffer = await file.arrayBuffer();

  if (detectStlKind(buffer, buffer.byteLength) === 'binary') {
    return parseBinarySTL(buffer, file.name);
  }

  try {
    return parseAsciiSTL(new TextDecoder().decode(buffer), file.name);
  } catch (err) {
    // Text parsing found nothing. If the header still looked like a plausible
    // binary triangle count, the file is a truncated binary STL — say so, rather
    // than leaving the user with the generic "no mesh data".
    if (buffer.byteLength >= 84) {
      const n = new DataView(buffer).getUint32(80, true);
      if (n > 0 && n <= MAX_STL_TRIANGLES) {
        throw new Error(
          `STL file appears to be binary but is truncated: header declares ${n} triangles ` +
            `(expects ${84 + 50 * n} bytes), file is ${buffer.byteLength} bytes.`,
        );
      }
    }
    throw err;
  }
}

// Sniff a PLY file's header to decide whether it carries polygon-mesh data
// (an `element face N` with N>0) versus a bare point cloud (vertices only). The
// PLY header is always ASCII text even in binary PLY, so reading the leading
// bytes is enough — we never decode the body. Returns false on any parse trouble
// so an unreadable/odd file falls back to the (default) point-cloud path.
export async function plyHasFaces(file: File): Promise<boolean> {
  try {
    // 64 KB comfortably covers any PLY header (they're tiny — a few hundred bytes).
    const head = file.slice(0, 64 * 1024);
    const text = await head.text();
    const lines = text.split('\n');
    for (const raw of lines) {
      const line = raw.trim();
      const low = line.toLowerCase();
      if (low === 'end_header') break;
      if (low.startsWith('element ')) {
        const parts = line.split(/\s+/);
        // `element face <count>` (also handle `tristrips`, another face encoding)
        if (parts.length >= 3 && (parts[1].toLowerCase() === 'face' || parts[1].toLowerCase() === 'tristrips')) {
          const count = parseInt(parts[2], 10);
          if (Number.isFinite(count) && count > 0) return true;
        }
      }
    }
  } catch {
    // fall through — treat as not-a-mesh
  }
  return false;
}

// Parse an ASCII PLY polygon mesh into geometry. This is the in-renderer fallback
// for path-less Blobs / test fixtures; path-backed files go through the backend
// importer (which also handles binary PLY). Binary PLY here throws a clear message.
export async function parsePLYMesh(file: File): Promise<ParsedMesh> {
  const buffer = await file.arrayBuffer();
  const text = new TextDecoder().decode(buffer);

  const headerEnd = text.indexOf('end_header');
  if (headerEnd === -1) throw new Error('Invalid PLY file: no end_header found');

  const header = text.substring(0, headerEnd);
  const headerLines = header.split('\n');

  let format = 'ascii';
  let vertexCount = 0;
  let faceCount = 0;
  // Track which element a `property` line belongs to as we walk the header.
  let currentElement: 'vertex' | 'face' | 'other' | null = null;
  const vertexProps: string[] = [];

  for (const line of headerLines) {
    const parts = line.trim().split(/\s+/);
    if (parts[0] === 'format') {
      format = parts[1];
    } else if (parts[0] === 'element') {
      if (parts[1] === 'vertex') {
        currentElement = 'vertex';
        vertexCount = parseInt(parts[2], 10);
      } else if (parts[1] === 'face') {
        currentElement = 'face';
        faceCount = parseInt(parts[2], 10);
      } else {
        currentElement = 'other';
      }
    } else if (parts[0] === 'property' && currentElement === 'vertex') {
      // last token is the property name (e.g. `property float x`)
      vertexProps.push(parts[parts.length - 1]);
    }
  }

  if (format !== 'ascii') {
    throw new Error('Binary PLY meshes must be imported from a file path (drag the file in or use the file picker), not from this source.');
  }
  if (vertexCount === 0) throw new Error('No vertices found in PLY file');
  if (faceCount === 0) throw new Error('No faces found in PLY file (this PLY is a point cloud, not a mesh).');

  const xIdx = vertexProps.indexOf('x');
  const yIdx = vertexProps.indexOf('y');
  const zIdx = vertexProps.indexOf('z');
  if (xIdx === -1 || yIdx === -1 || zIdx === -1) {
    throw new Error('PLY mesh must have x, y, z vertex properties');
  }
  const rIdx = vertexProps.findIndex(p => p === 'red' || p === 'r');
  const gIdx = vertexProps.findIndex(p => p === 'green' || p === 'g');
  const bIdx = vertexProps.findIndex(p => p === 'blue' || p === 'b');
  const hasColor = rIdx !== -1 && gIdx !== -1 && bIdx !== -1;

  const dataStart = headerEnd + 'end_header'.length + 1;
  const dataLines = text.substring(dataStart).split('\n');

  const vertices = new Float32Array(vertexCount * 3);
  const vertexColors = hasColor ? new Float32Array(vertexCount * 3) : undefined;

  let cursor = 0;
  // Skip leading blank lines, then read exactly vertexCount vertex rows.
  for (let v = 0; v < vertexCount; ) {
    if (cursor >= dataLines.length) throw new Error('PLY mesh truncated: not enough vertex rows');
    const row = dataLines[cursor++].trim();
    if (!row) continue;
    const values = row.split(/\s+/).map(Number);
    vertices[v * 3] = values[xIdx];
    vertices[v * 3 + 1] = values[yIdx];
    vertices[v * 3 + 2] = values[zIdx];
    if (vertexColors) {
      const r = values[rIdx];
      const g = values[gIdx];
      const b = values[bIdx];
      const scale = r > 1 || g > 1 || b > 1 ? 1 / 255 : 1;
      vertexColors[v * 3] = r * scale;
      vertexColors[v * 3 + 1] = g * scale;
      vertexColors[v * 3 + 2] = b * scale;
    }
    v++;
  }

  // Each face row is `<n> i0 i1 ... i(n-1)`; fan-triangulate n-gons.
  const faces: number[][] = [];
  for (let fRead = 0; fRead < faceCount; ) {
    if (cursor >= dataLines.length) throw new Error('PLY mesh truncated: not enough face rows');
    const row = dataLines[cursor++].trim();
    if (!row) continue;
    const tokens = row.split(/\s+/).map(Number);
    const n = tokens[0];
    if (!Number.isFinite(n) || n < 3) { fRead++; continue; }
    const idx = tokens.slice(1, 1 + n);
    for (let i = 1; i < idx.length - 1; i++) {
      faces.push([idx[0], idx[i], idx[i + 1]]);
    }
    fRead++;
  }

  if (faces.length === 0) throw new Error('No triangles found in PLY mesh');

  const indices = new Uint32Array(faces.length * 3);
  for (let i = 0; i < faces.length; i++) {
    indices[i * 3] = faces[i][0];
    indices[i * 3 + 1] = faces[i][1];
    indices[i * 3 + 2] = faces[i][2];
  }

  const result: ParsedMesh = {
    vertices,
    indices,
    vertexCount,
    triangleCount: faces.length,
    fileName: file.name,
  };
  if (vertexColors) result.vertexColors = vertexColors;
  return result;
}

// Auto-detect mesh format and parse
export async function parseMesh(file: File): Promise<ParsedMesh> {
  const ext = file.name.toLowerCase().split('.').pop();

  switch (ext) {
    case 'obj':
      return parseOBJMesh(file);
    case 'stl':
      return parseSTLMesh(file);
    case 'ply':
      return parsePLYMesh(file);
    default:
      throw new Error(`Unsupported mesh format: .${ext}. Supported: OBJ, STL, PLY`);
  }
}

// ==================== SKELETON PARSING ====================

export interface ParsedSkeleton {
  points: Float32Array;
  edges: number[][] | null;
  branchOrders: number[] | null;
  maxBranchOrder: number;
  pointCount: number;
  totalLength: number;
  fileName: string;
}

// Parse JSON skeleton format (matches our export format)
export async function parseSkeletonJSON(file: File): Promise<ParsedSkeleton> {
  const text = await file.text();
  const data = JSON.parse(text);

  // Support our exported format
  if (data.nodes && Array.isArray(data.nodes)) {
    const pointCount = data.nodes.length;
    const points = new Float32Array(pointCount * 3);
    const branchOrders: number[] = [];

    for (let i = 0; i < pointCount; i++) {
      const node = data.nodes[i];
      points[i * 3] = node.x;
      points[i * 3 + 1] = node.y;
      points[i * 3 + 2] = node.z;
      branchOrders.push(node.branchOrder || 1);
    }

    const edges = data.edges || null;
    const maxBranchOrder = data.metadata?.maxBranchOrder || Math.max(...branchOrders, 1);
    const totalLength = data.metadata?.totalLength || 0;

    return {
      points,
      edges,
      branchOrders,
      maxBranchOrder,
      pointCount,
      totalLength,
      fileName: file.name,
    };
  }

  throw new Error('Invalid skeleton JSON format. Expected { nodes: [{x, y, z, branchOrder}], edges: [[from, to]], metadata: {...} }');
}

// Parse OBJ skeleton format (lines)
export async function parseSkeletonOBJ(file: File): Promise<ParsedSkeleton> {
  const text = await file.text();
  const lines = text.trim().split('\n');

  const vertices: number[] = [];
  const edges: number[][] = [];

  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;

    const parts = trimmed.split(/\s+/);
    const cmd = parts[0];

    if (cmd === 'v') {
      vertices.push(parseFloat(parts[1]), parseFloat(parts[2]), parseFloat(parts[3]));
    } else if (cmd === 'l') {
      // Line element: l v1 v2 [v3 ...]
      for (let i = 1; i < parts.length - 1; i++) {
        edges.push([parseInt(parts[i]) - 1, parseInt(parts[i + 1]) - 1]);
      }
    }
  }

  if (vertices.length === 0) {
    throw new Error('No skeleton data found in OBJ file');
  }

  const pointCount = vertices.length / 3;

  // Calculate total length
  let totalLength = 0;
  for (const [from, to] of edges) {
    const dx = vertices[to * 3] - vertices[from * 3];
    const dy = vertices[to * 3 + 1] - vertices[from * 3 + 1];
    const dz = vertices[to * 3 + 2] - vertices[from * 3 + 2];
    totalLength += Math.sqrt(dx * dx + dy * dy + dz * dz);
  }

  return {
    points: new Float32Array(vertices),
    edges: edges.length > 0 ? edges : null,
    branchOrders: null,
    maxBranchOrder: 1,
    pointCount,
    totalLength,
    fileName: file.name,
  };
}

// Auto-detect skeleton format and parse
export async function parseSkeleton(file: File): Promise<ParsedSkeleton> {
  const ext = file.name.toLowerCase().split('.').pop();

  switch (ext) {
    case 'json':
      return parseSkeletonJSON(file);
    default:
      throw new Error(`Unsupported skeleton format: .${ext}. Supported: JSON`);
  }
}

// Check if file is likely a mesh (has faces)
export function isMeshFile(fileName: string): boolean {
  const ext = fileName.toLowerCase().split('.').pop();
  return ext === 'obj' || ext === 'stl';
}

// Check if file is likely a skeleton
export function isSkeletonFile(fileName: string): boolean {
  const ext = fileName.toLowerCase().split('.').pop();
  return ext === 'json';
}
