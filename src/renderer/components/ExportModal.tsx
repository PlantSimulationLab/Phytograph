import { useEffect, useMemo, useState } from 'react';
import { Download, FileCode, GripVertical, X } from 'lucide-react';
import {
  lockFixedDimsForLas,
  lockGeometryForScanXml,
  reorderColumns,
  selectedSlugs,
  supportsColumnSelection,
  usesFixedColumnOrder,
  type ExportColumn,
} from '../lib/exportColumns';
import {
  blockedReason,
  effectiveCheckedIds,
  exportBaseName,
  mergeCheckedIntent,
  objectDetailLine,
  plannedFileNames,
  seedCheckedIds,
  selectableIds,
  type ExportObjectItem,
} from '../lib/exportObjects';
import { ObjectPicker } from './ObjectPicker';

export type ExportSelectionType =
  | 'cloud'
  | 'multiCloud'
  | 'mesh'
  | 'multiMesh'
  | 'skeleton'
  | 'mixed'
  | 'none';

// One row of the object list. Re-exported from the pure rules module so the
// parent has one place to import the shape from.
export type { ExportObjectItem } from '../lib/exportObjects';

// The Export window. It opens on the scene's full object list; what the user
// CHECKS there decides which controls render — a single plain cloud gets the
// per-cloud format list, anything else gets the batch writer — and the two are
// mutually exclusive, so only ever one column picker is on screen.
export interface ExportModalProps {
  selectionType: ExportSelectionType;
  // True when what's selected in the scene is a mesh/skeleton rather than any
  // cloud. Only affects the INITIAL check state (see seedCheckedIds): the object
  // list itself always shows every cloud in the scene.
  sceneSelectionHasNonCloud: boolean;
  // Available export columns for a given cloud id (geometry + colour + scalars/
  // labels), in default order. `null` asks for the representative set used by the
  // multi-object column picker. Called per render for the checked object, so the
  // parent should keep it stable (useCallback).
  getExportColumns: (cloudId: string | null) => ExportColumn[];
  // EVERY point cloud in the scene, with whether the panel selection had it and
  // why (if at all) the XML / PTX outputs can't write it.
  exportObjects: ExportObjectItem[];
  // Voxel-box grids in the scene the user can add to a scan XML export so the
  // bundle round-trips (id + human label only; the parent resolves the geometry).
  gridOptions: { id: string; label: string }[];
  meshSelected: boolean;
  meshName: string;
  meshTriangleCount: number;
  // True when the single selected mesh is a DEM surface (method === 'dem'),
  // which unlocks the GIS raster export row.
  meshIsDem: boolean;
  skeletonSelected: boolean;
  skeletonName: string;
  skeletonNodeCount: number;
  skeletonTotalLength: number;
  onClose: () => void;
  // Point-cloud export. For the formats that take a column selection (text +
  // PLY), `columns` is the ordered slug list the user chose; for the fixed-schema
  // formats it is null.
  onExportCloud: (
    format: 'xyz' | 'txt' | 'csv' | 'ply' | 'asc' | 'pts' | 'pcd' | 'las' | 'laz',
    columns: string[] | null,
    cloudId: string,
  ) => void;
  // Batch export. `scanIds` the checked objects, `includeMisses`, `writeXml` (bundle vs
  // data-only), `columns` the ordered ASCII column slugs (always includes xyz),
  // `dataFormat` the per-scan file format when writeXml is false, `gridIds`
  // the voxel-box grids to write as <grid> blocks (XML mode only; empty otherwise),
  // and `baseName` the name every written file is built from (the window owns it,
  // because it is also what the file-name preview is computed from — the parent
  // only asks for a destination FOLDER).
  onExportScanXml: (
    scanIds: string[], includeMisses: boolean, writeXml: boolean,
    columns: string[], dataFormat: string, gridIds: string[], baseName: string,
  ) => void;
  onExportMesh: (format: 'obj' | 'ply' | 'stl') => void;
  // DEM raster export (mesh.method === 'dem' only): ESRI ASCII grid or GeoTIFF.
  onExportDEMRaster: (format: 'asc' | 'tif') => void;
  onExportSkeleton: (format: 'obj' | 'ply' | 'json') => void;
}

