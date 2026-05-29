import type { PointCloudData } from './pointCloudTypes';
import type { ScanParameters } from './scanParameters';

// A Scan is the user-facing unit: it may have point data, scan parameters,
// both, or — transiently during construction — neither. `hasData` and
// `hasParams` predicates drive every conditional render and analysis gate.
//
// `sourcePath` is the on-disk path the data was loaded from (when known),
// used by the backend `file_path` field so we don't have to ship the raw
// points in the request body.

export interface Scan {
  id: string;
  label: string;
  visible: boolean;
  color: string;
  data?: PointCloudData;
  params?: ScanParameters;
  sourcePath?: string;
  // Helios <ASCII_format> hint preserved from XML import so the backend
  // can re-parse the file (e.g. for crop-by-path) with the same column
  // layout. Null/undefined falls back to backend auto-detection, which
  // covers the legacy 6/7-column conventions but may misread a file
  // that uses non-default column ordering.
  asciiFormat?: string | null;
}

export function hasData(scan: Scan): scan is Scan & { data: PointCloudData } {
  return scan.data != null;
}

export function hasParams(scan: Scan): scan is Scan & { params: ScanParameters } {
  return scan.params != null;
}

export function scanDisplayName(scan: Scan): string {
  if (scan.label) return scan.label;
  if (scan.data?.fileName) return scan.data.fileName;
  return 'Untitled scan';
}

export type { ScanParameters } from './scanParameters';
