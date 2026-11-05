import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { X, ChevronLeft, ChevronRight, FileUp } from 'lucide-react';
import { previewPointCloud } from '../utils/backendApi';
import { pickAndParseTrajectory } from '../lib/trajectoryImport';
import { PoseStreamParseError } from '../lib/poseStream';
import { showToast } from './Toast';
import { PointCloudImportOptions } from './PointCloudImportOptions';
import {
  applyPreview,
  blankScanConfig,
  hasXYZ,
  layoutSignature,
  propagateFrom,
  propagateSettings,
  toWizardResult,
  withPreviewError,
  type ScanConfig,
  type WizardResult,
  type WizardScanInput,
} from '../lib/pointCloudImportOptions';

// The model (WizardScanInput / WizardResult / ScanConfig and every pure rule)
// lives in lib/pointCloudImportOptions; the options UI in
// PointCloudImportOptions. This file is the MODAL host: one config per file,
// stepped with Back/Next, with "apply to all" across matching layouts. It
// serves imports that arrive with their files already chosen (drag-drop,
// Open-With, Helios XML, RIEGL). File -> Import uses the file browser instead.
export type { WizardScanInput, WizardResult } from '../lib/pointCloudImportOptions';
export {
  SHIFTLESS_KINDS,
  TRAJECTORYLESS_KINDS,
  droppedSlugs,
  keptSlugs,
  layoutSignature,
  propagateSettings,
  protectedDropWarnings,
  roleOverrides,
  scalarLabels,
} from '../lib/pointCloudImportOptions';

interface PointCloudImportWizardProps {
  inputs: WizardScanInput[];
  onCancel: () => void;
  onComplete: (results: WizardResult[]) => void;
}