// Per-scan data-only formats (Data only mode). The text formats (xyz/csv/txt)
// and PLY get the column picker; the rest use their fixed schema.
//
// OBJ is deliberately absent — see CLOUD_FORMATS.
const SCAN_DATA_FORMATS = ['las', 'laz', 'ply', 'xyz', 'csv', 'txt', 'asc', 'pts', 'pcd', 'e57', 'ptx'] as const;
export type ScanDataFormat = typeof SCAN_DATA_FORMATS[number];

// OBJ is deliberately NOT offered for point clouds, though the backend writers
// still accept it (`_write_scan_to_bytes`, `_text_export_layout`) so an existing
// scripted /api/pointcloud/export call keeps working. Three reasons it was a bad
// choice in the UI, all of them one-way doors for the user:
//   * It cannot be read back. `.obj` is not a point-cloud import format at all —
//     `isMeshFile()` routes it to the mesh parser unconditionally, so exporting a
//     cloud as OBJ and re-importing yields a FACE-LESS MESH, not the cloud. It
//     was the only cloud format Phytograph could not round-trip.
//   * It is lossy in a way no sibling is. A `v` line takes exactly x/y/z, so
//     colour, intensity and every scalar are dropped — which is why it was the
//     one format excluded from the column picker.
//   * XYZ dominates it: the same information, smaller, and re-importable. For
//     getting points into Blender/MeshLab, PLY is offered and is the better fit.
const CLOUD_FORMATS: { id: 'las' | 'laz' | 'ply' | 'xyz' | 'csv' | 'txt' | 'asc' | 'pts' | 'pcd'; label: string; title?: string }[] = [
  { id: 'las', label: 'LAS' },
  { id: 'laz', label: 'LAZ', title: 'Compressed LAS (requires backend)' },
  { id: 'ply', label: 'PLY' },
  { id: 'xyz', label: 'XYZ' },
  { id: 'csv', label: 'CSV' },
  { id: 'txt', label: 'TXT', title: 'Space-delimited with header and scalar fields' },
  { id: 'asc', label: 'ASC', title: 'Bare whitespace-separated ASCII, no header line' },
  { id: 'pts', label: 'PTS', title: 'Leica PTS: point-count line, then x y z intensity r g b (fixed order)' },
  { id: 'pcd', label: 'PCD', title: 'PCL Point Cloud Data (ASCII) — position and colour only' },
];

