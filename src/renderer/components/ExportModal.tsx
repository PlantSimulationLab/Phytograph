import { useEffect, useMemo, useState } from 'react';
import { Download, FileCode, GripVertical, Loader2, Radio, X } from 'lucide-react';
import {
  lockGeometryForScanXml,
  reorderColumns,
  selectedSlugs,
  isAsciiExportFormat,
  type ExportColumn,
} from '../lib/exportColumns';

export type ExportSelectionType =
  | 'cloud'
  | 'multiCloud'
  | 'mesh'
  | 'multiMesh'
  | 'skeleton'
  | 'mixed'
  | 'none';

// One scan that can be written to a Helios scan XML (it carries scanner params).
export interface ScanExportListItem {
  id: string;
  name: string;
  hasMisses: boolean;
  selected: boolean;
}

// The columns available for the (single) selected cloud's ASCII export. Built by
// the parent from the cloud's data so the picker reflects real fields. Empty when
// no single cloud is selected (the picker hides).
export interface ExportModalProps {
  selectionType: ExportSelectionType;
  singleCloudSelected: boolean;
  // True when the single selected cloud is a scan (carries scanner params). Scans
  // are exported through the scan section, so the general point-cloud format
  // section is suppressed for them to avoid two overlapping export paths.
  cloudIsScan: boolean;
  cloudName: string;
  // Available export columns for the single selected cloud (geometry + colour +
  // scalars/labels), in default order. Used by the ASCII column picker.
  cloudColumns: ExportColumn[];
  scanExportList: ScanExportListItem[];
  // Voxel-box grids in the scene the user can add to a scan XML export so the
  // bundle round-trips (id + human label only; the parent resolves the geometry).
  gridOptions: { id: string; label: string }[];
  meshSelected: boolean;
  meshName: string;
  meshTriangleCount: number;
  // True when the single selected mesh is a DEM surface (method === 'dem'),
  // which unlocks the GIS raster export row.
  meshIsDem: boolean;
  isScanning: boolean;
  skeletonSelected: boolean;
  skeletonName: string;
  skeletonNodeCount: number;
  skeletonTotalLength: number;
  onClose: () => void;
  // Point-cloud export. For ASCII formats, `columns` is the ordered slug list the
  // user chose; for binary/structured formats it is null (fixed schema).
  onExportCloud: (
    format: 'xyz' | 'txt' | 'csv' | 'ply' | 'obj' | 'las' | 'laz',
    columns: string[] | null,
  ) => void;
  // Scan export. `scanIds` checked scans, `includeMisses`, `writeXml` (bundle vs
  // data-only), `columns` the ordered ASCII column slugs (always includes xyz),
  // `dataFormat` the per-scan file format when writeXml is false, and `gridIds`
  // the voxel-box grids to write as <grid> blocks (XML mode only; empty otherwise).
  onExportScanXml: (
    scanIds: string[], includeMisses: boolean, writeXml: boolean,
    columns: string[], dataFormat: string, gridIds: string[],
  ) => void;
  onExportMesh: (format: 'obj' | 'ply' | 'stl') => void;
  // DEM raster export (mesh.method === 'dem' only): ESRI ASCII grid or GeoTIFF.
  onExportDEMRaster: (format: 'asc' | 'tif') => void;
  onExportSkeleton: (format: 'obj' | 'ply' | 'json') => void;
  onRunScan: () => void;
}

// Per-scan data-only formats (Data only mode). ASCII formats (xyz/csv/txt) get
// the column picker; the rest use their fixed schema.
const SCAN_DATA_FORMATS = ['las', 'laz', 'ply', 'xyz', 'csv', 'txt', 'obj', 'e57'] as const;

const CLOUD_FORMATS: { id: 'las' | 'laz' | 'ply' | 'xyz' | 'csv' | 'txt' | 'obj'; label: string; title?: string }[] = [
  { id: 'las', label: 'LAS' },
  { id: 'laz', label: 'LAZ', title: 'Compressed LAS (requires backend)' },
  { id: 'ply', label: 'PLY' },
  { id: 'xyz', label: 'XYZ' },
  { id: 'csv', label: 'CSV' },
  { id: 'txt', label: 'TXT', title: 'Space-delimited with header and scalar fields' },
  { id: 'obj', label: 'OBJ' },
];