export function PointCloudImportWizard({ inputs, onCancel, onComplete }: PointCloudImportWizardProps) {
  const [stepIdx, setStepIdx] = useState(0);
  const [configs, setConfigs] = useState<ScanConfig[]>(() => inputs.map(blankScanConfig));
  const [applyToAll, setApplyToAll] = useState(false);
  // The scan whose settings "apply to all" copies from: the one the box was
  // ticked on, then whichever scan was edited last. State for the review gate
  // (which compares layouts against it); mirrored in refs so setConfigs
  // updaters — including the preview effect's, which outlives any one render —
  // read the current values rather than a stale closure.
  const [sourceIdx, setSourceIdx] = useState(0);
  const applyToAllRef = useRef(false);
  const sourceIdxRef = useRef(0);
  // Furthest scan the user has reached via Next. For a multi-scan import we only
  // enable the Import button once they've either stepped through every scan
  // (maxStepReached === last) or checked "apply to all" — otherwise it's too easy
  // to import without realizing the per-scan choices on later scans went unseen.
  const [maxStepReached, setMaxStepReached] = useState(0);

  const total = inputs.length;
  const current = inputs[stepIdx];
  const cfg = configs[stepIdx];

  // Preview every input up front (in parallel). Previewing all scans — not just
  // the visited one — is what lets the Import button enable for a multi-file
  // import without forcing the user to step through each one; it also keeps the
  // "apply to all" layout-match check meaningful (every scan's signature known).
  // Preview reads only a file header + a few rows, so N parallel previews stay
  // cheap. Runs once per `inputs` identity.
  useEffect(() => {
    let canceled = false;
    inputs.forEach((input, i) => {
      (async () => {
        try {
          const preview = await previewPointCloud(input.path, input.asciiFormatHint ?? null);
          if (canceled) return;
          setConfigs((prev) => {
            const seeded = applyPreview(prev, i, preview);
            // With "apply to all" on, a preview landing late must not leave its
            // scan at defaults: the box was already ticked, Import is already
            // enabled on the strength of it, and this scan was never shown the
            // settings. Re-sync every scan from the source — which also covers
            // the source's OWN preview arriving after the tick, and the source's
            // shift being re-seeded by the suggestion this preview just shared.
            return applyToAllRef.current ? propagateFrom(seeded, sourceIdxRef.current) : seeded;
          });
        } catch (e) {
          if (canceled) return;
          const msg = e instanceof Error ? e.message : 'Preview failed';
          setConfigs((prev) => prev.map((c, idx) => idx === i ? withPreviewError(c, msg) : c));
        }
      })();
    });
    return () => { canceled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [inputs]);

  // Apply `fn` to the scan on screen and, while "apply to all" is on, re-sync
  // every matching scan from the result IN THE SAME UPDATE. Every per-scan
  // setter goes through here: the box used to copy once, when ticked, so any
  // edit made afterwards (a rename, most visibly) landed on the current scan
  // only while the box still read as checked and still unlocked Import.
  const editCurrent = useCallback((fn: (c: ScanConfig) => ScanConfig) => {
    if (applyToAllRef.current) {
      // The last-edited scan is the source from now on, so a late preview is
      // synced to what the user last did, wherever they did it.
      sourceIdxRef.current = stepIdx;
      setSourceIdx(stepIdx);
    }
    setConfigs((prev) => {
      const next = prev.map((c, i) => (i === stepIdx ? fn(c) : c));
      return applyToAllRef.current ? propagateFrom(next, stepIdx) : next;
    });
  }, [stepIdx]);

  // Import a mobile-platform trajectory file for the current scan. The picked
  // PoseStream is set on this scan (marked an explicit choice) and, since most
  // multi-file imports are one platform pass split across files, auto-populated
  // onto every OTHER scan still at its inherited/empty default — never clobbering
  // a scan the user gave its own trajectory. A bad file shows an inline error.
  // With "apply to all" on, matching scans follow the source regardless.
  const importTrajectory = useCallback(async () => {
    try {
      const stream = await pickAndParseTrajectory();
      if (!stream) return; // user canceled the picker
      setConfigs((prev) => {
        const next = prev.map((c, i) => {
          if (i === stepIdx) {
            return { ...c, trajectory: stream, trajectoryExplicit: true, trajectoryError: null };
          }
          // Default the other scans to this trajectory, but leave any scan the
          // user explicitly set to its own choice.
          if (!c.trajectoryExplicit) return { ...c, trajectory: stream, trajectoryError: null };
          return c;
        });
        return applyToAllRef.current ? propagateFrom(next, stepIdx) : next;
      });
    } catch (err) {
      const msg = err instanceof PoseStreamParseError || err instanceof Error
        ? err.message : String(err);
      setConfigs((prev) => prev.map((c, i) => i === stepIdx ? { ...c, trajectoryError: msg } : c));
    }
  }, [stepIdx]);

  // Tick/untick "apply to all". Ticking syncs every matching scan from the one
  // on screen once (with a toast saying how many), and from then on every edit
  // re-syncs through `editCurrent` and every late preview through the preview
  // effect. If this scan's own preview hasn't landed yet there is nothing to
  // copy — the preview effect performs the sync when it does.
  const toggleApplyToAll = useCallback((on: boolean) => {
    applyToAllRef.current = on;
    setApplyToAll(on);
    if (!on) return;
    sourceIdxRef.current = stepIdx;
    setSourceIdx(stepIdx);
    const src = configs[stepIdx];
    if (!src?.preview) return;
    let applied = 0, skipped = 0;
    configs.forEach((c, i) => {
      if (i === stepIdx) return;
      if (propagateSettings(src, c)) applied++; else skipped++;
    });
    setConfigs((prev) => propagateFrom(prev, stepIdx));
    if (applied > 0) showToast({ title: `Applied settings to ${applied} other scan(s)`, type: 'success' });
    if (skipped > 0) showToast({ title: `Skipped ${skipped} scan(s) with a different column layout`, type: 'info' });
  }, [configs, stepIdx]);

  const allReady = useMemo(
    () => configs.every((c) => !c.loading && hasXYZ(c)),
    [configs],
  );

  const handleImport = useCallback(() => {
    const results: WizardResult[] = inputs.map((input, i) => toWizardResult(input, configs[i]));
    onComplete(results);
  }, [inputs, configs, onComplete]);

  const goPrev = () => setStepIdx((i) => Math.max(0, i - 1));
  const goNext = () => setStepIdx((i) => {
    const next = Math.min(total - 1, i + 1);
    setMaxStepReached((m) => Math.max(m, next));
    return next;
  });

  // For a single scan there's nothing to step through; for many, every scan must
  // be either seen (stepped to with Next) or covered by "apply to all" — which
  // only covers scans whose layout MATCHES the source. A differently-laid-out
  // scan is skipped by the copy, so ticking the box must not let it import
  // unseen on its defaults.
  const unreviewed = useMemo(() => {
    if (total <= 1) return [] as number[];
    const srcSig = applyToAll ? layoutSignature(configs[sourceIdx]) : null;
    return configs
      .map((_c, i) => i)
      .filter((i) => i > maxStepReached
        && !(srcSig !== null && layoutSignature(configs[i]) === srcSig));
  }, [total, applyToAll, configs, sourceIdx, maxStepReached]);
  const reviewedAll = unreviewed.length === 0;


  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center" onKeyDown={(e) => e.stopPropagation()}>
      <div className="absolute inset-0 bg-black/60 backdrop-blur-sm" />

      <div
        data-testid="import-wizard"
        className="relative bg-neutral-800 rounded-xl shadow-2xl border border-neutral-700 w-full max-w-5xl mx-4 overflow-hidden"
      >
        {/* Header + stepper */}
        <div className="flex items-center justify-between px-4 py-3 border-b border-neutral-700 bg-neutral-800/90">
          <div className="flex items-center gap-2 min-w-0">
            <FileUp className="w-4 h-4 text-neutral-400 flex-shrink-0" />
            <h2 className="text-sm font-semibold text-white">Import point cloud</h2>
            {total > 1 && (
              <span data-testid="import-wizard-step" className="text-[11px] text-neutral-400 truncate">
                — scan {stepIdx + 1} of {total}: <span className="text-neutral-200">{current?.fileName}</span>
              </span>
            )}
            {total === 1 && (
              <span className="text-[11px] text-neutral-400 truncate">— {current?.fileName}</span>
            )}
          </div>
          <button onClick={onCancel} className="p-1 rounded hover:bg-neutral-700 transition-colors" title="Cancel">
            <X className="w-4 h-4 text-neutral-400" />
          </button>
        </div>


        <div className="p-4 space-y-3 max-h-[70vh] overflow-y-auto custom-scrollbar">
          <PointCloudImportOptions
            cfg={cfg}
            onEdit={editCurrent}
            onImportTrajectory={importTrajectory}
            trajectoryNote={total > 1 ? 'Importing one here fills in the other scans by default; you can give each scan its own.' : undefined}
          />
        </div>

        {/* Footer */}
        <div className="flex items-center justify-between px-4 py-3 border-t border-neutral-700 bg-neutral-800/90">
          <div className="flex items-center gap-2">
            {total > 1 && (
              <>
                <button
                  onClick={goPrev}
                  disabled={stepIdx === 0}
                  data-testid="import-wizard-prev"
                  className="flex items-center gap-1 px-2.5 py-1.5 text-xs bg-neutral-700 text-neutral-200 rounded hover:bg-neutral-600 disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
                >
                  <ChevronLeft className="w-3.5 h-3.5" /> Back
                </button>
                <button
                  onClick={goNext}
                  disabled={stepIdx >= total - 1}
                  data-testid="import-wizard-next"
                  className="flex items-center gap-1 px-2.5 py-1.5 text-xs bg-neutral-700 text-neutral-200 rounded hover:bg-neutral-600 disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
                >
                  Next <ChevronRight className="w-3.5 h-3.5" />
                </button>
                <label className="ml-2 flex items-center gap-2 text-[11px] text-neutral-300 cursor-pointer">
                  <input
                    type="checkbox"
                    data-testid="import-wizard-apply-all"
                    checked={applyToAll}
                    onChange={(e) => toggleApplyToAll(e.target.checked)}
                    className="w-3.5 h-3.5 rounded border-neutral-600 bg-neutral-700 text-blue-500 focus:ring-0 cursor-pointer"
                  />
                  Apply these settings to all scans with the same column layout
                </label>
              </>
            )}
          </div>
          <div className="flex items-center gap-2">
            {total > 1 && !reviewedAll && (
              <span data-testid="import-wizard-review-hint" className="text-[11px] text-neutral-400">
                {applyToAll && unreviewed.every((i) => !configs[i].loading)
                  ? `Scan${unreviewed.length > 1 ? 's' : ''} ${unreviewed.map((i) => i + 1).join(', ')} `
                    + `${unreviewed.length > 1 ? 'have' : 'has'} a different column layout — step to `
                    + `${unreviewed.length > 1 ? 'them' : 'it'} to review.`
                  : 'Step through every scan, or check “apply to all”, to import.'}
              </span>
            )}
            <button
              onClick={onCancel}
              data-testid="import-wizard-cancel"
              className="px-3 py-1.5 text-xs text-neutral-300 hover:text-white transition-colors"
            >
              Cancel
            </button>
            <button
              onClick={handleImport}
              disabled={!allReady || !reviewedAll}
              data-testid="import-wizard-import"
              className="px-4 py-1.5 text-xs font-medium bg-blue-600 text-white rounded hover:bg-blue-500 disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
            >
              Import {total > 1 ? `${total} scans` : ''}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
