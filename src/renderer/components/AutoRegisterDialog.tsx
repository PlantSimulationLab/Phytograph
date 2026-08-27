// "Auto-Register Clouds" dialog — coarse global registration followed by ICP.
//
// Distinct from AlignDialog (plain ICP) on purpose. ICP is a LOCAL method: it
// polishes a pair that already starts close together, and cannot recover a
// large rotation. This tool matches the clouds' overall top-down pattern first,
// so it works from an arbitrary starting pose.
//
// Either side may be a streamed (octree) cloud; the transform is applied on its
// backend session and the octree rebuilt.
//
// ---------------------------------------------------------------------------
// Why this dialog has almost no settings
//
// It used to offer three: scene type, search method, and which per-plant
// landmark to match on. All three were measured to be inert or misleading on
// the path that actually runs, so they were removed rather than repaired:
//
//   * Search method — the backend only consults it in the anchors-failed
//     fallback. On any vegetated cloud "plant landmarks" and "surface shape"
//     produced bit-identical results (both took the landmark path, 16/16
//     anchors, 0.00 deg / 0.00 m). It was a choice with one outcome.
//   * Scene type — `natural` and `agriculture` are the same code path; the only
//     branch is `!= "urban"`. And built scenes are now DETECTED and confirmed
//     (see SceneTypeMismatchDialog) rather than declared up front, which is
//     both fewer questions and harder to get wrong.
//   * Match on / Detail size — only read by the fallback path, so on the
//     default search they changed nothing at all.
//
// Registering three or more scans never consulted any of them in the first
// place: that path tries several coarse variants per pair and keeps whichever
// makes the whole scan graph self-consistent. Measuring the setting beats
// asking the user to guess it, so the remaining control is the one piece of
// information the software genuinely cannot derive — whether the recorded
// scanner heading is trustworthy.
import { useState, useEffect, useMemo } from 'react';
import { Sparkles, X } from 'lucide-react';
import { ObjectPicker, type PickerItem } from './ObjectPicker';

export interface AutoRegisterCloudOption {
  id: string;
  label: string;
  color?: string;
  /** Whether this scan recorded a scanner position/pose. Gates the heading
   *  option below — see `AutoRegisterOptions.useHeading`. */
  hasOrigin?: boolean;
}

export interface AutoRegisterOptions {
  /** Use the scanner heading, when the scans carry one, to constrain the
   *  search.
   *
   *  This is only ever offered when EVERY selected scan recorded a pose. The
   *  prior asserts that the scans are already placed in a common frame and so
   *  differ by ~0 degrees of heading, which narrows the yaw sweep to +/-30
   *  degrees. That is a large accuracy win when true and a silent catastrophe
   *  when false: measured against known ground truth, a pair 90 degrees apart
   *  came back 89.16 deg / 11.82 m wrong and a pair 180 degrees apart came back
   *  179.89 deg / 20.00 m wrong, both reported CONFIDENT, because the correct
   *  answer sat outside the search space entirely. Scans with no recorded pose
   *  cannot support the assertion, so the box is disabled rather than trusted.
   */
  useHeading: boolean;
}

interface AutoRegisterDialogProps {
  isOpen: boolean;
  onClose: () => void;
  clouds: AutoRegisterCloudOption[];
  initialSelectedIds?: Set<string>;
  isRunning?: boolean;
  /** `sourceIds` may hold more than one scan: three or more in total are
   *  registered as a set so their alignments can validate each other. */
  onRegister: (targetId: string, sourceIds: string[], options: AutoRegisterOptions) => void;
}

