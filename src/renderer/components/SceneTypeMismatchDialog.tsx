// Shown when a cloud's geometry disagrees strongly with the method about to be
// used — in practice, a street of buildings about to be matched plant by plant.
//
// This prompt REPLACED a scene-type dropdown. Asking up front made the user
// guess a value the software can measure in ~0.05 s, and two of the three
// choices did the same thing anyway; detecting the one distinction that changes
// the algorithm (vegetated vs built) and confirming it is both fewer questions
// and harder to get wrong.
//
// It appears BEFORE the expensive stage, so the detour costs a moment instead
// of a minute of segmentation. It only ever appears for a disagreement that
// would change the ALGORITHM; a milder one rides along as a note in the result,
// because a prompt that fired on ordinary variation would be dismissed
// reflexively — worse than no prompt at all.
//
// Nothing is switched behind the user's back: the run stops here and waits.
import { AlertTriangle, X } from 'lucide-react';
import type { SceneType } from '../utils/backendApi';

const SCENE_LABELS: Record<SceneType, string> = {
  agriculture: 'Crops or orchard',
  natural: 'Natural woodland',
  urban: 'Buildings or built site',
};

export interface SceneMismatch {
  targetId: string;
  sourceId: string;
  opts: unknown;
  observed: SceneType;
  chosen: SceneType;
  message: string;
}

interface Props {
  mismatch: SceneMismatch | null;
  onCancel: () => void;
  onChoose: (sceneType: SceneType) => void;
}

export function SceneTypeMismatchDialog({ mismatch, onCancel, onChoose }: Props) {
  if (!mismatch) return null;
  const { observed, chosen, message } = mismatch;

  return (
    <div className="fixed inset-0 z-[60] flex items-center justify-center" onKeyDown={(e) => e.stopPropagation()}>
      <div className="absolute inset-0 bg-black/60 backdrop-blur-sm" onClick={onCancel} />
      <div
        data-testid="scene-mismatch-dialog"
        className="relative bg-neutral-800 rounded-xl shadow-2xl border border-neutral-700 w-full max-w-md mx-4 overflow-hidden"
      >
        <div className="flex items-center justify-between px-4 py-3 border-b border-neutral-700 bg-neutral-800/90">
          <div className="flex items-center gap-2">
            <AlertTriangle className="w-4 h-4 text-amber-400" />
            <h2 className="text-sm font-semibold text-white">Check the scene type</h2>
          </div>
          <button onClick={onCancel} className="p-1 rounded hover:bg-neutral-700 transition-colors">
            <X className="w-4 h-4 text-neutral-400" />
          </button>
        </div>

        <div className="p-4 space-y-3">
          <p className="text-xs text-neutral-300">{message}</p>
          <p className="text-[11px] text-neutral-500">
            Auto-Register was about to match this as{' '}
            <span className="text-neutral-300">{SCENE_LABELS[chosen]}</span>.
            Nothing has been changed — pick how to continue.
          </p>
        </div>

        <div className="flex items-center justify-end gap-2 px-4 py-3 border-t border-neutral-700 bg-neutral-800/90">
          <button
            data-testid="scene-mismatch-cancel"
            onClick={onCancel}
            className="px-3 py-1.5 rounded text-xs font-medium text-neutral-300 hover:bg-neutral-700 transition-colors"
          >
            Cancel
          </button>
          <button
            data-testid="scene-mismatch-keep"
            onClick={() => onChoose(chosen)}
            className="px-3 py-1.5 rounded text-xs font-medium bg-neutral-700 text-neutral-100 hover:bg-neutral-600 transition-colors"
          >
            Match as {SCENE_LABELS[chosen]} anyway
          </button>
          <button
            data-testid="scene-mismatch-switch"
            onClick={() => onChoose(observed)}
            className="px-3 py-1.5 rounded text-xs font-medium bg-green-600 text-white hover:bg-green-500 transition-colors"
          >
            Switch to {SCENE_LABELS[observed]}
          </button>
        </div>
      </div>
    </div>
  );
}