export function ExportModal({
  selectionType,
  singleCloudSelected,
  cloudIsScan,
  cloudName,
  cloudColumns,
  scanExportList,
  gridOptions,
  meshSelected,
  meshName,
  meshTriangleCount,
  meshIsDem,
  isScanning,
  skeletonSelected,
  skeletonName,
  skeletonNodeCount,
  skeletonTotalLength,
  onClose,
  onExportCloud,
  onExportDEMRaster,
  onExportScanXml,
  onExportMesh,
  onExportSkeleton,
  onRunScan,
}: ExportModalProps) {
  // ---- Point-cloud export state -------------------------------------------
  const [cloudFormat, setCloudFormat] = useState<'las' | 'laz' | 'ply' | 'xyz' | 'csv' | 'txt' | 'obj'>('las');

  // ---- Scan export state --------------------------------------------------
  const [includeMisses, setIncludeMisses] = useState(true);
  const [writeXml, setWriteXml] = useState(true);
  // Data-only output format (revealed when writeXml is false).
  const [scanDataFormat, setScanDataFormat] = useState<'las' | 'laz' | 'ply' | 'xyz' | 'csv' | 'txt' | 'obj' | 'e57'>('xyz');
  const [checkedScanIds, setCheckedScanIds] = useState<Set<string>>(new Set());
  // Grid export (XML mode only): off by default; when on, reveals a checklist of
  // the scene's voxel-box grids. An empty selection writes no <grid> blocks.
  const [exportGrid, setExportGrid] = useState(false);
  const [checkedGridIds, setCheckedGridIds] = useState<Set<string>>(new Set());
  const toggleGrid = (id: string) => setCheckedGridIds(prev => {
    const next = new Set(prev);
    if (next.has(id)) next.delete(id); else next.add(id);
    return next;
  });
  const scanListKey = useMemo(
    () => scanExportList.map(s => `${s.id}:${s.selected}`).join(','),
    [scanExportList]);
  useEffect(() => {
    const seeded = scanExportList.filter(s => s.selected).map(s => s.id);
    setCheckedScanIds(new Set(seeded.length ? seeded : scanExportList.map(s => s.id)));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [scanListKey]);
  const checkedScans = scanExportList.filter(s => checkedScanIds.has(s.id));
  const anyCheckedHasMisses = checkedScans.some(s => s.hasMisses);
  const toggleScan = (id: string) => setCheckedScanIds(prev => {
    const next = new Set(prev);
    if (next.has(id)) next.delete(id); else next.add(id);
    return next;
  });

  // ---- Column picker (ASCII formats only) ---------------------------------
  // Editable copy of the cloud's columns. Re-seeded when the cloud changes.
  const [columns, setColumns] = useState<ExportColumn[]>(cloudColumns);
  const cloudColumnsKey = useMemo(() => cloudColumns.map(c => c.slug).join(','), [cloudColumns]);
  useEffect(() => {
    setColumns(cloudColumns);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [cloudColumnsKey]);
  const [dragIdx, setDragIdx] = useState<number | null>(null);

  // For the cloud-export tab the picker follows the chosen format; for the scan
  // section it always applies (scan data is ASCII), with x/y/z locked on.
  const cloudFormatIsAscii = isAsciiExportFormat(cloudFormat);

  const toggleColumn = (slug: string) => setColumns(prev =>
    prev.map(c => (c.slug === slug && !c.required ? { ...c, selected: !c.selected } : c)));
  const handleDrop = (toIdx: number) => {
    if (dragIdx === null) return;
    setColumns(prev => reorderColumns(prev, dragIdx, toIdx));
    setDragIdx(null);
  };

  // Columns for the scan export: same picker, but geometry is locked on (a scan
  // that drops x/y/z can't be re-loaded). Misses ride via include-misses, so the
  // is_miss column is added by the backend; we don't surface it as a picker row.
  const scanColumns = useMemo(() => lockGeometryForScanXml(columns), [columns]);

  // The effective scan-export format is ASCII (so the column picker applies) when
  // writing the XML bundle (always .xyz) or when the chosen data-only format is a
  // text format. Binary/structured formats use their own fixed schema.
  const scanFormatIsAscii = writeXml || isAsciiExportFormat(scanDataFormat);

  // A compact, reusable column-picker block.
  const ColumnPicker = ({ source }: { source: ExportColumn[] }) => (
    <div className="border border-neutral-700 rounded-lg divide-y divide-neutral-700/50" data-testid="export-column-picker">
      {source.map((c, idx) => (
        <div
          key={c.slug}
          data-testid="export-column-row"
          data-slug={c.slug}
          data-selected={c.selected ? 'true' : 'false'}
          draggable
          onDragStart={() => setDragIdx(idx)}
          onDragOver={(e) => e.preventDefault()}
          onDrop={() => handleDrop(idx)}
          className={`flex items-center gap-2 px-2 py-1.5 text-xs ${
            dragIdx === idx ? 'bg-neutral-700/40' : 'hover:bg-neutral-700/30'
          }`}
        >
          <GripVertical className="w-3 h-3 text-neutral-500 cursor-grab flex-shrink-0" />
          <input
            type="checkbox"
            checked={c.selected}
            disabled={c.required}
            onChange={() => toggleColumn(c.slug)}
            className="accent-green-600"
            data-testid={`export-column-check-${c.slug}`}
          />
          <span className="flex-1 truncate text-neutral-200" title={c.slug}>{c.label}</span>
          <span className="text-[9px] uppercase tracking-wide text-neutral-500">{c.kind}</span>
        </div>
      ))}
    </div>
  );

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center" onKeyDown={(e) => e.stopPropagation()}>
      <div className="absolute inset-0 bg-black/60 backdrop-blur-sm" onClick={onClose} />

      <div
        data-testid="export-modal"
        className="relative bg-neutral-800 rounded-xl shadow-2xl border border-neutral-700 w-full max-w-3xl mx-4 overflow-hidden"
      >
        {/* Header */}
        <div className="flex items-center justify-between px-4 py-3 border-b border-neutral-700 bg-neutral-800/90">
          <div className="flex items-center gap-2 min-w-0">
            <Download className="w-4 h-4 text-neutral-400 flex-shrink-0" />
            <h2 className="text-sm font-semibold text-white">Export</h2>
          </div>
          <button onClick={onClose} className="p-1 rounded hover:bg-neutral-700 transition-colors" title="Close">
            <X className="w-4 h-4 text-neutral-400" />
          </button>
        </div>

        <div className="p-4 space-y-4 max-h-[75vh] overflow-y-auto custom-scrollbar">
          {/* ---- Point cloud export (non-scan clouds only) ---- */}
          {selectionType === 'cloud' && singleCloudSelected && !cloudIsScan && (
            <div data-testid="export-cloud-section">
              <div className="text-xs font-medium text-neutral-300 mb-2">{cloudName || 'Point cloud'}</div>
              <div className="text-[10px] text-neutral-400 mb-1">Format</div>
              <div className="flex flex-wrap gap-1 mb-3">
                {CLOUD_FORMATS.map(f => (
                  <button
                    key={f.id}
                    data-testid={`export-format-${f.id}`}
                    data-active={cloudFormat === f.id ? 'true' : 'false'}
                    title={f.title}
                    onClick={() => setCloudFormat(f.id)}
                    className={`px-3 py-1.5 rounded text-xs ${
                      cloudFormat === f.id ? 'bg-green-600 text-white' : 'bg-neutral-700 hover:bg-neutral-600 text-neutral-200'
                    }`}
                  >
                    {f.label}
                  </button>
                ))}
              </div>

              {cloudFormatIsAscii ? (
                <>
                  <div className="text-[10px] text-neutral-400 mb-1">
                    Columns (check to include, drag to reorder)
                  </div>
                  <ColumnPicker source={columns} />
                  {selectedSlugs(columns).length === 0 && (
                    <div className="text-[10px] text-amber-300 mt-1">Select at least one column.</div>
                  )}
                </>
              ) : (
                <div className="text-[10px] text-neutral-500">
                  {cloudFormat.toUpperCase()} uses a fixed column layout — its
                  standard fields (coordinates, colour{cloudFormat === 'las' || cloudFormat === 'laz' ? ', intensity, scalars as extra dimensions' : ''}) are written automatically.
                </div>
              )}

              <button
                data-testid="export-cloud-go"
                disabled={cloudFormatIsAscii && selectedSlugs(columns).length === 0}
                onClick={() => onExportCloud(
                  cloudFormat,
                  cloudFormatIsAscii ? selectedSlugs(columns) : null,
                )}
                className={`mt-3 w-full px-3 py-2 rounded text-xs flex items-center justify-center gap-1.5 ${
                  cloudFormatIsAscii && selectedSlugs(columns).length === 0
                    ? 'bg-neutral-700/50 text-neutral-500 cursor-not-allowed'
                    : 'bg-green-600 hover:bg-green-500 text-white'
                }`}
              >
                <Download className="w-3.5 h-3.5" />
                Export {cloudFormat.toUpperCase()}
              </button>
            </div>
          )}

          {/* ---- Scan export (any scans present) ---- */}
          {scanExportList.length > 0 && (
            <div data-testid="export-scan-section">
              <div className="text-xs font-medium text-neutral-300 mb-1 flex items-center gap-1.5">
                <FileCode className="w-3.5 h-3.5" />
                Scan export (one data file per scan)
              </div>
              <div className="text-[10px] text-neutral-500 mb-2">
                Choose which scan(s) to export. You pick the destination folder next.
              </div>
              <div className="max-h-32 overflow-y-auto mb-2 rounded border border-neutral-700/60 divide-y divide-neutral-700/40">
                {scanExportList.map(s => (
                  <label
                    key={s.id}
                    data-testid="export-scan-row"
                    data-scan-name={s.name}
                    data-checked={checkedScanIds.has(s.id) ? 'true' : 'false'}
                    className="flex items-center gap-2 px-2 py-1.5 text-[11px] text-neutral-200 cursor-pointer hover:bg-neutral-700/40"
                  >
                    <input type="checkbox" checked={checkedScanIds.has(s.id)} onChange={() => toggleScan(s.id)} className="accent-green-600" />
                    <span className="truncate flex-1" title={s.name}>{s.name}</span>
                    {s.hasMisses && <span className="text-[9px] text-neutral-500" title="Carries sky/miss points">misses</span>}
                  </label>
                ))}
              </div>

              {/* Output mode: re-loadable Helios bundle (XML + per-scan .xyz) or
                  plain per-scan data files in a format you choose. */}
              <div className="text-[10px] text-neutral-400 mb-1">Output</div>
              <div className="grid grid-cols-2 gap-1 mb-2" data-testid="export-scan-mode">
                <button
                  data-testid="export-scan-mode-xml" data-active={writeXml ? 'true' : 'false'}
                  onClick={() => setWriteXml(true)}
                  title="Helios XML metadata + one .xyz data file per scan — re-loadable as a scan."
                  className={`px-2 py-1.5 rounded text-[11px] ${writeXml ? 'bg-green-600 text-white' : 'bg-neutral-700 hover:bg-neutral-600 text-neutral-200'}`}
                >XML + data</button>
                <button
                  data-testid="export-scan-mode-data" data-active={!writeXml ? 'true' : 'false'}
                  onClick={() => setWriteXml(false)}
                  title="One data file per scan in the format you pick below (no XML)."
                  className={`px-2 py-1.5 rounded text-[11px] ${!writeXml ? 'bg-green-600 text-white' : 'bg-neutral-700 hover:bg-neutral-600 text-neutral-200'}`}
                >Data only</button>
              </div>

              {/* Data-only reveals the per-scan file format. XML mode always
                  writes Helios .xyz, so no format chooser there. */}
              {!writeXml && (
                <>
                  <div className="text-[10px] text-neutral-400 mb-1">Format</div>
                  <div className="flex flex-wrap gap-1 mb-2" data-testid="export-scan-format">
                    {SCAN_DATA_FORMATS.map(f => (
                      <button
                        key={f}
                        data-testid={`export-scan-format-${f}`}
                        data-active={scanDataFormat === f ? 'true' : 'false'}
                        onClick={() => setScanDataFormat(f)}
                        className={`px-2.5 py-1 rounded text-[11px] ${
                          scanDataFormat === f ? 'bg-green-600 text-white' : 'bg-neutral-700 hover:bg-neutral-600 text-neutral-200'
                        }`}
                      >{f.toUpperCase()}</button>
                    ))}
                  </div>
                </>
              )}

              {/* Column picker — applies whenever the effective data format is
                  ASCII (XML mode is always .xyz; data-only when an ASCII format is
                  chosen). x/y/z are locked on. Binary/structured formats use their
                  own fixed schema, so the picker is hidden for them. */}
              {scanFormatIsAscii && (
                <>
                  <div className="text-[10px] text-neutral-400 mb-1">Columns (x/y/z required)</div>
                  <ColumnPicker source={scanColumns} />
                </>
              )}

              <label
                className={`flex items-center gap-2 text-[11px] my-2 ${anyCheckedHasMisses ? 'text-neutral-200 cursor-pointer' : 'text-neutral-500 cursor-not-allowed'}`}
                title={anyCheckedHasMisses ? 'Write the sky/miss points (and the is_miss column).' : 'None of the checked scans carry sky/miss points.'}
              >
                <input
                  type="checkbox" data-testid="export-scan-include-misses"
                  checked={includeMisses && anyCheckedHasMisses} disabled={!anyCheckedHasMisses}
                  onChange={(e) => setIncludeMisses(e.target.checked)} className="accent-green-600"
                />
                Include miss points
              </label>

              {/* Export grid — XML mode only. Lets the user add scene voxel-box
                  grids as <grid> blocks so a bundle like sphere.xml round-trips.
                  Hidden in Data-only mode and when the scene has no grids. */}
              {writeXml && gridOptions.length > 0 && (
                <>
                  <label className="flex items-center gap-2 text-[11px] my-2 text-neutral-200 cursor-pointer">
                    <input
                      type="checkbox" data-testid="export-grid-toggle"
                      checked={exportGrid}
                      onChange={(e) => setExportGrid(e.target.checked)}
                      className="accent-green-600"
                    />
                    Export grid
                  </label>
                  {exportGrid && (
                    <div
                      data-testid="export-grid-list"
                      className="max-h-32 overflow-y-auto mb-2 rounded border border-neutral-700/60 divide-y divide-neutral-700/40"
                    >
                      {gridOptions.map(g => (
                        <label
                          key={g.id}
                          data-testid="export-grid-row"
                          data-grid-label={g.label}
                          data-checked={checkedGridIds.has(g.id) ? 'true' : 'false'}
                          className="flex items-center gap-2 px-2 py-1.5 text-[11px] text-neutral-200 cursor-pointer hover:bg-neutral-700/40"
                        >
                          <input
                            type="checkbox"
                            data-testid={`export-grid-check-${g.id}`}
                            checked={checkedGridIds.has(g.id)}
                            onChange={() => toggleGrid(g.id)}
                            className="accent-green-600"
                          />
                          <span className="truncate flex-1" title={g.label}>{g.label}</span>
                        </label>
                      ))}
                    </div>
                  )}
                </>
              )}

              <button
                data-testid="export-scan-xml"
                onClick={() => onExportScanXml(
                  [...checkedScanIds], includeMisses && anyCheckedHasMisses, writeXml,
                  scanFormatIsAscii ? selectedSlugs(scanColumns) : ['x', 'y', 'z'],
                  writeXml ? 'xyz' : scanDataFormat,
                  exportGrid && writeXml ? [...checkedGridIds] : [],
                )}
                disabled={checkedScans.length === 0}
                className={`w-full px-2 py-2 rounded text-xs flex items-center justify-center gap-1.5 ${
                  checkedScans.length > 0 ? 'bg-green-600 hover:bg-green-500 text-white' : 'bg-neutral-700/50 text-neutral-500 cursor-not-allowed'
                }`}
              >
                <FileCode className="w-3.5 h-3.5" />
                {writeXml ? 'Export XML + data' : `Export ${scanDataFormat.toUpperCase()}`}{checkedScans.length > 1 ? ` (${checkedScans.length})` : ''}
              </button>
            </div>
          )}

          {/* ---- Mesh export ---- */}
          {selectionType === 'mesh' && meshSelected && (
            <div data-testid="export-mesh-section">
              <div className="text-xs font-medium text-neutral-300">{meshName}</div>
              <div className="text-[10px] text-neutral-500 mb-2">{meshTriangleCount.toLocaleString()} triangles</div>
              <div className="grid grid-cols-3 gap-1">
                {(['obj', 'ply', 'stl'] as const).map(f => (
                  <button key={f} data-testid={`export-mesh-${f}`} onClick={() => onExportMesh(f)}
                    className="px-2 py-1.5 bg-neutral-700 hover:bg-neutral-600 rounded text-xs text-neutral-200">{f.toUpperCase()}</button>
                ))}
              </div>
              {meshIsDem && (
                <div data-testid="export-dem-raster" className="mt-2">
                  <div className="text-[10px] text-neutral-500 mb-1">GIS raster (elevation grid)</div>
                  <div className="grid grid-cols-2 gap-1">
                    <button data-testid="export-dem-asc" onClick={() => onExportDEMRaster('asc')}
                      title="ESRI ASCII grid (.asc)"
                      className="px-2 py-1.5 bg-neutral-700 hover:bg-neutral-600 rounded text-xs text-neutral-200">ASC</button>
                    <button data-testid="export-dem-tif" onClick={() => onExportDEMRaster('tif')}
                      title="GeoTIFF (.tif)"
                      className="px-2 py-1.5 bg-neutral-700 hover:bg-neutral-600 rounded text-xs text-neutral-200">GeoTIFF</button>
                  </div>
                </div>
              )}
              <button onClick={onRunScan} disabled={isScanning}
                className="mt-2 w-full px-2 py-1.5 bg-blue-600 hover:bg-blue-500 disabled:bg-neutral-600 disabled:cursor-not-allowed rounded text-xs text-white flex items-center justify-center gap-1.5">
                {isScanning ? <><Loader2 className="w-3 h-3 animate-spin" />Scanning…</> : <><Radio className="w-3 h-3" />Synthetic LiDAR Scan</>}
              </button>
            </div>
          )}

          {/* ---- Skeleton export ---- */}
          {selectionType === 'skeleton' && skeletonSelected && (
            <div data-testid="export-skeleton-section">
              <div className="text-xs font-medium text-neutral-300">{skeletonName || 'Skeleton'}</div>
              <div className="text-[10px] text-neutral-500 mb-2">{skeletonNodeCount} nodes · {skeletonTotalLength.toFixed(2)}m</div>
              <div className="grid grid-cols-3 gap-1">
                {(['obj', 'ply', 'json'] as const).map(f => (
                  <button key={f} onClick={() => onExportSkeleton(f)}
                    className="px-2 py-1.5 bg-neutral-700 hover:bg-neutral-600 rounded text-xs text-neutral-200">{f.toUpperCase()}</button>
                ))}
              </div>
            </div>
          )}

          {/* ---- Nothing exportable ---- */}
          {!(selectionType === 'cloud' && singleCloudSelected)
            && selectionType !== 'mesh' && selectionType !== 'skeleton'
            && scanExportList.length === 0 && (
            <div className="text-[11px] text-neutral-500 text-center py-4">
              {selectionType === 'none'
                ? 'Select an object to export.'
                : 'Nothing in this selection can be exported here. Select a single cloud, mesh, or skeleton — or a scan with parameters.'}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