export function AutoRegisterDialog({
  isOpen, onClose, clouds, initialSelectedIds, isRunning, onRegister,
}: AutoRegisterDialogProps) {
  const [targetId, setTargetId] = useState<string>('');
  const [sourceIds, setSourceIds] = useState<Set<string>>(new Set());
  const [useHeading, setUseHeading] = useState(true);

  useEffect(() => {
    if (!isOpen) return;
    // Seed from the current selection: first two selected clouds → target, source.
    const seeded = initialSelectedIds
      ? clouds.filter(c => initialSelectedIds.has(c.id)).map(c => c.id)
      : [];
    setTargetId(seeded[0] ?? '');
    // Everything else the user had selected moves onto it. Seeding the whole
    // selection matters: three or more scans unlock the loop check, and a user
    // who selected four clouds means to register four.
    setSourceIds(new Set(seeded.slice(1)));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isOpen]);

  const targetItems = useMemo<PickerItem[]>(
    () => clouds.map(c => ({ id: c.id, label: c.label, color: c.color })),
    [clouds],
  );
  const sourceItems = useMemo<PickerItem[]>(
    () => clouds.map(c => ({
      id: c.id,
      label: c.label,
      color: c.color,
      disabledReason: c.id === targetId ? 'Already the target' : undefined,
    })),
    [clouds, targetId],
  );

  useEffect(() => {
    if (targetId && sourceIds.has(targetId)) {
      const next = new Set(sourceIds);
      next.delete(targetId);
      setSourceIds(next);
    }
  }, [targetId, sourceIds]);

  // Whether every scan in this run recorded a pose. Derived from the CURRENT
  // selection rather than stored, so changing the picker re-decides it.
  const selected = useMemo(
    () => clouds.filter(c => c.id === targetId || sourceIds.has(c.id)),
    [clouds, targetId, sourceIds],
  );
  const headingAvailable = selected.length > 0 && selected.every(c => c.hasOrigin);

  if (!isOpen) return null;

  const canRun = !!targetId && sourceIds.size > 0 && !isRunning;
  // Three or more scans form a closed loop, which is the only way a
  // wrong-but-well-fitting alignment can be detected at all.
  const validated = sourceIds.size >= 2;
  // A set is registered by a different path, which selects its own coarse
  // settings by loop consistency and takes no heading prior. Offering the
  // option there would be offering a control that does nothing.
  const isSet = sourceIds.size >= 2;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center" onKeyDown={(e) => e.stopPropagation()}>
      <div className="absolute inset-0 bg-black/60 backdrop-blur-sm" onClick={onClose} />
      <div data-testid="auto-register-dialog" className="relative bg-neutral-800 rounded-xl shadow-2xl border border-neutral-700 w-full max-w-xl mx-4 overflow-hidden">
        <div className="flex items-center justify-between px-4 py-3 border-b border-neutral-700 bg-neutral-800/90">
          <div className="flex items-center gap-2">
            <Sparkles className="w-4 h-4 text-neutral-400" />
            <h2 className="text-sm font-semibold text-white">Auto-Register Clouds</h2>
          </div>
          <button onClick={onClose} className="p-1 rounded hover:bg-neutral-700 transition-colors">
            <X className="w-4 h-4 text-neutral-400" />
          </button>
        </div>

        <div className="p-4 space-y-4 max-h-[70vh] overflow-y-auto">
          <p className="text-xs text-neutral-400">
            Finds the alignment automatically, even when the clouds start far apart or
            rotated. The <span className="text-neutral-200 font-medium">target</span> stays
            fixed and the other scans move onto it. Select three or more and they
            are registered as a set, each alignment checked against the others.
          </p>
          <ObjectPicker
            data-testid="auto-register-target-picker"
            label="Target (fixed)"
            items={targetItems}
            selectedIds={targetId ? new Set([targetId]) : new Set()}
            onChange={(s) => setTargetId([...s][0] ?? '')}
            mode="single"
            emptyMessage="No point clouds available."
          />
          <ObjectPicker
            data-testid="auto-register-source-picker"
            label="Scans to move"
            items={sourceItems}
            selectedIds={sourceIds}
            onChange={setSourceIds}
            mode="multi"
            emptyMessage="No point clouds available."
          />

          {/* State plainly what the extra scans buy, because the difference is
              not cosmetic: with two scans a wrong alignment is undetectable. */}
          <p
            data-testid="auto-register-validation-note"
            className={`text-[11px] rounded px-2 py-1.5 ${validated
              ? 'text-emerald-300/90 bg-emerald-500/10'
              : 'text-amber-300/90 bg-amber-500/10'}`}
          >
            {validated
              ? `Registering ${sourceIds.size + 1} scans together — each alignment is `
                + 'cross-checked against the others, and any that disagree are reported '
                + 'rather than applied.'
              : 'With two scans there is nothing to cross-check against. On a repetitive '
                + 'planting a wrong alignment can fit better than the right one, so add a '
                + 'third overlapping scan when you can.'}
          </p>

          {/* Hidden for a set: that path chooses its own coarse settings by
              loop consistency and never takes a heading prior. */}
          {!isSet && (
            <label
              className={`flex items-start gap-2 text-xs ${headingAvailable
                ? 'text-neutral-300' : 'text-neutral-500'}`}
            >
              <input
                data-testid="auto-register-use-heading"
                type="checkbox"
                checked={headingAvailable && useHeading}
                disabled={!headingAvailable}
                onChange={(e) => setUseHeading(e.target.checked)}
                className="mt-0.5"
              />
              <span>
                Use the scanner heading
                <span className="block text-[11px] text-neutral-500">
                  {headingAvailable
                    ? 'These scans recorded their position, so the search can be narrowed '
                      + 'to the heading they report. Untick it if you know that heading is wrong.'
                    : 'Unavailable — these scans did not record a scanner position, so there '
                      + 'is no heading to narrow the search with. Every orientation is searched.'}
                </span>
              </span>
            </label>
          )}
        </div>

        <div className="flex items-center justify-end px-4 py-3 border-t border-neutral-700 bg-neutral-800/90">
          <button
            data-testid="auto-register-run"
            onClick={() => {
              // Never emit a heading prior the selection cannot support, even
              // if the box was ticked before the picker changed under it.
              onRegister(targetId, [...sourceIds], { useHeading: headingAvailable && useHeading });
              onClose();
            }}
            disabled={!canRun}
            className={`px-4 py-1.5 rounded text-xs font-medium transition-colors ${
              canRun ? 'bg-green-600 hover:bg-green-500 text-white' : 'bg-neutral-700 text-neutral-500 cursor-not-allowed'
            }`}
          >
            {isRunning ? 'Registering…' : 'Register'}
          </button>
        </div>
      </div>
    </div>
  );
}