export function ExportModal({
  selectionType,
  sceneSelectionHasNonCloud,
  getExportColumns,
  exportObjects,
  gridOptions,
  meshSelected,
  meshName,
  meshTriangleCount,
  meshIsDem,
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
}: ExportModalProps) {
  // ---- Point-cloud export state -------------------------------------------
  const [cloudFormat, setCloudFormat] = useState<'las' | 'laz' | 'ply' | 'xyz' | 'csv' | 'txt' | 'asc' | 'pts' | 'pcd'>('las');

  // ---- Scan export state --------------------------------------------------
  const [includeMisses, setIncludeMisses] = useState(true);
  const [writeXml, setWriteXml] = useState(true);
  // Data-only output format (revealed when writeXml is false).
  const [scanDataFormat, setScanDataFormat] = useState<ScanDataFormat>('xyz');
  const [checkedScanIds, setCheckedScanIds] = useState<Set<string>>(new Set());
  // Base name for the written files. Seeded from the checked objects and left
  // alone once the user types: the seed follows the selection, their text does
  // not get overwritten by it.
  const [baseNameDraft, setBaseNameDraft] = useState<string | null>(null);
  // Grid export (XML mode only): off by default; when on, reveals a checklist of
  // the scene's voxel-box grids. An empty selection writes no <grid> blocks.
  const [exportGrid, setExportGrid] = useState(false);
  const [checkedGridIds, setCheckedGridIds] = useState<Set<string>>(new Set());
  const toggleGrid = (id: string) => setCheckedGridIds(prev => {
    const next = new Set(prev);
    if (next.has(id)) next.delete(id); else next.add(id);
    return next;
  });
  const objectListKey = useMemo(
    () => exportObjects.map(o => `${o.id}:${o.selected}`).join(','),
    [exportObjects]);
  useEffect(() => {
    setCheckedScanIds(seedCheckedIds(exportObjects, sceneSelectionHasNonCloud));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [objectListKey, sceneSelectionHasNonCloud]);

  // A Helios XML bundle is only meaningful when something checked is actually a
  // scan, so the XML toggle stands down when it isn't — otherwise importing one
  // plain cloud and hitting Export would land in a mode that can't write it and
  // show a "blocked" note instead of the format list. `writeXml` stays the
  // user's intent; `xmlMode` is what the UI and the submit actually use.
  const anyCheckedIsScan = exportObjects.some(o => checkedScanIds.has(o.id) && o.isScan);
  const xmlMode = writeXml && anyCheckedIsScan;

  // `checkedScanIds` is the user's INTENT — it may include rows the current
  // output can't write (a plain cloud while XML mode is on). `effectiveIds` is
  // what actually gets exported, and what the controls below are sized to.
  const mode = useMemo(
    () => ({ writeXml: xmlMode, dataFormat: scanDataFormat }), [xmlMode, scanDataFormat]);
  const selectable = useMemo(
    () => selectableIds(exportObjects, mode), [exportObjects, mode]);
  const effectiveIds = useMemo(
    () => effectiveCheckedIds(exportObjects, checkedScanIds, mode),
    [exportObjects, checkedScanIds, mode]);
  const effectiveIdSet = useMemo(() => new Set(effectiveIds), [effectiveIds]);
  const checkedScans = exportObjects.filter(o => effectiveIdSet.has(o.id));
  const anyCheckedHasMisses = checkedScans.some(s => s.hasMisses);
  // Objects the user checked that this mode has to skip — worth saying out loud,
  // because the alternative is an Export button that quietly writes fewer files
  // than the list implies (or none at all).
  const blockedCheckedCount = exportObjects.filter(
    o => checkedScanIds.has(o.id) && !!blockedReason(o, mode)).length;

  // The single-cloud section and the batch controls are mutually exclusive: one
  // checked cloud with no scanner parameters goes through the richer per-cloud
  // path (its own format list, its own destination filename); anything else —
  // several objects, or a scan — goes through the batch writer.
  const soleCheckedObject = effectiveIds.length === 1
    ? exportObjects.find(o => o.id === effectiveIds[0]) ?? null
    : null;
  const singleCloudMode = !!soleCheckedObject && !soleCheckedObject.isScan;

  // The name every written file is built from, and the exact list of files it
  // produces. The batch export writes MANY files from ONE typed name, so the
  // window shows the resulting names before the user commits to a folder —
  // otherwise "myscan" reads as a promise of a file called myscan.
  const seededBaseName = checkedScans.length === 1
    ? exportBaseName(checkedScans[0].name)
    : 'scans';
  const baseName = baseNameDraft ?? seededBaseName;
  const scanExt = xmlMode ? 'xyz' : scanDataFormat;
  const plannedNames = useMemo(
    () => plannedFileNames(checkedScans.map(o => o.name), baseName, scanExt, xmlMode),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [checkedScans.map(o => o.name).join('\u0000'), baseName, scanExt, xmlMode]);

  const pickerItems = useMemo(
    () => exportObjects.map(o => ({
      id: o.id,
      label: o.name,
      detail: objectDetailLine(o),
      disabledReason: blockedReason(o, mode),
    })),
    [exportObjects, mode]);

  // ---- Column picker (formats that take a column selection) ---------------
  // Editable copy of the cloud's columns. Re-seeded when the cloud changes.
  // The columns on offer follow whichever object the picker is describing: the
  // sole checked cloud in single-cloud mode, else the representative set the
  // parent picks for a multi-object export (`null`).
  const columnSourceId = singleCloudMode ? soleCheckedObject!.id : null;
  const cloudColumns = useMemo(
    () => getExportColumns(columnSourceId), [getExportColumns, columnSourceId]);
  const [columns, setColumns] = useState<ExportColumn[]>(cloudColumns);
  const cloudColumnsKey = useMemo(
    () => `${columnSourceId ?? ''}|${cloudColumns.map(c => c.slug).join(',')}`,
    [columnSourceId, cloudColumns]);
  useEffect(() => {
    setColumns(cloudColumns);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [cloudColumnsKey]);
  const [dragIdx, setDragIdx] = useState<number | null>(null);

  // Every cloud format on offer takes a column selection (PLY names each column
  // as a `property`; LAS/LAZ declare each scalar as a named extra dimension).
  const cloudFormatTakesColumns = supportsColumnSelection(cloudFormat);
  // LAS/LAZ store dimensions by name in the header, so the row ORDER is not
  // meaningful there — the picker drops its drag affordance for them.
  const cloudFormatIsOrdered = !usesFixedColumnOrder(cloudFormat);
  const cloudIsLas = cloudFormat === 'las' || cloudFormat === 'laz';

  // Columns for a LAS/LAZ export: the standard dimensions it cannot omit
  // (x/y/z, intensity) are forced on and locked; colour and scalars stay
  // selectable. Mirrors `scanColumns` below.
  const lasColumns = useMemo(() => lockFixedDimsForLas(columns), [columns]);
  // The list the cloud picker actually renders/submits for the chosen format.
  const activeCloudColumns = cloudIsLas ? lasColumns : columns;

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

  // The scan column picker applies when writing the XML bundle (always .xyz) or
  // when the chosen data-only format takes a selection — which is everything the
  // scan writer offers except E57 and PTX (each has its own fixed schema). The
  // scan backend already filters its scalar set by the requested columns for
  // every format, LAS/LAZ included.
  const scanFormatTakesColumns = xmlMode || supportsColumnSelection(scanDataFormat);
  const scanFormatIsOrdered = xmlMode || !usesFixedColumnOrder(scanDataFormat);
  // PTX emits every cell of the scan raster, so "include misses" is inert for it
  // (an excluded miss is written as the same empty-cell sentinel).
  const ptxSelected = !xmlMode && scanDataFormat === 'ptx';
  const missesEnabled = anyCheckedHasMisses && !ptxSelected;
  // LAS/LAZ scan data: lock intensity as well as geometry (see lockFixedDimsForLas).
  const activeScanColumns = useMemo(
    () => (!xmlMode && usesFixedColumnOrder(scanDataFormat)
      ? lockFixedDimsForLas(scanColumns)
      : scanColumns),
    [xmlMode, scanDataFormat, scanColumns]);

  // A compact, reusable column-picker block. `orderable` is false for formats
  // that store columns by name rather than positionally (LAS/LAZ): the drag
  // affordance is dropped rather than left as a control that does nothing.
  const ColumnPicker = ({
    source, orderable = true,
  }: { source: ExportColumn[]; orderable?: boolean }) => (
    <div className="border border-neutral-700 rounded-lg divide-y divide-neutral-700/50" data-testid="export-column-picker">
      {source.map((c, idx) => (
        <div
          key={c.slug}
          data-testid="export-column-row"
          data-slug={c.slug}
          data-selected={c.selected ? 'true' : 'false'}
          data-locked={c.required ? 'true' : 'false'}
          draggable={orderable}
          onDragStart={orderable ? () => setDragIdx(idx) : undefined}
          onDragOver={orderable ? (e) => e.preventDefault() : undefined}
          onDrop={orderable ? () => handleDrop(idx) : undefined}
          className={`flex items-center gap-2 px-2 py-1.5 text-xs ${
            orderable && dragIdx === idx ? 'bg-neutral-700/40' : 'hover:bg-neutral-700/30'
          }`}
        >
          {orderable
            ? <GripVertical className="w-3 h-3 text-neutral-500 cursor-grab flex-shrink-0" />
            : <span className="w-3 flex-shrink-0" />}
          <input
            type="checkbox"
            checked={c.selected}
            disabled={c.required}
            onChange={() => toggleColumn(c.slug)}
            className="accent-green-600"
            data-testid={`export-column-check-${c.slug}`}
            title={c.required ? 'This field cannot be omitted in this format' : undefined}
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
          {/* ---- Object list ----
              Every point cloud in the scene, whether or not it carries scanner
              parameters and whether or not it is selected in the Scans panel —
              the panel selection only decides what starts CHECKED. What's
              checked then decides which controls appear below: a lone plain
              cloud gets the per-cloud format list (its own destination
              filename), anything else gets the batch writer. */}
          {exportObjects.length > 0 && (
            <div data-testid="export-object-list-section">
              <ObjectPicker
                data-testid="export-object-list"
                rowTestId="export-scan-row"
                label="Objects"
                items={pickerItems}
                selectedIds={effectiveIdSet}
                onChange={(next) => setCheckedScanIds(
                  prev => mergeCheckedIntent(prev, next, selectable))}
              />
              {blockedCheckedCount > 0 && (
                <div data-testid="export-scan-blocked-note" className="text-[10px] text-amber-300 mt-1">
                  {blockedCheckedCount} checked object{blockedCheckedCount === 1 ? '' : 's'} can't be
                  written as {xmlMode ? 'a Helios scan XML' : scanDataFormat.toUpperCase()} — switch
                  output to{xmlMode ? ' Data only' : ' another format'} to include{' '}
                  {blockedCheckedCount === 1 ? 'it' : 'them'}.
                </div>
              )}
            </div>
          )}

          {/* ---- Point cloud export (exactly one checked cloud, no scanner params) ---- */}
          {singleCloudMode && (
            <div data-testid="export-cloud-section">
              <div className="text-xs font-medium text-neutral-300 mb-2">{soleCheckedObject!.name || 'Point cloud'}</div>
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

              {cloudFormatTakesColumns ? (
                <>
                  <div className="text-[10px] text-neutral-400 mb-1">
                    {cloudFormatIsOrdered
                      ? 'Columns (check to include, drag to reorder)'
                      : 'Fields (check to include)'}
                  </div>
                  <ColumnPicker source={activeCloudColumns} orderable={cloudFormatIsOrdered} />
                  {/* LAS/LAZ: state the two limits that are real rather than
                      implying the whole schema is fixed. Scalars ARE freely
                      omittable (each is a declared extra dimension); x/y/z and
                      intensity are not (both live in the core point record, so
                      deselecting intensity could only zero it). Dropping RGB is a
                      genuine omission — it selects point format 1. */}
                  {cloudIsLas && (
                    <div
                      className="text-[10px] text-neutral-500 mt-1"
                      data-testid="export-las-schema-note"
                    >
                      Each scalar is written as a named LAS extra dimension, so any
                      of them can be left out. X/Y/Z and intensity are part of every
                      LAS point record and cannot be removed. Field order is not
                      stored — LAS identifies dimensions by name.
                    </div>
                  )}
                  {selectedSlugs(activeCloudColumns).length === 0 && (
                    <div className="text-[10px] text-amber-300 mt-1">Select at least one column.</div>
                  )}
                </>
              ) : (
                /* Unreachable today: every format in CLOUD_FORMATS takes a column
                   selection, now that OBJ (the one that could not — a `v` line is
                   exactly x/y/z) is no longer offered for point clouds. Kept as
                   the branch a fixed-schema format would land in if one is added
                   back; `cloudFormatTakesColumns` still gates the picker. */
                <div className="text-[10px] text-neutral-500" data-testid="export-fixed-schema-note">
                  This format writes a fixed set of fields — colour and scalars
                  cannot be chosen. Use PLY, LAS or CSV to keep them.
                </div>
              )}

              <button
                data-testid="export-cloud-go"
                disabled={cloudFormatTakesColumns && selectedSlugs(activeCloudColumns).length === 0}
                onClick={() => onExportCloud(
                  cloudFormat,
                  cloudFormatTakesColumns ? selectedSlugs(activeCloudColumns) : null,
                  soleCheckedObject!.id,
                )}
                className={`mt-3 w-full px-3 py-2 rounded text-xs flex items-center justify-center gap-1.5 ${
                  cloudFormatTakesColumns && selectedSlugs(activeCloudColumns).length === 0
                    ? 'bg-neutral-700/50 text-neutral-500 cursor-not-allowed'
                    : 'bg-green-600 hover:bg-green-500 text-white'
                }`}
              >
                <Download className="w-3.5 h-3.5" />
                Export {cloudFormat.toUpperCase()}
              </button>
            </div>
          )}

          {/* ---- Batch export (anything but a lone plain cloud) ----
              One file per checked object, written into a folder you pick next.
              Mutually exclusive with the single-cloud section above: exactly one
              of the two renders, so there is never a second column picker or a
              second Export button on screen. */}
          {exportObjects.length > 0 && !singleCloudMode && (
            <div data-testid="export-scan-section">
              <div className="text-xs font-medium text-neutral-300 mb-1 flex items-center gap-1.5">
                <FileCode className="w-3.5 h-3.5" />
                Export objects (one file per object)
              </div>
              <div className="text-[10px] text-neutral-500 mb-2">
                Writes one data file per checked object, into a folder you choose below.
              </div>

              {/* Output mode: re-loadable Helios bundle (XML + per-scan .xyz) or
                  plain per-object data files in a format you choose. */}
              <div className="text-[10px] text-neutral-400 mb-1">Output</div>
              <div className="grid grid-cols-2 gap-1 mb-2" data-testid="export-scan-mode">
                <button
                  data-testid="export-scan-mode-xml" data-active={xmlMode ? 'true' : 'false'}
                  onClick={() => setWriteXml(true)}
                  disabled={!anyCheckedIsScan}
                  title={anyCheckedIsScan
                    ? 'Helios XML metadata + one .xyz data file per scan — re-loadable as a scan.'
                    : 'A Helios scan XML needs scanner parameters — none of the checked objects have any.'}
                  className={`px-2 py-1.5 rounded text-[11px] ${
                    xmlMode
                      ? 'bg-green-600 text-white'
                      : anyCheckedIsScan
                        ? 'bg-neutral-700 hover:bg-neutral-600 text-neutral-200'
                        : 'bg-neutral-700/50 text-neutral-500 cursor-not-allowed'}`}
                >XML + data</button>
                <button
                  data-testid="export-scan-mode-data" data-active={!xmlMode ? 'true' : 'false'}
                  onClick={() => setWriteXml(false)}
                  title="One data file per scan in the format you pick below (no XML)."
                  className={`px-2 py-1.5 rounded text-[11px] ${!xmlMode ? 'bg-green-600 text-white' : 'bg-neutral-700 hover:bg-neutral-600 text-neutral-200'}`}
                >Data only</button>
              </div>

              {/* Data-only reveals the per-scan file format. XML mode always
                  writes Helios .xyz, so no format chooser there. */}
              {!xmlMode && (
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

              {/* Column picker — applies to every data format except E57 and PTX
                  (XML mode is always .xyz). x/y/z are always locked on: a scan
                  that drops geometry can't be re-loaded. For LAS/LAZ, intensity is
                  locked too (it is in every LAS point record) and order is not
                  stored, so the drag affordance is dropped. */}
              {scanFormatTakesColumns && (
                <>
                  <div className="text-[10px] text-neutral-400 mb-1">
                    {scanFormatIsOrdered ? 'Columns (x/y/z required)' : 'Fields (x/y/z required)'}
                  </div>
                  <ColumnPicker source={activeScanColumns} orderable={scanFormatIsOrdered} />
                </>
              )}

              {/* PTX always writes the COMPLETE raster, so a cell with no return is
                  recorded as the empty sentinel whether or not misses are
                  "included" — the toggle can't change a byte. Say so rather than
                  leaving a live-looking control the backend ignores. */}
              {ptxSelected && (
                <div data-testid="export-scan-ptx-note" className="text-[10px] text-neutral-400 my-2">
                  PTX writes the full scan grid; cells with no return are recorded as
                  empty, which is how they come back as sky/miss points on re-import.
                </div>
              )}

              <label
                className={`flex items-center gap-2 text-[11px] my-2 ${missesEnabled ? 'text-neutral-200 cursor-pointer' : 'text-neutral-500 cursor-not-allowed'}`}
                title={ptxSelected
                  ? 'PTX always writes every grid cell, so this makes no difference to the file.'
                  : anyCheckedHasMisses ? 'Write the sky/miss points (and the is_miss column).' : 'None of the checked scans carry sky/miss points.'}
              >
                <input
                  type="checkbox" data-testid="export-scan-include-misses"
                  checked={includeMisses && missesEnabled} disabled={!missesEnabled}
                  onChange={(e) => setIncludeMisses(e.target.checked)} className="accent-green-600"
                />
                Include miss points
              </label>

              {/* Export grid — XML mode only. Lets the user add scene voxel-box
                  grids as <grid> blocks so a bundle like sphere.xml round-trips.
                  Hidden in Data-only mode and when the scene has no grids. */}
              {xmlMode && gridOptions.length > 0 && (
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

              {/* Base name + the exact files it produces. The old flow sent the
                  user straight to a native Save panel, which names ONE file and
                  so misrepresented every multi-object export: the file it
                  offered to save was never the file that got written. The name
                  is typed here, the preview says what will land on disk, and the
                  button asks only for a folder. */}
              <div className="text-[10px] text-neutral-400 mb-1">Base name</div>
              <input
                type="text"
                data-testid="export-base-name"
                value={baseName}
                onChange={e => setBaseNameDraft(e.target.value)}
                placeholder={seededBaseName}
                spellCheck={false}
                className="w-full px-2 py-1.5 mb-2 rounded text-[11px] bg-neutral-900 border border-neutral-700 text-neutral-100 focus:outline-none focus:border-green-600"
              />
              <div
                className="text-[10px] text-neutral-500 mb-2"
                data-testid="export-file-preview"
                data-file-count={plannedNames.length}
              >
                <div className="text-neutral-400 mb-0.5">
                  Will write {plannedNames.length} file{plannedNames.length === 1 ? '' : 's'}:
                </div>
                {plannedNames.slice(0, 3).map(n => (
                  <div key={n} data-testid="export-file-preview-name" className="font-mono truncate" title={n}>{n}</div>
                ))}
                {plannedNames.length > 3 && (
                  <div className="text-neutral-600">+{plannedNames.length - 3} more</div>
                )}
              </div>

              <button
                data-testid="export-scan-xml"
                onClick={() => onExportScanXml(
                  effectiveIds, includeMisses && anyCheckedHasMisses, xmlMode,
                  scanFormatTakesColumns ? selectedSlugs(activeScanColumns) : ['x', 'y', 'z'],
                  xmlMode ? 'xyz' : scanDataFormat,
                  exportGrid && xmlMode ? [...checkedGridIds] : [],
                  baseName,
                )}
                disabled={checkedScans.length === 0}
                className={`w-full px-2 py-2 rounded text-xs flex items-center justify-center gap-1.5 ${
                  checkedScans.length > 0 ? 'bg-green-600 hover:bg-green-500 text-white' : 'bg-neutral-700/50 text-neutral-500 cursor-not-allowed'
                }`}
              >
                <FileCode className="w-3.5 h-3.5" />
                {xmlMode ? 'Choose folder & export XML + data' : `Choose folder & export ${scanDataFormat.toUpperCase()}`}{checkedScans.length > 1 ? ` (${checkedScans.length})` : ''}
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
                    {/* "ASC grid", not "ASC": the cloud format list also offers an
                        ASC now, and though the two never render for the same object
                        (this row is DEM-mesh only), one window with two differently
                        -meaning ASC buttons is a needless ambiguity. This one is a
                        raster elevation GRID; that one is a point list. */}
                    <button data-testid="export-dem-asc" onClick={() => onExportDEMRaster('asc')}
                      title="ESRI ASCII raster grid (.asc) — an elevation grid, not a point list"
                      className="px-2 py-1.5 bg-neutral-700 hover:bg-neutral-600 rounded text-xs text-neutral-200">ASC grid</button>
                    <button data-testid="export-dem-tif" onClick={() => onExportDEMRaster('tif')}
                      title="GeoTIFF (.tif)"
                      className="px-2 py-1.5 bg-neutral-700 hover:bg-neutral-600 rounded text-xs text-neutral-200">GeoTIFF</button>
                  </div>
                </div>
              )}
            </div>
          )}

          {/* ---- Skeleton export ---- */}
          {selectionType === 'skeleton' && skeletonSelected && (
            <div data-testid="export-skeleton-section">
              <div className="text-xs font-medium text-neutral-300">{skeletonName || 'Skeleton'}</div>
              <div className="text-[10px] text-neutral-500 mb-2">{skeletonNodeCount} nodes · {skeletonTotalLength.toFixed(2)}m</div>
              <div className="grid grid-cols-3 gap-1">
                {(['obj', 'ply', 'json'] as const).map(f => (
                  <button key={f} data-testid={`export-skeleton-${f}`} onClick={() => onExportSkeleton(f)}
                    className="px-2 py-1.5 bg-neutral-700 hover:bg-neutral-600 rounded text-xs text-neutral-200">{f.toUpperCase()}</button>
                ))}
              </div>
            </div>
          )}

          {/* ---- Nothing exportable ----
              The object list covers every cloud in the scene, so this now only
              fires for a genuinely empty scene (or one holding only a mesh /
              skeleton that isn't the current selection). */}
          {exportObjects.length === 0
            && selectionType !== 'mesh' && selectionType !== 'skeleton' && (
            <div className="text-[11px] text-neutral-500 text-center py-4">
              {selectionType === 'none'
                ? 'Nothing to export yet — import a point cloud, or select a mesh or skeleton.'
                : 'Nothing in this selection can be exported here. Select a cloud, mesh, or skeleton.'}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
