// A callback that must see state written by its own earlier calls has to read
// through a ref, not a closed-over value.
//
// This pins the fix for a real defect. Multi-scan registration applies one
// transform per scan by awaiting a shared apply helper in a loop. That helper
// was a `useCallback` closing over the `clouds` array and doing
// `clouds.find(...)`. React does not re-create a callback while it is running,
// so every iteration after the first read cloud state from before the loop
// began and transformed a cloud that had already moved. The error compounds:
// measured ~10 m out on a 3-scan GrapeX set whose backend poses were correct to
// 0.13 m.
//
// PointCloudViewer.tsx is ~18k lines bound to three.js and cannot be mounted
// here, so this tests the mechanism the fix relies on rather than the component.
import { describe, expect, it } from 'vitest';
import { act, renderHook } from '@testing-library/react';
import { useCallback, useRef, useState } from 'react';

function useTracker() {
  const [items, setItems] = useState<Record<string, number>>({ a: 0, b: 0 });
  const itemsRef = useRef(items);
  itemsRef.current = items;

  // Both readers are built in the SAME render, closing over the same state.
  const readClosure = useCallback((id: string) => items[id], [items]);
  const readLive = useCallback((id: string) => itemsRef.current[id], []);
  const bump = useCallback((id: string, by: number) => {
    setItems(prev => ({ ...prev, [id]: prev[id] + by }));
  }, []);

  return { items, readClosure, readLive, bump };
}

describe('reading state a callback has already written', () => {
  it('a ref sees the update; the closure does not', () => {
    const { result } = renderHook(() => useTracker());

    // Capture the callbacks created in the FIRST render, exactly as an async
    // loop does when it holds one reference and calls it repeatedly.
    const staleClosureRead = result.current.readClosure;
    const liveRead = result.current.readLive;

    act(() => { result.current.bump('a', 10); });

    // The ref was reassigned during the commit, so it reports the new value.
    expect(liveRead('a')).toBe(10);
    // The closure still holds the array from before the update.
    expect(staleClosureRead('a')).toBe(0);
  });

  it('compounds across several updates, which is why the error grew per scan', () => {
    const { result } = renderHook(() => useTracker());
    const staleClosureRead = result.current.readClosure;
    const liveRead = result.current.readLive;

    act(() => { result.current.bump('a', 3); });
    act(() => { result.current.bump('a', 4); });
    act(() => { result.current.bump('a', 5); });

    expect(liveRead('a')).toBe(12);
    // Every read after the first is wrong by the whole accumulated amount --
    // the shape of a per-scan compounding misalignment.
    expect(staleClosureRead('a')).toBe(0);
  });

  it('tracks each item independently', () => {
    const { result } = renderHook(() => useTracker());
    const liveRead = result.current.readLive;

    act(() => { result.current.bump('a', 2); });
    act(() => { result.current.bump('b', 7); });

    expect(liveRead('a')).toBe(2);
    expect(liveRead('b')).toBe(7);
  });
});


// The mechanism test above cannot notice if the viewer stops USING the ref, so
// pin the call site itself. A source assertion is blunt, but the alternative is
// mounting an 18k-line three.js component to catch a one-line revert.
describe('PointCloudViewer apply path', () => {
  it('resolves the ICP source and target through the live ref', async () => {
    const { readFile } = await import('node:fs/promises');
    const { join } = await import('node:path');
    const source = await readFile(
      join(process.cwd(), 'src/renderer/components/PointCloudViewer.tsx'), 'utf8');

    const applyBlock = source.slice(
      source.indexOf('const handleCloudToCloudICP = useCallback'),
      source.indexOf('const handleMeshToMeshICP'));
    expect(applyBlock.length).toBeGreaterThan(0);

    expect(applyBlock).toContain("cloudsRef.current.find(c => c.id === tId)");
    expect(applyBlock).toContain("cloudsRef.current.find(c => c.id === sId)");
    // The closed-over array must not be used to resolve either cloud: a
    // multi-scan apply calls this repeatedly inside one render.
    expect(applyBlock).not.toContain("clouds.find(c => c.id === tId)");
    expect(applyBlock).not.toContain("clouds.find(c => c.id === sId)");
  });
});
