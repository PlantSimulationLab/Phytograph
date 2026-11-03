// "Something may be about to change what is on screen."
//
// The idle-render governor (IdleFrameGovernor.tsx) drops the render loop to a
// slow tick when nothing is happening. Most scene changes reach it through a
// React render or user input, but a fetch can finish and change the scene with
// neither, so the two fetch chokepoints (backendApi's, and potree's request
// manager) report here. Kept free of three.js and React so both can import it.
type Listener = () => void;

const listeners = new Set<Listener>();

export function noteRenderActivity(): void {
  for (const listener of listeners) listener();
}

export function onRenderActivity(listener: Listener): () => void {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}

/** Report a fetch both when it starts and when it settles. */
export function trackedFetch(run: () => Promise<Response>): Promise<Response> {
  noteRenderActivity();
  return run().finally(noteRenderActivity);
}
