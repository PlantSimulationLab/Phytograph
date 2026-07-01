import { useState, useCallback, useMemo, useEffect } from 'react';
import { X, Grid3x3 } from 'lucide-react';
import { LADRequest } from '../utils/backendApi';
import type { GridOption } from '../lib/gridOption';
import type { HeliosGrid, GThetaOverrideSpec, GThetaValueSpec, DeWitDistribution } from '../utils/backendApi';
import type { Scan } from '../lib/scan';
import type { MeshData } from '../lib/pointCloudTypes';
import { hasData, hasParams, isBackfillEligible } from '../lib/scan';
import { isMovingScan } from '../lib/scanParameters';
import { buildLADRequest, extractReuseMeshPayload, type ReuseMeshPayload } from '../lib/pointCloudHelpers';
import { InfoHint } from './InfoHint';

// The canonical de Wit leaf-inclination distributions, with short descriptions
// for the dropdown. Order matches the backend's GThetaValueSpec.dewit literal.
const DEWIT_OPTIONS: { value: DeWitDistribution; label: string }[] = [
  { value: 'spherical', label: 'Spherical (random) — G ≈ 0.5' },
  { value: 'planophile', label: 'Planophile (mostly horizontal)' },
  { value: 'erectophile', label: 'Erectophile (mostly vertical)' },
  { value: 'plagiophile', label: 'Plagiophile (mostly oblique ~45°)' },
  { value: 'extremophile', label: 'Extremophile (horizontal + vertical)' },
  { value: 'uniform', label: 'Uniform (flat across inclinations)' },
];

// An existing Helios triangulation the user can REUSE. Selecting it locks the
// inversion to the same scans + grid + lmax/aspect that produced the mesh, and
// injects that exact mesh into the inversion (no re-triangulation).
export interface LADTriangulationOption {
  id: string;        // mesh id
  label: string;     // mesh display name
  grid: HeliosGrid;  // the grid this mesh was triangulated in
  scanIds: string[]; // the scans fused into it, in the mesh's scan-index order
  lmax: number;
  maxAspectRatio: number;
  // The UNFILTERED mesh geometry (carries triEdgeMax/triAspect so the current
  // lmax/aspect filter can be re-applied here). extractReuseMeshPayload turns it
  // into the vertices/indices/scan-id buffers sent to the backend for injection.
  meshData: MeshData;
  // The voxel-box mesh (if still in the scene) whose volume matches this grid.
  // Reusing this triangulation hides that box so its faces don't z-fight the LAD
  // voxel result. Undefined when the box was deleted/resized away.
  gridMeshId?: string;
}

// A triangulation that CANNOT be reused for LAD, with a user-facing reason and a
// hint at the fix. Rendered as a disabled option in the triangulation dropdown so
// the user sees why their mesh is absent and what to do — rather than it silently
// not appearing. Currently only ball-pivot meshes that fall short of the
// per-scan + scan-position + pinned-to-grid eligibility rule.
export interface IneligibleTriangulation {
  id: string;
  label: string;
  reason: string;  // short phrase, e.g. "merged — re-triangulate per-scan"
}

// A DEM the user can select as the terrain surface for a terrain-following grid.
// `demGrid` is the elevation raster carried on a DEM MeshEntry (origin in display
// coords + worldShift); demGridToLADRaster converts it to the wire raster.
export interface DEMGridOption {
  id: string;        // mesh id of the DEM
  label: string;     // mesh display name
  demGrid: {
    z: Float32Array; nx: number; ny: number; cellSize: number;
    origin: [number, number]; worldShift: [number, number, number];
  };
}

interface LADPopupProps {
  isOpen: boolean;
  onClose: () => void;
  // `scanColors` is aligned 1:1 with `request.scans` (same order).
  // `gridMeshId` is the id of the voxel-box mesh used as the grid (a GridOption
  // id is its mesh id), so the caller can auto-hide that box once the LAD result
  // — which occupies the same space — is shown, avoiding z-fighting. When the
  // user reuses an existing triangulation, the grid lives on that mesh (not a
  // voxel box), so there's nothing to auto-hide → pass ''.
  // `reuseMesh` is the injected triangulation payload when the user reused an
  // existing Helios mesh (null for a fresh run). When present the request is sent
  // as a binary frame carrying the mesh, and the backend injects it instead of
  // re-triangulating.
  // `newTri` is set ONLY on the static "run new triangulation" path: instead of
  // letting the backend re-triangulate internally at a fixed Lmax, the caller
  // runs a real Helios triangulation first (Otsu-estimated Lmax, mesh added to
  // the Meshes pane), then reuses that mesh for the inversion — so the user can
  // see and refine the surface G(theta) was computed on. It carries the source
  // scans + grid + the dialog's Lmax/aspect (the triangulation seeds its own
  // Otsu default but honours an explicit override). Null/absent for the
  // reuse-existing-mesh and moving-platform paths.
  onStartLAD: (request: LADRequest, scanColors: string[], gridMeshId: string,
               reuseMesh: ReuseMeshPayload | null,
               newTri?: { scans: Scan[]; grid: HeliosGrid; gridMeshId: string;
                          // Undefined Lmax = Auto (Otsu estimate seeds the mesh);
                          // a value forces that edge length.
                          lmax?: number; maxAspectRatio: number } | null) => void;
  scans: Scan[];
  initialSelectedIds?: Set<string>;
  // Voxel boxes available as the LAD grid. LAD REQUIRES one — when empty (and no
  // triangulation is reused) the compute button is disabled and the user is told
  // to create a voxel box.
  gridOptions?: GridOption[];
  // Existing triangulations the user can reuse instead of running a new one.
  // Reusing one locks the scans, grid, and lmax/aspect to that mesh.
  triangulationOptions?: LADTriangulationOption[];
  // Triangulations that exist but can't be reused (e.g. a merged or unpinned
  // ball-pivot mesh), shown as disabled dropdown entries explaining why.
  ineligibleTriangulations?: IneligibleTriangulation[];
  // Pre-fill Lmax / max aspect ratio from the filter the user dialed in on a
  // Helios triangulation mesh, so the inversion bakes in that filtering. Still
  // editable here. Omitted → fall back to the standard defaults.
  defaultLmax?: number;
  defaultMaxAspectRatio?: number;
  // Invoked when the user clicks "Backfill Misses" in the in-modal banner (a
  // selected scan has no misses yet). Closes the modal and runs the backfill for
  // the recoverable scans, then reopens LAD with the same scan selection once it
  // finishes. `selectedIds` is the modal's current selection so the reopened
  // popup restores it exactly. Omitted → the banner shows the requirement but
  // offers no in-place action.
  onBackfill?: (recoverableIds: string[], selectedIds: Set<string>) => void;
}

