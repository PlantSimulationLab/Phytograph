import * as THREE from 'three';
import type { PointCloudData, ScalarField } from './pointCloudTypes';
import {
  importPointCloudByPath,
  importPointCloudLasLaz,
  createCloudSession,
  type OctreeMetadata,
  type ColumnPlan,
  type ScanParamsFromFile,
} from '../utils/backendApi';

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
const OCTREE_PATH_EXTENSIONS = new Set(['xyz', 'txt', 'csv', 'pts', 'asc', 'ply', 'pcd', 'las', 'laz', 'e57']);

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
      path, asciiFormat ?? null, columnPlan ?? null, worldShift ?? null, missDistanceThreshold ?? null,
    );
    return buildPointCloudFromOctree(
      meta, path, name, asciiFormat, columnPlan, categoricalAttributes, meta.session_id,
      meta.world_shift ?? null, continuousAttributes,
    );
  }

  if (BACKEND_PATH_EXTENSIONS.has(ext)) {
    const result = await importPointCloudByPath(path, asciiFormat ?? null, columnPlan ?? null, worldShift ?? null);
    return buildPointCloudFromBackend(result, name);
  }

  const buf = await window.electronAPI.fs.readBinary(path);
  const file = new File([buf], name);
  return parsePointCloud(file);
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
export function buildPointCloudFromOctree(
  meta: OctreeMetadata,
  sourceXyzPath: string,
  fileName: string,
  asciiFormat?: string | null,
  columnPlan?: ColumnPlan | null,
  categoricalAttributes?: string[],
  sessionId?: string | null,
  worldShift?: [number, number, number] | null,
  continuousAttributes?: string[],
): PointCloudData {
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
    if (Array.isArray(a.min) && Array.isArray(a.max)) {
      attributeRanges[a.name] = { min: a.min, max: a.max };
    }
    if (a.label) {
      attributeLabels[a.name] = a.label;
    }
  }

  return {
    // No flat arrays — the OctreePointCloud renderer reads from the
    // octree directly. An empty Float32Array satisfies the type without
    // consuming heap on a multi-gigabyte source.
    positions: new Float32Array(0),
    pointCount: meta.point_count,
    bounds: { min, max, center, size },
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
      // Sky/miss info comes from the cloud-session create response (a superset
      // of OctreeMetadata); plain OctreeMetadata callers leave these undefined.
      hasMisses: 'has_misses' in meta ? Boolean((meta as { has_misses?: boolean }).has_misses) : undefined,
      scanOrigin: 'scan_origin' in meta
        ? ((meta as { scan_origin?: [number, number, number] }).scan_origin ?? null)
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

    default:
      // Try XYZ parser as fallback
      try {
        return await parseXYZ(file);
      } catch {
        throw new Error(`Unsupported file format: .${ext}. Supported formats: LAS, PLY, PCD, XYZ, TXT, CSV, PTS, ASC`);
      }
  }
}

// Export supported formats for UI - organized by type
export const POINT_CLOUD_FORMATS = [
  { ext: '.las', name: 'LAS', desc: 'LiDAR Data Exchange' },
  { ext: '.laz', name: 'LAZ', desc: 'Compressed LiDAR' },
  { ext: '.e57', name: 'E57', desc: 'Structured scan (recovers sky/miss)' },
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
  { ext: '.stl', name: 'STL', desc: 'Stereolithography (ASCII)' },
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

// Parse STL mesh format (ASCII)
export async function parseSTLMesh(file: File): Promise<ParsedMesh> {
  const text = await file.text();
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

      // Read the three vertices
      const triangleVertices: number[] = [];
      for (let j = i + 1; j < lines.length && triangleVertices.length < 9; j++) {
        const vLine = lines[j].trim().toLowerCase();
        if (vLine.startsWith('vertex')) {
          const vParts = vLine.split(/\s+/);
          triangleVertices.push(parseFloat(vParts[1]), parseFloat(vParts[2]), parseFloat(vParts[3]));
        }
      }

      if (triangleVertices.length === 9) {
        vertices.push(...triangleVertices);
        // Same normal for all three vertices
        normals.push(nx, ny, nz, nx, ny, nz, nx, ny, nz);
        indices.push(vertexIndex, vertexIndex + 1, vertexIndex + 2);
        vertexIndex += 3;
      }
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
    fileName: file.name,
  };
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
