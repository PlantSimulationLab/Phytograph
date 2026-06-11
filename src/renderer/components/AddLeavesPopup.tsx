import { useState, useEffect, useMemo, useCallback } from 'react';
import { X, Leaf, Upload } from 'lucide-react';
import {
  QSMLeavesRequest,
  CURATED_LEAF_TEXTURES,
  detectPhyllotaxis,
  getLeafTextures,
} from '../utils/backendApi';
import type { QSMEntry } from '../lib/pointCloudTypes';

interface AddLeavesPopupProps {
  isOpen: boolean;
  onClose: () => void;
  qsm: QSMEntry | null;
  onAddLeaves: (qsmId: string, request: QSMLeavesRequest) => void;
}

// Texture source: a curated builtin name, an uploaded PNG path, or an uploaded
// OBJ path. The request carries exactly one (precedence obj > png > builtin).
type TexSource =
  | { mode: 'builtin'; name: string }
  | { mode: 'png'; path: string }
  | { mode: 'obj'; path: string };

const baseName = (p: string) => p.split(/[\\/]/).pop() || p;

export function AddLeavesPopup({ isOpen, onClose, qsm, onAddLeaves }: AddLeavesPopupProps) {
  // Numeric leaf parameters (kept as strings for clean typing UX).
  const [spacingStr, setSpacingStr] = useState('0.05');
  const [pitchStr, setPitchStr] = useState('45');
  const [sizeStr, setSizeStr] = useState('0.08');
  const [phyllotaxisStr, setPhyllotaxisStr] = useState('137.5');
  const [leavesPerNodeStr, setLeavesPerNodeStr] = useState('1');

  const [texSource, setTexSource] = useState<TexSource>({ mode: 'builtin', name: CURATED_LEAF_TEXTURES[0] });
  const [textures, setTextures] = useState<string[]>(CURATED_LEAF_TEXTURES);

  const [detecting, setDetecting] = useState(false);
  const [detectInfo, setDetectInfo] = useState<{ pattern: string; confidence: number } | null>(null);
  const [error, setError] = useState<string | null>(null);

  // On open: load the curated texture list and auto-detect the phyllotaxis from
  // the QSM's branching geometry, pre-filling the (editable) angle + leaves/node.
  useEffect(() => {
    if (!isOpen || !qsm) return;
    let cancelled = false;
    setError(null);
    setDetectInfo(null);
    void getLeafTextures().then((list) => {
      if (!cancelled && list.length) setTextures(list);
    });
    setDetecting(true);
    void detectPhyllotaxis(qsm.cylinders, qsm.shoots)
      .then((res) => {
        if (cancelled) return;
        if (res.success) {
          setPhyllotaxisStr(String(res.angle_deg));
          setLeavesPerNodeStr(String(res.leaves_per_node));
          setDetectInfo({ pattern: res.pattern, confidence: res.confidence });
        }
      })
      .catch(() => { /* keep defaults if detection fails */ })
      .finally(() => { if (!cancelled) setDetecting(false); });
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isOpen, qsm?.id]);

  // Estimate the leaf count, mirroring the backend: every shoot is leafed only on
  // its distal stretch — from the furthest-out child fork to the tip (the whole
  // shoot if it has no children) — so the bare tip beyond a mid-shoot branch is
  // counted, but the older wood below the forks is not.
  const estimatedLeaves = useMemo(() => {
    if (!qsm) return 0;
    const spacing = Math.max(1e-4, parseFloat(spacingStr) || 0.05);
    const perNode = Math.max(1, parseInt(leavesPerNodeStr, 10) || 1);
    const byId = new Map(qsm.cylinders.map((c) => [c.cyl_id, c]));
    const shootById = new Map(qsm.shoots.map((s) => [s.shoot_id, s]));
    const len = (a: number[], b: number[]) =>
      Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);
    let total = 0;
    for (const s of qsm.shoots) {
      if (s.cylinder_ids.length === 0) continue;
      // Cumulative arc length at the end of each cylinder (base->tip order).
      const endArc = new Map<number, number>();
      let cum = 0;
      for (const cid of s.cylinder_ids) {
        const c = byId.get(cid);
        if (c) cum += len(c.start, c.end);
        endArc.set(cid, cum);
      }
      const shootLen = cum;
      // Distal-most fork = max end-arc among cylinders a child attaches to.
      let start = 0;
      for (const childId of s.child_shoot_ids) {
        const child = shootById.get(childId);
        const forkArc = child ? endArc.get(child.parent_cyl_id) : undefined;
        if (forkArc !== undefined && forkArc > start) start = forkArc;
      }
      const leafable = Math.max(0, shootLen - start);
      total += (Math.floor(leafable / spacing) + 1) * perNode;
    }
    return total;
  }, [qsm, spacingStr, leavesPerNodeStr]);

  const handlePickPng = useCallback(async () => {
    const picked = await window.electronAPI.dialog.open({
      title: 'Choose leaf texture image',
      filters: [{ name: 'Leaf texture (PNG)', extensions: ['png'] }],
    });
    if (!picked) return;
    const path = Array.isArray(picked) ? picked[0] : picked;
    setTexSource({ mode: 'png', path });
  }, []);

  const handlePickObj = useCallback(async () => {
    const picked = await window.electronAPI.dialog.open({
      title: 'Choose leaf OBJ model',
      filters: [{ name: 'Leaf model (OBJ)', extensions: ['obj'] }],
    });
    if (!picked) return;
    const path = Array.isArray(picked) ? picked[0] : picked;
    setTexSource({ mode: 'obj', path });
  }, []);

  const handleSubmit = useCallback(() => {
    if (!qsm) return;
    setError(null);

    const request: QSMLeavesRequest = {
      cylinders: qsm.cylinders,
      shoots: qsm.shoots,
      leaf_spacing: parseFloat(spacingStr) || 0.05,
      leaf_pitch_deg: parseFloat(pitchStr) || 45,
      leaf_size_m: parseFloat(sizeStr) || 0.08,
      phyllotaxis_deg: parseFloat(phyllotaxisStr) || 137.5,
      leaves_per_node: Math.max(1, parseInt(leavesPerNodeStr, 10) || 1),
    };
    if (texSource.mode === 'obj') request.obj_path = texSource.path;
    else if (texSource.mode === 'png') request.texture_path = texSource.path;
    else request.builtin_texture_name = texSource.name;

    onAddLeaves(qsm.id, request);
    onClose();
  }, [qsm, spacingStr, pitchStr, sizeStr, phyllotaxisStr, leavesPerNodeStr, texSource, onAddLeaves, onClose]);

  if (!isOpen || !qsm) return null;

  const numCls =
    'w-full px-2 py-1.5 bg-neutral-700 border border-neutral-600 rounded text-xs text-white focus:outline-none focus:ring-1 focus:ring-green-500/50';

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center"
      onKeyDown={(e) => e.stopPropagation()}
    >
      <div className="absolute inset-0 bg-black/60 backdrop-blur-sm" onClick={onClose} />

      <div data-testid="add-leaves-popup" className="relative bg-neutral-800 rounded-xl shadow-2xl border border-neutral-700 w-full max-w-md mx-4 overflow-hidden">
        <div className="flex items-center justify-between px-4 py-3 border-b border-neutral-700 bg-neutral-800/90">
          <div className="flex items-center gap-2">
            <Leaf className="w-4 h-4 text-green-400" />
            <h2 className="text-sm font-semibold text-white">Add Leaves to QSM</h2>
          </div>
          <button onClick={onClose} className="p-1 rounded hover:bg-neutral-700 transition-colors">
            <X className="w-4 h-4 text-neutral-400" />
          </button>
        </div>

        <div className="p-4 space-y-4 max-h-[72vh] overflow-y-auto">
          <p className="text-[10px] text-neutral-500">
            Leaves are placed on the terminal shoots (last year&apos;s growth) following
            the phyllotaxis below.
          </p>

          {/* Leaf geometry / texture source */}
          <div>
            <label className="text-xs font-medium text-neutral-300 block mb-1">Leaf geometry</label>
            <div className="flex items-center gap-2">
              <select
                data-testid="add-leaves-texture-select"
                value={texSource.mode === 'builtin' ? texSource.name : ''}
                onChange={(e) => setTexSource({ mode: 'builtin', name: e.target.value })}
                className={numCls + ' flex-1'}
              >
                {texSource.mode !== 'builtin' && (
                  <option value="">
                    {texSource.mode === 'obj' ? `OBJ: ${baseName(texSource.path)}` : `PNG: ${baseName(texSource.path)}`}
                  </option>
                )}
                {textures.map((t) => (
                  <option key={t} value={t}>{t.replace(/\.png$/i, '')}</option>
                ))}
              </select>
              <button
                onClick={handlePickPng}
                title="Upload a leaf PNG"
                className="px-2 py-1.5 text-[10px] bg-neutral-700 hover:bg-neutral-600 border border-neutral-600 rounded text-neutral-200 flex items-center gap-1"
              >
                <Upload className="w-3 h-3" /> PNG
              </button>
              <button
                onClick={handlePickObj}
                title="Upload a leaf OBJ"
                className="px-2 py-1.5 text-[10px] bg-neutral-700 hover:bg-neutral-600 border border-neutral-600 rounded text-neutral-200 flex items-center gap-1"
              >
                <Upload className="w-3 h-3" /> OBJ
              </button>
            </div>
            {texSource.mode !== 'builtin' && (
              <p className="text-[9px] text-green-400/80 mt-1" data-testid="add-leaves-upload-label">
                Using uploaded {texSource.mode.toUpperCase()}: {baseName(texSource.path)}
              </p>
            )}
          </div>

          {/* Numeric parameters */}
          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="text-[10px] text-neutral-400 block mb-1">Leaf spacing (m)</label>
              <input data-testid="add-leaves-spacing" type="number" value={spacingStr}
                onChange={(e) => setSpacingStr(e.target.value)} step="0.01" min="0.005" className={numCls} />
            </div>
            <div>
              <label className="text-[10px] text-neutral-400 block mb-1">Leaf size (m)</label>
              <input data-testid="add-leaves-size" type="number" value={sizeStr}
                onChange={(e) => setSizeStr(e.target.value)} step="0.01" min="0.005" className={numCls} />
            </div>
            <div>
              <label className="text-[10px] text-neutral-400 block mb-1">Leaf pitch (°)</label>
              <input data-testid="add-leaves-pitch" type="number" value={pitchStr}
                onChange={(e) => setPitchStr(e.target.value)} step="5" min="0" max="90" className={numCls} />
              <p className="text-[9px] text-neutral-500 mt-0.5">From the shoot axis (90° = straight out)</p>
            </div>
            <div>
              <label className="text-[10px] text-neutral-400 block mb-1">Leaves per node</label>
              <input data-testid="add-leaves-pernode" type="number" value={leavesPerNodeStr}
                onChange={(e) => setLeavesPerNodeStr(e.target.value)} step="1" min="1" max="6" className={numCls} />
            </div>
          </div>

          {/* Phyllotaxis (auto-detected, editable) */}
          <div className="border-t border-neutral-700 pt-3">
            <label className="text-[10px] text-neutral-400 block mb-1">Phyllotactic angle (°)</label>
            <input data-testid="add-leaves-phyllotaxis" type="number" value={phyllotaxisStr}
              onChange={(e) => setPhyllotaxisStr(e.target.value)} step="0.5" min="0" max="180" className={numCls} />
            <p className="text-[9px] text-neutral-500 mt-0.5" data-testid="add-leaves-phyllo-hint">
              {detecting
                ? 'Auto-detecting from branch geometry…'
                : detectInfo
                  ? `Auto-detected: ${detectInfo.pattern} · confidence ${(detectInfo.confidence * 100).toFixed(0)}% (editable)`
                  : 'Common values: 137.5° spiral, 180° opposite, 90° decussate'}
            </p>
          </div>

          {error && (
            <div className="p-2 bg-red-900/30 border border-red-600/50 rounded text-[10px] text-red-300">{error}</div>
          )}
        </div>

        <div className="px-4 py-3 border-t border-neutral-700 bg-neutral-800/90 flex items-center justify-between">
          <span className="text-[10px] text-neutral-500" data-testid="add-leaves-estimate">
            ~{estimatedLeaves.toLocaleString()} leaves
          </span>
          <button
            data-testid="add-leaves-submit"
            onClick={handleSubmit}
            className="px-4 py-2 text-xs rounded font-medium flex items-center gap-2 bg-green-600 hover:bg-green-500 text-white"
          >
            <Leaf className="w-3.5 h-3.5" /> Add Leaves
          </button>
        </div>
      </div>
    </div>
  );
}
