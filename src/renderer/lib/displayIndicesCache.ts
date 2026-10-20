/**
 * Per-cloud memo for the viewer's visible-point index array.
 *
 * The viewer's render loop asks for every flat cloud's indices on EVERY render,
 * and it re-renders for reasons unrelated to the cloud. Recomputing meant two
 * full passes over the points and a NEW Uint32Array each time; the new identity
 * made <PointCloud> upload a fresh GPU index buffer, and three.js never frees
 * the one it replaced. The result depends only on what is keyed here: the
 * cloud's data, its erase set (always replaced, never mutated in place), its
 * translation, whether the crop preview is shown, and the compute function,
 * whose identity tracks the crop inputs.
 */
export interface DisplayIndicesInputs<F> {
  compute: F;
  erased: Set<number>;
  tx: number;
  ty: number;
  tz: number;
  preview: boolean;
}

export function createDisplayIndicesCache<D extends object, F>() {
  const cache = new WeakMap<D, { inputs: DisplayIndicesInputs<F>; out: Uint32Array | null }>();
  return (data: D, inputs: DisplayIndicesInputs<F>, run: () => Uint32Array | null): Uint32Array | null => {
    const hit = cache.get(data);
    if (hit) {
      const k = hit.inputs;
      if (k.compute === inputs.compute && k.erased === inputs.erased && k.preview === inputs.preview
        && k.tx === inputs.tx && k.ty === inputs.ty && k.tz === inputs.tz) {
        return hit.out;
      }
    }
    const out = run();
    cache.set(data, { inputs, out });
    return out;
  };
}