// Per-voxel leaf area density setup. Models HeliosTriangulationPopup but the
// voxel grid is mandatory (it's the basis of the LAD calculation, not just a
// bounding region) and there is no auto-grid fallback. Lmax/aspect feed the
// triangulation that produces the G-function; min_voxel_hits gates which
// voxels are solved. Return type is derived from each scan's own parameters.
export function LADPopup({
  isOpen,
  onClose,
  onStartLAD,
  scans,
  initialSelectedIds,
  gridOptions = [],
  triangulationOptions = [],
  ineligibleTriangulations = [],
  defaultLmax,
  defaultMaxAspectRatio,
  onBackfill,
}: LADPopupProps) {
  const eligible = useMemo(() => scans.filter(s => hasData(s) && hasParams(s)), [scans]);
  const [selectedScanIds, setSelectedScanIds] = useState<Set<string>>(new Set());

  // Triangulation mode: '' = run a new triangulation (pick scans + grid + params
  // below); otherwise the id of an existing Helios mesh to REUSE (its scans,
  // grid, and lmax/aspect are locked, reproducing that mesh's G-function).
  const [reuseTriId, setReuseTriId] = useState<string>('');
  useEffect(() => {
    if (!isOpen) return;
    // Default to reusing the first compatible triangulation when one exists
    // (re-triangulating is wasteful when an eligible mesh is already on hand);
    // fall back to '' (run a new triangulation) only when none are available.
    setReuseTriId(prev =>
      triangulationOptions.some(t => t.id === prev)
        ? prev
        : (triangulationOptions[0]?.id ?? ''));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isOpen, triangulationOptions]);
  // G(θ) source (declared early so reuseTri can fold to null in supplied mode).
  // 'triangulation' = derive G(θ) from a mesh; 'supplied' = prescribe it directly.
  const [gthetaSource, setGthetaSource] = useState<'triangulation' | 'supplied'>('triangulation');
  // A reused triangulation is meaningful only on the triangulation path; in
  // supplied-G(θ) mode no mesh is used, so fold it to null for all UI gating.
  const reuseTri = useMemo(
    () => (gthetaSource === 'supplied'
      ? null
      : triangulationOptions.find(t => t.id === reuseTriId) ?? null),
    [gthetaSource, triangulationOptions, reuseTriId],
  );

  // Which voxel box drives the grid. Default to the first available box;
  // empty string means "none selected" → cannot compute.
  const [selectedGridId, setSelectedGridId] = useState<string>('');
  useEffect(() => {
    if (!isOpen) return;
    setSelectedGridId(prev =>
      gridOptions.some(g => g.id === prev) ? prev : (gridOptions[0]?.id ?? ''),
    );
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isOpen, gridOptions]);
  const selectedGrid = useMemo(
    () => gridOptions.find(g => g.id === selectedGridId) ?? null,
    [gridOptions, selectedGridId],
  );

  // Terrain following is now done by "Snap to ground" on the grid mesh itself
  // (Meshes panel): the snapped grid carries authoritative per-column offsets that
  // ride into the HeliosGrid here, so the inversion follows the terrain the user
  // sees. The old in-dialog DEM picker is gone — the grid is the source of truth.
  const gridIsSnapped = !!selectedGrid?.grid.column_offsets;

  useEffect(() => {
    if (isOpen) {
      if (initialSelectedIds && initialSelectedIds.size > 0) {
        const filtered = new Set<string>();
        for (const id of initialSelectedIds) {
          if (eligible.some(s => s.id === id)) filtered.add(id);
        }
        setSelectedScanIds(filtered.size > 0 ? filtered : new Set(eligible.map(s => s.id)));
      } else {
        setSelectedScanIds(new Set(eligible.map(s => s.id)));
      }
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isOpen]);

  // Lmax defaults to '' = Auto (Otsu estimate seeds the new triangulation). A
  // typed value forces that edge length instead. Reuse mode locks it to the mesh.
  const [lmaxStr, setLmaxStr] = useState('');
  const [maxAspectRatioStr, setMaxAspectRatioStr] = useState('4.0');
  const [minVoxelHitsStr, setMinVoxelHitsStr] = useState('5');
  // Characteristic vegetation element width (m). Drives the Pimont (2018)
  // uncertainty that the backend computes on every run. Broadleaf ≈ 0.05 m,
  // conifer needles ≈ 0.002 m — presets below set common values.
  const [elementWidthStr, setElementWidthStr] = useState('0.05');
  const [error, setError] = useState<string | null>(null);

  // --- Direct G(θ) / leaf-angle-distribution override (the third source) ------
  // (gthetaSource is declared above, near reuseTri.)
  // Constant across the grid, or a vertical profile (one method, per-level value).
  const [gthetaSpatial, setGthetaSpatial] = useState<'constant' | 'profile'>('constant');
  // How each G(θ) is obtained: a constant value, a de Wit distribution, or Beta.
  const [gthetaMethod, setGthetaMethod] = useState<'constant' | 'dewit' | 'beta'>('constant');
  // Single-spec drafts (also used as the seed for new profile rows).
  const [gthetaConstStr, setGthetaConstStr] = useState('0.5');
  const [gthetaDewit, setGthetaDewit] = useState<DeWitDistribution>('spherical');
  // Default the Beta (μ, ν) to the spherical-equivalent shape (μ≈1.10, ν≈1.93 →
  // G(θ)≈0.5), not μ=ν=1 (which is the UNIFORM distribution, G≈0.54). This keeps
  // the default consistent with the spherical default used everywhere else; a true
  // exact spherical canopy is the de Wit "spherical" option.
  const [gthetaBetaMuStr, setGthetaBetaMuStr] = useState('1.1');
  const [gthetaBetaNuStr, setGthetaBetaNuStr] = useState('1.93');
  // Per-z-level parameter values for the profile editor (one entry per nz level,
  // index 0 = lowest band). The METHOD is shared (gthetaMethod); only the value
  // varies with height. Holds drafts as strings/enum so partial edits don't snap.
  const [gthetaProfileRows, setGthetaProfileRows] = useState<{
    constStr: string; dewit: DeWitDistribution; betaMuStr: string; betaNuStr: string;
  }[]>([]);

  // Seed Lmax / aspect from the mesh filter the user dialed in (when provided)
  // each time the dialog opens, so the inversion reproduces that filtering. The
  // user can still override before computing.
  useEffect(() => {
    if (!isOpen) return;
    if (defaultLmax !== undefined && Number.isFinite(defaultLmax)) {
      setLmaxStr(Number(defaultLmax.toPrecision(4)).toString());
    }
    if (defaultMaxAspectRatio !== undefined && Number.isFinite(defaultMaxAspectRatio)) {
      setMaxAspectRatioStr(String(defaultMaxAspectRatio));
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isOpen]);

  const toggleScan = useCallback((scanId: string) => {
    setSelectedScanIds(prev => {
      const next = new Set(prev);
      if (next.has(scanId)) next.delete(scanId); else next.add(scanId);
      return next;
    });
  }, []);

  const selectAll = useCallback(() => {
    setSelectedScanIds(new Set(eligible.map(s => s.id)));
  }, [eligible]);

  const deselectAll = useCallback(() => {
    setSelectedScanIds(new Set());
  }, []);

  // The scans actually fed to the inversion. When reusing a triangulation, they
  // come from that mesh's recorded source scans (still resolved against the
  // current session, so a deleted scan is dropped); otherwise the user's pick.
  const selectedScans = useMemo(() => {
    if (reuseTri) {
      const ids = new Set(reuseTri.scanIds);
      return eligible.filter(s => ids.has(s.id));
    }
    return eligible.filter(s => selectedScanIds.has(s.id));
  }, [reuseTri, eligible, selectedScanIds]);

  // Whether all of the reused mesh's source scans are still present (with data +
  // params). If some are gone, the reused triangulation can't be reproduced.
  const reuseScansMissing = useMemo(
    () => (reuseTri ? reuseTri.scanIds.length - selectedScans.length : 0),
    [reuseTri, selectedScans],
  );

  // Return-type summary derived from the selected scans (read-only — set it per
  // scan in the Scans panel). LAD only cares about multi-return vs. single.
  const returnTypes = useMemo(
    () => new Set(selectedScans.map(s => s.params!.returnMode)),
    [selectedScans],
  );

  // Any moving-platform scan in the selection switches the inversion to the
  // beam-based (Gtheta) path, which needs a supplied G(θ) and skips triangulation.
  const anyMoving = useMemo(
    () => selectedScans.some(s => isMovingScan(s.params!)),
    [selectedScans],
  );

  // Moving-platform scans can't be triangulated, so they must supply G(θ) directly.
  // Force the source to 'supplied' (and the user picks a method below).
  useEffect(() => {
    if (anyMoving) setGthetaSource('supplied');
  }, [anyMoving]);

  // Whether the inversion will use a directly-supplied G(θ) (vs. a triangulation).
  const useSuppliedGtheta = gthetaSource === 'supplied' || anyMoving;

  // Number of z-levels the active grid will produce — the profile editor's rows.
  // Reuse mode locks the grid to the mesh; otherwise the selected voxel box.
  const profileGrid = reuseTri ? reuseTri.grid : selectedGrid?.grid;
  const nz = profileGrid?.nz ?? 0;

  // Keep the per-level profile rows sized to nz, seeding new/blank rows from the
  // single-spec drafts so a fresh profile starts from the user's current choice.
  useEffect(() => {
    if (gthetaSpatial !== 'profile' || nz <= 0) return;
    setGthetaProfileRows(prev => {
      if (prev.length === nz) return prev;
      const seed = {
        constStr: gthetaConstStr, dewit: gthetaDewit,
        betaMuStr: gthetaBetaMuStr, betaNuStr: gthetaBetaNuStr,
      };
      const next = prev.slice(0, nz);
      while (next.length < nz) next.push({ ...seed });
      return next;
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [gthetaSpatial, nz]);

  // Build one GThetaValueSpec for the active method from a set of string/enum
  // drafts. Throws (with a user-facing message) when a value is missing/invalid.
  const buildValueSpec = useCallback((
    method: 'constant' | 'dewit' | 'beta',
    d: { constStr: string; dewit: DeWitDistribution; betaMuStr: string; betaNuStr: string },
    levelLabel?: string,
  ): GThetaValueSpec => {
    const where = levelLabel ? ` (${levelLabel})` : '';
    if (method === 'constant') {
      const v = parseFloat(d.constStr);
      if (!Number.isFinite(v) || v <= 0 || v > 1) {
        throw new Error(`G(θ)${where} must be a number in (0, 1] (0.5 = spherical)`);
      }
      return { kind: 'constant', value: v };
    }
    if (method === 'dewit') {
      return { kind: 'dewit', dewit: d.dewit };
    }
    const mu = parseFloat(d.betaMuStr);
    const nu = parseFloat(d.betaNuStr);
    if (!Number.isFinite(mu) || mu <= 0 || !Number.isFinite(nu) || nu <= 0) {
      throw new Error(`Beta parameters${where} must be positive numbers (μ and ν)`);
    }
    return { kind: 'beta', beta_mu: mu, beta_nu: nu };
  }, []);

  const handleCompute = useCallback(() => {
    setError(null);

    if (selectedScans.length === 0) {
      setError(reuseTri
        ? 'The reused triangulation’s source scans are no longer available'
        : 'Select at least one scan');
      return;
    }

    // Reusing a triangulation must reproduce the mesh the user saw. If any of its
    // source scans is gone, the injected G(theta) would silently differ — block
    // rather than compute a partial result.
    if (reuseTri && reuseScansMissing > 0) {
      setError('The reused triangulation’s source scans are no longer all available');
      return;
    }

    // Grid + lmax/aspect come from the reused mesh, else from the dialog.
    const grid = reuseTri ? reuseTri.grid : selectedGrid?.grid;
    if (!grid) {
      setError('Select a voxel grid — LAD requires one');
      return;
    }

    // New-triangulation Lmax: blank/non-finite = Auto (let the triangulation's
    // Otsu estimate seed it); a finite positive value forces that edge length.
    const lmaxParsed = parseFloat(lmaxStr);
    const explicitLmax = Number.isFinite(lmaxParsed) && lmaxParsed > 0 ? lmaxParsed : undefined;
    // The lmax handed to buildLADRequest is only consulted by the backend's own
    // re-triangulation path, which static scans no longer take (newTri below makes
    // the inversion reuse a mesh). Fall back to 0.1 so the field is still valid.
    const lmax = reuseTri ? reuseTri.lmax : (explicitLmax ?? 0.1);
    const maxAspectRatio = reuseTri ? reuseTri.maxAspectRatio : (parseFloat(maxAspectRatioStr) || 4.0);
    const minVoxelHits = Math.max(1, parseInt(minVoxelHitsStr, 10) || 1);
    const elementWidth = Math.max(0, parseFloat(elementWidthStr) || 0.05);

    // Direct G(θ) override (constant or vertical profile, value/de Wit/Beta). When
    // active it selects the supplied-G(θ) path: no triangulation, no mesh reuse.
    let gthetaSpec: GThetaOverrideSpec | undefined;
    if (useSuppliedGtheta) {
      try {
        if (gthetaSpatial === 'profile') {
          if (nz <= 0) {
            setError('Select a voxel grid — a vertical G(θ) profile needs its z-levels');
            return;
          }
          const rows = gthetaProfileRows.length === nz
            ? gthetaProfileRows
            // Fallback if the sizing effect hasn't run yet: seed every level.
            : Array.from({ length: nz }, () => ({
                constStr: gthetaConstStr, dewit: gthetaDewit,
                betaMuStr: gthetaBetaMuStr, betaNuStr: gthetaBetaNuStr,
              }));
          gthetaSpec = {
            spatial: 'profile',
            profile: rows.map((r, i) => buildValueSpec(gthetaMethod, r, `level ${i + 1}`)),
          };
        } else {
          gthetaSpec = {
            spatial: 'constant',
            spec: buildValueSpec(gthetaMethod, {
              constStr: gthetaConstStr, dewit: gthetaDewit,
              betaMuStr: gthetaBetaMuStr, betaNuStr: gthetaBetaNuStr,
            }),
          };
        }
      } catch (e) {
        setError(e instanceof Error ? e.message : 'Invalid G(θ) specification');
        return;
      }
    }

    // Terrain following rides on the grid itself: when the chosen grid was
    // "snapped to ground" (Meshes panel), `grid.column_offsets` is already set and
    // travels through buildLADRequest verbatim, so the inversion follows the terrain
    // shown in the viewport. Nothing to do here.
    const request = buildLADRequest(selectedScans, grid, {
      lmax,
      maxAspectRatio,
      minVoxelHits,
      elementWidth,
      gthetaSpec,
    });

    // Reuse: extract the filtered mesh (vertices/indices) with per-triangle scan
    // ids remapped to the request's scan order, so the backend injects it instead
    // of re-triangulating. Build the payload and the request from the SAME
    // selectedScans so the scan ordering is one source of truth. Skipped on the
    // supplied-G(θ) path (no mesh is used).
    let reuseMesh: ReuseMeshPayload | null = null;
    if (reuseTri && !useSuppliedGtheta) {
      try {
        reuseMesh = extractReuseMeshPayload(
          reuseTri.meshData, lmax, maxAspectRatio,
          reuseTri.scanIds, selectedScans.map(s => s.id),
          // WORLD-frame mesh verts → the cloud's STORED frame (matches the session
          // points LAD runs against). All source scans share one cloud/worldShift.
          selectedScans[0]?.data?.octree?.worldShift ?? null);
      } catch (e) {
        setError(e instanceof Error ? e.message : 'Cannot reuse this triangulation');
        return;
      }
    }

    // The grid mesh to auto-hide so it doesn't z-fight the LAD voxel result. In
    // new-triangulation / supplied mode that's the selected voxel box; in reuse
    // mode it's the box the reused triangulation's grid matches (if still around).
    const gridMeshId = (reuseTri && !useSuppliedGtheta)
      ? (reuseTri.gridMeshId ?? '')
      : (selectedGrid?.id ?? '');

    // Static "run new triangulation": hand the caller the scans + grid so it runs
    // a real Helios triangulation first (Otsu Lmax, mesh into the Meshes pane) and
    // reuses it for the inversion. Skipped for reuse (already have a mesh), the
    // supplied-G(θ) path (no triangulation), and moving-platform scans.
    const newTri = (!reuseTri && !useSuppliedGtheta)
      ? { scans: selectedScans, grid, gridMeshId, lmax: explicitLmax, maxAspectRatio }
      : null;

    onStartLAD(request, selectedScans.map(s => s.color), gridMeshId, reuseMesh, newTri);
    onClose();
  }, [reuseTri, reuseScansMissing, selectedScans, selectedGrid, lmaxStr, maxAspectRatioStr, minVoxelHitsStr, elementWidthStr, anyMoving, useSuppliedGtheta, gthetaSpatial, nz, gthetaProfileRows, gthetaMethod, gthetaConstStr, gthetaDewit, gthetaBetaMuStr, gthetaBetaNuStr, buildValueSpec, onStartLAD, onClose]);

  if (!isOpen) return null;

  const totalPoints = selectedScans.reduce((sum, s) => sum + s.data!.pointCount, 0);
  const ineligibleScans = scans.filter(s => hasData(s) && !hasParams(s));

  // LAD now HARD-REQUIRES miss points (the Beer's-law transmission denominator).
  // Selected scans that don't yet carry misses block Compute. Split them into
  // those we can recover (run Backfill Misses) and those we can't (no timestamp /
  // grid — re-import a miss-retaining format).
  const needsBackfill = selectedScans.filter(s => s.data?.octree?.hasMisses !== true);
  const recoverable = needsBackfill.filter(s => isBackfillEligible(s));
  const unrecoverable = needsBackfill.filter(s => !isBackfillEligible(s));

  const canCompute =
    selectedScans.length > 0 &&
    (reuseTri != null || selectedGrid != null) &&
    needsBackfill.length === 0;

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center"
      onKeyDown={(e) => e.stopPropagation()}
    >
      <div
        className="absolute inset-0 bg-black/60 backdrop-blur-sm"
        onClick={onClose}
      />

      <div data-testid="lad-popup" className="relative bg-neutral-800 rounded-xl shadow-2xl border border-neutral-700 w-full max-w-2xl mx-4 overflow-hidden">
        <div className="flex items-center justify-between px-4 py-3 border-b border-neutral-700 bg-neutral-800/90">
          <div className="flex items-center gap-2">
            <Grid3x3 className="w-4 h-4 text-neutral-400" />
            <h2 className="text-sm font-semibold text-white">Leaf Area Density Setup</h2>
          </div>
          <button
            data-testid="lad-close"
            onClick={onClose}
            className="p-1 rounded hover:bg-neutral-700 transition-colors"
          >
            <X className="w-4 h-4 text-neutral-400" />
          </button>
        </div>

        <div className="p-4 space-y-4 max-h-[70vh] overflow-y-auto">
          {/* G(θ) source: derive the leaf-projection coefficient from a leaf
              surface (triangulation), or prescribe it directly. Moving-platform
              scans can't be triangulated, so the choice is forced to "supplied". */}
          <div data-testid="lad-gtheta-source">
            <label className="text-xs font-medium text-neutral-300 mb-1 flex items-center gap-1">
              G(θ) source
              <InfoHint
                data-testid="lad-gtheta-source-help"
                label="G(θ) source"
                text="How the leaf-projection coefficient G(θ) — which converts beam attenuation into leaf area — is obtained. 'Derive from triangulation' meshes the hit points and estimates G(θ) per voxel from the leaf surface orientations. 'Supply directly' lets you prescribe the leaf-angle distribution / G(θ) yourself (a constant, a de Wit classical distribution, or Beta parameters), either the same everywhere or varying with height — useful when the canopy structure is known or assumed, or to skip triangulation."
              />
            </label>
            <div className="flex gap-2">
              <button
                type="button"
                data-testid="lad-gtheta-source-triangulation"
                disabled={anyMoving}
                onClick={() => setGthetaSource('triangulation')}
                className={`flex-1 px-2 py-1.5 text-xs rounded border transition-colors ${
                  !useSuppliedGtheta
                    ? 'border-green-500 bg-green-500/10 text-white'
                    : 'border-neutral-600 text-neutral-300 hover:bg-neutral-700'
                } ${anyMoving ? 'opacity-40 cursor-not-allowed' : ''}`}
              >
                Derive from triangulation
              </button>
              <button
                type="button"
                data-testid="lad-gtheta-source-supplied"
                onClick={() => setGthetaSource('supplied')}
                className={`flex-1 px-2 py-1.5 text-xs rounded border transition-colors ${
                  useSuppliedGtheta
                    ? 'border-green-500 bg-green-500/10 text-white'
                    : 'border-neutral-600 text-neutral-300 hover:bg-neutral-700'
                }`}
              >
                Supply G(θ) directly
              </button>
            </div>
            {anyMoving && (
              <p className="text-[9px] text-amber-300 mt-1" data-testid="lad-gtheta-moving-note">
                Moving-platform scans can't be triangulated — G(θ) must be supplied.
              </p>
            )}
          </div>

          {/* Triangulation source: run a new one, or reuse an existing mesh (which
              locks the scans, grid, and lmax/aspect to reproduce its G-function).
              Hidden when supplying G(θ) directly (no mesh is built). Reusable
              meshes are selectable; ineligible ones (e.g. a merged/unpinned
              ball-pivot mesh) appear disabled with the reason. */}
          {!useSuppliedGtheta && (
          <div>
            <label className="text-xs font-medium text-neutral-300 block mb-1">Triangulation</label>
            <select
              data-testid="lad-triangulation-select"
              value={reuseTriId}
              onChange={(e) => setReuseTriId(e.target.value)}
              className="w-full px-2 py-1.5 bg-neutral-700 border border-neutral-600 rounded text-xs text-white focus:outline-none focus:ring-1 focus:ring-green-500/50"
            >
              <option value="">Run a new triangulation</option>
              {triangulationOptions.map(t => (
                <option key={t.id} value={t.id}>Reuse: {t.label}</option>
              ))}
              {ineligibleTriangulations.map(t => (
                <option key={t.id} value="" disabled data-testid="lad-triangulation-ineligible">
                  {`⛔ ${t.label} — ${t.reason}`}
                </option>
              ))}
            </select>
            {reuseTri ? (
              <p className="text-[9px] text-neutral-500 mt-1" data-testid="lad-reuse-summary">
                Reusing {reuseTri.label}: {reuseTri.scanIds.length} scan{reuseTri.scanIds.length > 1 ? 's' : ''},
                grid {reuseTri.grid.nx}×{reuseTri.grid.ny}×{reuseTri.grid.nz},
                Lmax {(reuseTri.lmax * 100).toFixed(1)} cm, aspect ≤ {reuseTri.maxAspectRatio}.
                Scans, grid, and filter are locked to match this mesh.
                {reuseScansMissing > 0 && (
                  <span className="text-amber-300"> {reuseScansMissing} source scan(s) no longer available.</span>
                )}
              </p>
            ) : (
              <p className="text-[9px] text-neutral-500 mt-1" data-testid="lad-new-tri-summary">
                A new triangulation is built from the scans and grid below, added to the
                Meshes panel, and reused for the inversion. Lmax is auto-estimated unless
                you set it.
              </p>
            )}
          </div>
          )}

          {/* Supply G(θ) directly: prescribe the leaf-angle distribution / G(θ)
              instead of triangulating — constant across the grid or as a vertical
              profile, with each value given as a constant, a de Wit distribution,
              or Beta (μ, ν) parameters. */}
          {useSuppliedGtheta && (
          <div data-testid="lad-gtheta-supply-panel" className="border border-neutral-700 rounded p-3 space-y-3">
            {/* Spatial mode */}
            <div>
              <label className="text-[10px] text-neutral-400 mb-1 flex items-center gap-1">
                Vary with height?
                <InfoHint
                  data-testid="lad-gtheta-spatial-help"
                  label="Constant vs. vertical profile"
                  text="Constant applies one G(θ) to every voxel. Vertical profile lets G(θ) change with height — you pick the method once and enter its value for each z-level of the grid (level 1 = lowest). Use a profile when leaf inclination differs between the lower and upper canopy."
                />
              </label>
              <div className="flex gap-2">
                {(['constant', 'profile'] as const).map(mode => (
                  <button
                    key={mode}
                    type="button"
                    data-testid={`lad-gtheta-spatial-${mode}`}
                    onClick={() => setGthetaSpatial(mode)}
                    className={`flex-1 px-2 py-1 text-xs rounded border transition-colors ${
                      gthetaSpatial === mode
                        ? 'border-green-500 bg-green-500/10 text-white'
                        : 'border-neutral-600 text-neutral-300 hover:bg-neutral-700'
                    }`}
                  >
                    {mode === 'constant' ? 'Constant' : 'Vertical profile'}
                  </button>
                ))}
              </div>
            </div>

            {/* Method */}
            <div>
              <label className="text-[10px] text-neutral-400 mb-1 flex items-center gap-1">
                Method
                <InfoHint
                  data-testid="lad-gtheta-method-help"
                  label="G(θ) method"
                  text="How each G(θ) is obtained. Constant value: enter G(θ) directly (0.5 = spherical). de Wit: choose a classical leaf-inclination distribution; G(θ) is derived by integrating the projection kernel over the scan's beam directions. Beta (μ, ν): Goel-Strebel parameters (ν = toward-vertical weight, μ = toward-horizontal); G(θ) derived as for de Wit."
                />
              </label>
              <div className="flex gap-2">
                {(['constant', 'dewit', 'beta'] as const).map(m => (
                  <button
                    key={m}
                    type="button"
                    data-testid={`lad-gtheta-method-${m}`}
                    onClick={() => setGthetaMethod(m)}
                    className={`flex-1 px-2 py-1 text-xs rounded border transition-colors ${
                      gthetaMethod === m
                        ? 'border-green-500 bg-green-500/10 text-white'
                        : 'border-neutral-600 text-neutral-300 hover:bg-neutral-700'
                    }`}
                  >
                    {m === 'constant' ? 'Constant value' : m === 'dewit' ? 'de Wit' : 'Beta (μ,ν)'}
                  </button>
                ))}
              </div>
            </div>

            {/* Constant-spatial inputs (single value/distribution) */}
            {gthetaSpatial === 'constant' && (
              <div data-testid="lad-gtheta-constant-inputs">
                {gthetaMethod === 'constant' && (
                  <div className="flex items-center gap-2">
                    <input
                      data-testid="lad-gtheta-value"
                      type="text"
                      inputMode="decimal"
                      onWheel={(e) => e.currentTarget.blur()}
                      value={gthetaConstStr}
                      onChange={(e) => setGthetaConstStr(e.target.value)}
                      className="w-28 px-2 py-1.5 bg-neutral-700 border border-neutral-600 rounded text-xs text-white focus:outline-none focus:ring-1 focus:ring-green-500/50"
                    />
                    <button
                      type="button"
                      data-testid="lad-gtheta-preset-spherical"
                      onClick={() => setGthetaConstStr('0.5')}
                      className="px-2 py-1 text-[10px] rounded border border-neutral-600 text-neutral-300 hover:bg-neutral-700 transition-colors"
                    >
                      Spherical (0.5)
                    </button>
                  </div>
                )}
                {gthetaMethod === 'dewit' && (
                  <select
                    data-testid="lad-gtheta-dewit"
                    value={gthetaDewit}
                    onChange={(e) => setGthetaDewit(e.target.value as DeWitDistribution)}
                    className="w-full px-2 py-1.5 bg-neutral-700 border border-neutral-600 rounded text-xs text-white focus:outline-none focus:ring-1 focus:ring-green-500/50"
                  >
                    {DEWIT_OPTIONS.map(o => (
                      <option key={o.value} value={o.value}>{o.label}</option>
                    ))}
                  </select>
                )}
                {gthetaMethod === 'beta' && (
                  <div className="flex items-center gap-2">
                    <label className="text-[10px] text-neutral-400">μ</label>
                    <input
                      data-testid="lad-gtheta-beta-mu"
                      type="text"
                      inputMode="decimal"
                      onWheel={(e) => e.currentTarget.blur()}
                      value={gthetaBetaMuStr}
                      onChange={(e) => setGthetaBetaMuStr(e.target.value)}
                      className="w-20 px-2 py-1.5 bg-neutral-700 border border-neutral-600 rounded text-xs text-white focus:outline-none focus:ring-1 focus:ring-green-500/50"
                    />
                    <label className="text-[10px] text-neutral-400">ν</label>
                    <input
                      data-testid="lad-gtheta-beta-nu"
                      type="text"
                      inputMode="decimal"
                      onWheel={(e) => e.currentTarget.blur()}
                      value={gthetaBetaNuStr}
                      onChange={(e) => setGthetaBetaNuStr(e.target.value)}
                      className="w-20 px-2 py-1.5 bg-neutral-700 border border-neutral-600 rounded text-xs text-white focus:outline-none focus:ring-1 focus:ring-green-500/50"
                    />
                    <button
                      type="button"
                      data-testid="lad-gtheta-beta-spherical"
                      onClick={() => { setGthetaBetaMuStr('1.1'); setGthetaBetaNuStr('1.93'); }}
                      className="px-2 py-1 text-[10px] rounded border border-neutral-600 text-neutral-300 hover:bg-neutral-700 transition-colors"
                    >
                      Spherical (1.1, 1.93)
                    </button>
                  </div>
                )}
              </div>
            )}

            {/* Vertical-profile editor: one row per z-level (level 1 = lowest). */}
            {gthetaSpatial === 'profile' && (
              nz <= 0 ? (
                <p className="text-[10px] text-amber-300" data-testid="lad-gtheta-profile-nogrid">
                  Select a voxel grid below — the profile has one row per z-level.
                </p>
              ) : (
                <div data-testid="lad-gtheta-profile-editor" className="space-y-1.5">
                  <div className="flex items-center justify-between">
                    <span className="text-[10px] text-neutral-400">
                      {nz} level{nz > 1 ? 's' : ''} (level 1 = lowest)
                    </span>
                    <button
                      type="button"
                      data-testid="lad-gtheta-profile-fill"
                      onClick={() => setGthetaProfileRows(rows =>
                        rows.map(() => ({
                          constStr: gthetaConstStr, dewit: gthetaDewit,
                          betaMuStr: gthetaBetaMuStr, betaNuStr: gthetaBetaNuStr,
                        })))}
                      className="px-2 py-0.5 text-[10px] rounded border border-neutral-600 text-neutral-300 hover:bg-neutral-700 transition-colors"
                    >
                      Apply level 1 to all
                    </button>
                  </div>
                  {gthetaProfileRows.map((row, i) => (
                    <div key={i} className="flex items-center gap-2" data-testid="lad-gtheta-profile-row">
                      <span className="w-10 text-[10px] text-neutral-500 text-right">L{i + 1}</span>
                      {gthetaMethod === 'constant' && (
                        <input
                          data-testid="lad-gtheta-profile-value"
                          type="text"
                          inputMode="decimal"
                          onWheel={(e) => e.currentTarget.blur()}
                          value={row.constStr}
                          onChange={(e) => setGthetaProfileRows(rows =>
                            rows.map((r, j) => j === i ? { ...r, constStr: e.target.value } : r))}
                          className="w-24 px-2 py-1 bg-neutral-700 border border-neutral-600 rounded text-xs text-white focus:outline-none focus:ring-1 focus:ring-green-500/50"
                        />
                      )}
                      {gthetaMethod === 'dewit' && (
                        <select
                          data-testid="lad-gtheta-profile-dewit"
                          value={row.dewit}
                          onChange={(e) => setGthetaProfileRows(rows =>
                            rows.map((r, j) => j === i ? { ...r, dewit: e.target.value as DeWitDistribution } : r))}
                          className="flex-1 px-2 py-1 bg-neutral-700 border border-neutral-600 rounded text-xs text-white focus:outline-none focus:ring-1 focus:ring-green-500/50"
                        >
                          {DEWIT_OPTIONS.map(o => (
                            <option key={o.value} value={o.value}>{o.label}</option>
                          ))}
                        </select>
                      )}
                      {gthetaMethod === 'beta' && (
                        <>
                          <label className="text-[10px] text-neutral-400">μ</label>
                          <input
                            data-testid="lad-gtheta-profile-mu"
                            type="text"
                            inputMode="decimal"
                            onWheel={(e) => e.currentTarget.blur()}
                            value={row.betaMuStr}
                            onChange={(e) => setGthetaProfileRows(rows =>
                              rows.map((r, j) => j === i ? { ...r, betaMuStr: e.target.value } : r))}
                            className="w-16 px-2 py-1 bg-neutral-700 border border-neutral-600 rounded text-xs text-white focus:outline-none focus:ring-1 focus:ring-green-500/50"
                          />
                          <label className="text-[10px] text-neutral-400">ν</label>
                          <input
                            data-testid="lad-gtheta-profile-nu"
                            type="text"
                            inputMode="decimal"
                            onWheel={(e) => e.currentTarget.blur()}
                            value={row.betaNuStr}
                            onChange={(e) => setGthetaProfileRows(rows =>
                              rows.map((r, j) => j === i ? { ...r, betaNuStr: e.target.value } : r))}
                            className="w-16 px-2 py-1 bg-neutral-700 border border-neutral-600 rounded text-xs text-white focus:outline-none focus:ring-1 focus:ring-green-500/50"
                          />
                        </>
                      )}
                    </div>
                  ))}
                </div>
              )
            )}
          </div>
          )}

          {/* Scan picker — only when running a NEW triangulation. When reusing or
              supplying G(θ), the scans are fixed/independent, so we hide it for
              reuse but still show it on the supplied path (the user picks scans). */}
          {!reuseTri && (
          <>
          {/* Select controls + count */}
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-2">
              <label className="text-xs font-medium text-neutral-300">Scans</label>
              <span className="text-[10px] text-neutral-500">
                ({selectedScanIds.size}/{eligible.length} selected)
              </span>
            </div>
            <div className="flex items-center gap-2">
              <button
                onClick={selectAll}
                className="text-[10px] text-neutral-400 hover:text-neutral-200 transition-colors"
              >
                All
              </button>
              <span className="text-neutral-600 text-[10px]">|</span>
              <button
                onClick={deselectAll}
                className="text-[10px] text-neutral-400 hover:text-neutral-200 transition-colors"
              >
                None
              </button>
            </div>
          </div>

          {eligible.length === 0 ? (
            <div className="p-4 text-center text-xs text-neutral-500">
              No scans have both point data and scan parameters. Attach parameters from the Scans panel first.
            </div>
          ) : (
            <div className="border border-neutral-700 rounded-lg overflow-hidden">
              <div className="grid grid-cols-[auto_1fr_auto_auto_auto] gap-2 px-3 py-2 bg-neutral-900/80 border-b border-neutral-700 items-center">
                <div className="w-4" />
                <span className="text-[10px] font-medium text-neutral-500 uppercase tracking-wider">Scan</span>
                <span className="text-[10px] font-medium text-neutral-500 uppercase tracking-wider w-16 text-center">X</span>
                <span className="text-[10px] font-medium text-neutral-500 uppercase tracking-wider w-16 text-center">Y</span>
                <span className="text-[10px] font-medium text-neutral-500 uppercase tracking-wider w-16 text-center">Z</span>
              </div>

              <div className="max-h-[35vh] overflow-y-auto">
                {eligible.map(scan => {
                  const isSelected = selectedScanIds.has(scan.id);
                  const fileName = scan.label || scan.data!.fileName || 'Unnamed';
                  return (
                    <div
                      key={scan.id}
                      data-testid="lad-scan-row"
                      data-scan-id={scan.id}
                      className={`grid grid-cols-[auto_1fr_auto_auto_auto] gap-2 px-3 py-2 items-center border-b border-neutral-700/50 transition-colors ${
                        isSelected ? 'bg-neutral-700/30' : 'bg-neutral-800/50 opacity-60'
                      }`}
                    >
                      <input
                        type="checkbox"
                        checked={isSelected}
                        onChange={() => toggleScan(scan.id)}
                        className="w-3.5 h-3.5 rounded border-neutral-600 bg-neutral-700 text-green-500 focus:ring-0 focus:ring-offset-0 cursor-pointer"
                      />
                      <div className="flex items-center gap-2 min-w-0">
                        <div className="w-2 h-2 rounded-full flex-shrink-0" style={{ backgroundColor: scan.color }} />
                        <span className="text-xs text-white truncate" title={fileName}>{fileName}</span>
                        <span className="text-[9px] text-neutral-500 flex-shrink-0">
                          {scan.data!.pointCount.toLocaleString()} pts
                        </span>
                      </div>
                      <span className="w-16 px-1.5 py-1 text-[11px] text-neutral-300 text-center font-mono">{scan.params!.origin.x.toFixed(2)}</span>
                      <span className="w-16 px-1.5 py-1 text-[11px] text-neutral-300 text-center font-mono">{scan.params!.origin.y.toFixed(2)}</span>
                      <span className="w-16 px-1.5 py-1 text-[11px] text-neutral-300 text-center font-mono">{scan.params!.origin.z.toFixed(2)}</span>
                    </div>
                  );
                })}
              </div>
            </div>
          )}

          {ineligibleScans.length > 0 && (
            <div className="text-[10px] text-amber-300 bg-amber-500/5 border border-amber-500/30 rounded px-2 py-1.5">
              {ineligibleScans.length} scan(s) missing parameters and cannot be used.
              Add scan parameters from the Scans panel.
            </div>
          )}
          </>
          )}

          {/* Return type (read-only, derived from the selected scans) */}
          {selectedScans.length > 0 && (
            <div
              data-testid="lad-returntype-summary"
              className="text-[10px] text-neutral-400"
            >
              {returnTypes.size > 1 ? (
                <span className="text-amber-300">
                  Selected scans mix single- and multi-return; each is computed with its own return type.
                </span>
              ) : returnTypes.has('multi') ? (
                <span>Return type: <span className="text-neutral-200">multi-return</span> (full-waveform; beam params from scan parameters)</span>
              ) : (
                <span>Return type: <span className="text-neutral-200">single-return</span></span>
              )}
            </div>
          )}

          {/* Algorithm Parameters */}
          <div className="border-t border-neutral-700 pt-4">
            <label className="text-xs font-medium text-neutral-300 block mb-3">Parameters</label>

            {/* On the new-triangulation path the surface mesh is now built like the
                standalone Triangulate tool and added to the Meshes panel, so the
                user can review/refine it and re-run LAD by reusing it. */}
            {!reuseTri && !useSuppliedGtheta && (
              <div className="mb-3 text-[10px] text-neutral-400 bg-neutral-800/60 border border-neutral-700 rounded px-2.5 py-2 leading-relaxed">
                A new surface mesh is built and added to the{' '}
                <span className="text-neutral-200">Meshes</span> panel. Leave Lmax on{' '}
                <span className="text-neutral-200">Auto</span> to size it from the data
                (Otsu estimate, recommended), or enter a value to force it. Either way,
                review the mesh and adjust its filter there, then reopen this dialog and
                pick it under <span className="text-neutral-200">Triangulation</span> to
                recompute.
              </div>
            )}

            <div className="grid grid-cols-3 gap-3">
              {/* Lmax + Aspect drive the G-function triangulation, so they're
                  locked when reusing an existing triangulation (the mesh already
                  fixes them). Hidden in reuse mode; the reuse summary shows them.
                  On a new triangulation Lmax defaults to "Auto" (empty) → the
                  Otsu estimate seeds the mesh; a typed value forces it. */}
              {!reuseTri && !useSuppliedGtheta && (
              <div>
                <label className="text-[10px] text-neutral-400 mb-1 flex items-center gap-1">
                  Max Edge Length (Lmax)
                  <InfoHint
                    data-testid="lad-lmax-help"
                    label="Max edge length (Lmax)"
                    text="Longest triangle edge (metres) allowed when triangulating each scan into the surface used to derive the G-function (the leaf-projection coefficient). Leave blank for Auto — the edge length is estimated from the data (Otsu over the candidate edge-length distribution), the same estimate the standalone Triangulate tool seeds. Enter a value to force it: lower keeps only tight, well-sampled triangles; higher bridges sparser regions. Too small drops valid leaf surface; too large spans gaps between separate leaves."
                  />
                </label>
                <input
                  data-testid="lad-input-lmax"
                  type="text"
                  inputMode="decimal"
                  placeholder="Auto"
                  onWheel={(e) => e.currentTarget.blur()}
                  value={lmaxStr}
                  onChange={(e) => setLmaxStr(e.target.value)}
                  className="w-full px-2 py-1.5 bg-neutral-700 border border-neutral-600 rounded text-xs text-white focus:outline-none focus:ring-1 focus:ring-green-500/50"
                />
              </div>
              )}

              {!reuseTri && !useSuppliedGtheta && (
              <div>
                <label className="text-[10px] text-neutral-400 mb-1 flex items-center gap-1">
                  Max Aspect Ratio
                  <InfoHint
                    data-testid="lad-aspect-help"
                    label="Max aspect ratio"
                    text="Rejects long, skinny triangles whose longest edge exceeds this multiple of their shortest. Such slivers usually span the gap between separate leaves rather than a real leaf surface, biasing the G-function. Lower it to filter more aggressively; raise it to keep elongated triangles. 4 is a sensible default."
                  />
                </label>
                <input
                  data-testid="lad-input-aspect"
                  type="number"
                  onWheel={(e) => e.currentTarget.blur()}
                  value={maxAspectRatioStr}
                  onChange={(e) => setMaxAspectRatioStr(e.target.value)}
                  step="0.5"
                  min="1"
                  className="w-full px-2 py-1.5 bg-neutral-700 border border-neutral-600 rounded text-xs text-white focus:outline-none focus:ring-1 focus:ring-green-500/50"
                />
              </div>
              )}

              <div>
                <label className="text-[10px] text-neutral-400 mb-1 flex items-center gap-1">
                  Min Voxel Hits
                  <InfoHint
                    data-testid="lad-min-hits-help"
                    label="Min voxel hits"
                    text="Minimum number of beam interceptions a voxel must receive before LAD is solved for it. Voxels below this are left empty rather than reported from too few rays, where the transmission estimate is noisy and unreliable. Raise it to suppress sparse, uncertain voxels; lower it to fill more of the grid at the cost of noisier edges."
                  />
                </label>
                <input
                  data-testid="lad-input-min-hits"
                  type="number"
                  onWheel={(e) => e.currentTarget.blur()}
                  value={minVoxelHitsStr}
                  onChange={(e) => setMinVoxelHitsStr(e.target.value)}
                  step="1"
                  min="1"
                  className="w-full px-2 py-1.5 bg-neutral-700 border border-neutral-600 rounded text-xs text-white focus:outline-none focus:ring-1 focus:ring-green-500/50"
                />
              </div>
            </div>

            {/* Element width — drives the Pimont et al. (2018) sampling
                uncertainty reported alongside the LAD estimate. Presets set
                common values; the field stays editable. */}
            <div className="mt-4">
              <label className="text-[10px] text-neutral-400 mb-1 flex items-center gap-1">
                Element width (m)
                <InfoHint
                  data-testid="lad-element-width-help"
                  label="Element width"
                  text="Characteristic width of a single foliage element — leaf for broadleaf, needle for conifer (metres). It sets the spatial scale at which beams resolve the canopy, feeding the Pimont et al. (2018) sampling-uncertainty interval reported with each result. It does not change the LAD value itself, only its confidence bounds. Use the presets as starting points: broadleaf ≈ 0.05 m, conifer needle ≈ 0.002 m."
                />
              </label>
              <div className="flex items-center gap-2">
                <input
                  data-testid="lad-input-element-width"
                  type="number"
                  onWheel={(e) => e.currentTarget.blur()}
                  value={elementWidthStr}
                  onChange={(e) => setElementWidthStr(e.target.value)}
                  step="0.01"
                  min="0"
                  className="w-28 px-2 py-1.5 bg-neutral-700 border border-neutral-600 rounded text-xs text-white focus:outline-none focus:ring-1 focus:ring-green-500/50"
                />
                <button
                  data-testid="lad-preset-broadleaf"
                  type="button"
                  onClick={() => setElementWidthStr('0.05')}
                  className="px-2 py-1 text-[10px] rounded border border-neutral-600 text-neutral-300 hover:bg-neutral-700 transition-colors"
                >
                  Broadleaf (0.05)
                </button>
                <button
                  data-testid="lad-preset-conifer"
                  type="button"
                  onClick={() => setElementWidthStr('0.002')}
                  className="px-2 py-1 text-[10px] rounded border border-neutral-600 text-neutral-300 hover:bg-neutral-700 transition-colors"
                >
                  Conifer (0.002)
                </button>
              </div>
            </div>

            {/* Note: the supplied-G(θ) panel (above, when "Supply G(θ) directly"
                is selected) now covers moving-platform scans too — they always use
                a supplied G(θ) since they can't be triangulated. */}

            {/* Voxel grid — only when running a new triangulation. When reusing,
                the grid is fixed by the mesh (shown in the reuse summary above). */}
            {!reuseTri && (
            <>
            <label className="text-xs font-medium text-neutral-300 mt-4 mb-2 flex items-center gap-1">
              Voxel Grid (required)
              <InfoHint
                data-testid="lad-grid-help"
                label="Voxel grid"
                text="LAD is computed independently for every voxel, so an explicit grid is the basis of the calculation, not just a bounding region. Pick a voxel box created in the viewer; its bounds set the analysed volume and its subdivisions set the grid resolution. Finer grids give more spatial detail but spread the same beams over more voxels, so each gets fewer hits — balance resolution against Min Voxel Hits."
              />
            </label>
            {gridOptions.length === 0 ? (
              <div
                className="text-[10px] text-amber-300 bg-amber-500/5 border border-amber-500/30 rounded px-2 py-1.5"
                data-testid="lad-no-grid-warning"
              >
                No voxel grid available. Create a Voxel box in the viewer (Create
                Voxel) and set its subdivisions, then reopen this dialog.
              </div>
            ) : (
              <>
                <select
                  data-testid="lad-grid-select"
                  value={selectedGridId}
                  onChange={(e) => setSelectedGridId(e.target.value)}
                  className="w-full px-2 py-1.5 bg-neutral-700 border border-neutral-600 rounded text-xs text-white focus:outline-none focus:ring-1 focus:ring-green-500/50"
                >
                  {gridOptions.map(g => (
                    <option key={g.id} value={g.id}>{g.label}</option>
                  ))}
                </select>
                {selectedGrid && (
                  <p className="text-[9px] text-neutral-500 mt-1" data-testid="lad-grid-summary">
                    Grid: {selectedGrid.label} ({selectedGrid.grid.nx}×{selectedGrid.grid.ny}×{selectedGrid.grid.nz} voxels)
                  </p>
                )}
              </>
            )}

            {/* Terrain following: when the chosen grid was "snapped to ground"
                (Meshes panel), it follows the DEM — show that, since the inversion
                will use the displaced grid the viewport shows. */}
            {gridIsSnapped && (
              <div
                className="text-[10px] text-green-300 bg-green-500/5 border border-green-500/30 rounded px-2 py-1.5 mt-3 flex items-center gap-1"
                data-testid="lad-grid-snapped-note"
              >
                This grid is snapped to ground — LAD will follow the terrain.
                <InfoHint
                  data-testid="lad-terrain-help"
                  label="Terrain following"
                  text="The grid was displaced to ride a DEM surface (Meshes panel → Snap to ground). Each voxel column tracks the ground, so the inversion uses exactly the grid you see. To change it, re-snap or clear the snap on the grid in the Meshes panel."
                />
              </div>
            )}
            </>
            )}
          </div>

          {needsBackfill.length > 0 && (
            <div
              className="text-[10px] text-amber-300 bg-amber-500/5 border border-amber-500/30 rounded px-2 py-1.5 space-y-1.5"
              data-testid="lad-backfill-hint"
            >
              {recoverable.length > 0 && (
                <div className="flex items-center justify-between gap-2">
                  <span>
                    {recoverable.length === 1 ? 'This scan has' : `${recoverable.length} selected scans have`}{' '}
                    no sky/miss points yet. LAD needs them — recover them first.
                  </span>
                  {onBackfill && (
                    <button
                      data-testid="lad-backfill-button"
                      onClick={() => { onBackfill(recoverable.map(s => s.id), new Set(selectedScanIds)); onClose(); }}
                      className="shrink-0 px-2 py-1 text-[10px] rounded font-medium bg-amber-600 hover:bg-amber-500 text-white"
                    >
                      Backfill Misses
                    </button>
                  )}
                </div>
              )}
              {unrecoverable.length > 0 && (
                <div>
                  {unrecoverable.length === 1 ? 'A selected scan' : `${unrecoverable.length} selected scans`}{' '}
                  cannot recover misses (no timestamp or row/column grid). Re-import a
                  scan that retains misses (E57 / structured PLY) to run LAD on it.
                </div>
              )}
            </div>
          )}

          {error && (
            <div className="p-2 bg-red-900/30 border border-red-600/50 rounded text-[10px] text-red-300">
              {error}
            </div>
          )}
        </div>

        <div className="px-4 py-3 border-t border-neutral-700 bg-neutral-800/90 flex items-center justify-between">
          <span className="text-[10px] text-neutral-500">
            {selectedScans.length > 0
              ? `${selectedScans.length} scan${selectedScans.length > 1 ? 's' : ''}, ${totalPoints.toLocaleString()} total points`
              : 'No scans selected'}
          </span>
          <button
            data-testid="lad-compute-button"
            onClick={handleCompute}
            disabled={!canCompute}
            className={`px-4 py-2 text-xs rounded font-medium flex items-center gap-2 ${
              !canCompute
                ? 'bg-neutral-600 text-neutral-400 cursor-not-allowed'
                : 'bg-green-600 hover:bg-green-500 text-white'
            }`}
          >
            <Grid3x3 className="w-3.5 h-3.5" />
            Compute LAD
          </button>
        </div>
      </div>
    </div>
  );
}
