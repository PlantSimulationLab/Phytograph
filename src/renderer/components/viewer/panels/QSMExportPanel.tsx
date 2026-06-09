import { useState } from 'react';
import { Download, Loader2, X } from 'lucide-react';
import type { QSMExportFormat } from '../../../lib/qsmExport';

// Modal export dialog for QSMs. The user picks a format, then a folder (native
// dialog, triggered by the parent's onExport), and which QSMs to write. One file
// is written per selected QSM into the chosen folder.
//
// Presentational: the parent (PointCloudViewer) owns the QSM data and the actual
// save-to-disk. This component only collects the format + selection.
export interface QSMExportItem {
  id: string;
  label: string;
  cylinderCount: number;
}

interface QSMExportPanelProps {
  qsms: QSMExportItem[];
  exporting: boolean;
  onClose: () => void;
  onExport: (qsmIds: string[], format: QSMExportFormat) => void;
}

const FORMATS: { key: QSMExportFormat; label: string; title: string }[] = [
  { key: 'csv', label: 'CSV', title: 'SimpleForest-compatible cylinder table (rTwig / aRchi)' },
  { key: 'obj', label: 'OBJ', title: 'Cylinder mesh for Blender / CloudCompare / MeshLab' },
  { key: 'ply', label: 'PLY', title: 'Cylinder mesh with per-face branch order + radius' },
];

export function QSMExportPanel({ qsms, exporting, onClose, onExport }: QSMExportPanelProps) {
  const [format, setFormat] = useState<QSMExportFormat>('csv');
  const [selected, setSelected] = useState<Set<string>>(() => new Set(qsms.map(q => q.id)));

  const allSelected = qsms.length > 0 && selected.size === qsms.length;

  const toggle = (id: string) => {
    setSelected(prev => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const toggleAll = () => {
    setSelected(allSelected ? new Set() : new Set(qsms.map(q => q.id)));
  };

  return (
    <div className="absolute inset-0 bg-black/50 backdrop-blur-sm flex items-center justify-center z-50">
      <div
        data-testid="qsm-export-panel"
        className="bg-neutral-800 rounded-lg p-4 shadow-xl w-80 max-w-[90vw] max-h-[80vh] flex flex-col"
      >
        <div className="flex items-center justify-between mb-3">
          <div className="text-sm font-medium text-neutral-200 flex items-center gap-2">
            <Download className="w-4 h-4" />
            Export QSM
          </div>
          <button onClick={onClose} className="p-1 hover:bg-neutral-700 rounded">
            <X className="w-3 h-3 text-neutral-400" />
          </button>
        </div>

        {/* Format selector */}
        <div className="text-[10px] font-medium text-neutral-400 mb-1">Format</div>
        <div className="grid grid-cols-3 gap-1 mb-4">
          {FORMATS.map(f => (
            <button
              key={f.key}
              data-testid={`qsm-export-format-${f.key}`}
              title={f.title}
              onClick={() => setFormat(f.key)}
              className={`px-2 py-1.5 rounded text-xs transition-colors ${
                format === f.key
                  ? 'bg-green-600 text-white'
                  : 'bg-neutral-700 hover:bg-neutral-600 text-neutral-200'
              }`}
            >
              {f.label}
            </button>
          ))}
        </div>

        {/* QSM selection */}
        <div className="flex items-center justify-between mb-1">
          <div className="text-[10px] font-medium text-neutral-400">
            QSMs ({selected.size}/{qsms.length})
          </div>
          <button
            data-testid="qsm-export-select-all"
            onClick={toggleAll}
            className="text-[10px] text-green-400 hover:text-green-300"
          >
            {allSelected ? 'Select none' : 'Select all'}
          </button>
        </div>
        <div className="overflow-y-auto flex-1 min-h-0 border border-neutral-700 rounded mb-4 divide-y divide-neutral-700/50">
          {qsms.map(q => (
            <label
              key={q.id}
              className="flex items-center gap-2 px-2 py-1.5 hover:bg-neutral-700/40 cursor-pointer"
            >
              <input
                type="checkbox"
                data-testid={`qsm-export-checkbox-${q.id}`}
                checked={selected.has(q.id)}
                onChange={() => toggle(q.id)}
                className="accent-green-600"
              />
              <div className="flex-1 min-w-0">
                <div className="text-xs text-neutral-200 truncate">{q.label}</div>
                <div className="text-[10px] text-neutral-500">{q.cylinderCount} cyl</div>
              </div>
            </label>
          ))}
        </div>

        {/* Footer */}
        <div className="flex gap-2 justify-end">
          <button
            onClick={onClose}
            className="px-3 py-1.5 text-xs bg-neutral-700 hover:bg-neutral-600 text-neutral-200 rounded transition-colors"
          >
            Cancel
          </button>
          <button
            data-testid="qsm-export-confirm"
            disabled={selected.size === 0 || exporting}
            onClick={() => onExport([...selected], format)}
            className="px-3 py-1.5 text-xs bg-green-600 hover:bg-green-500 disabled:bg-neutral-600 disabled:cursor-not-allowed text-white rounded transition-colors flex items-center gap-1.5"
          >
            {exporting ? (
              <>
                <Loader2 className="w-3 h-3 animate-spin" />
                Exporting…
              </>
            ) : (
              'Export'
            )}
          </button>
        </div>
      </div>
    </div>
  );
}
