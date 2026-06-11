// Disable React's dev-only "Components ⚛" performance track BEFORE React loads.
//
// React 19's development builds (react-dom and the react-reconciler vendored
// inside @react-three/fiber) record every component render to the DevTools
// Performance panel. When a component re-renders with a changed props object,
// the instrumentation deep-diffs prev vs next props to annotate the entry —
// and its object stringifier recurses into any plain value with `for...in`
// up to depth 3. A TypedArray's indices are all enumerable own properties, so
// a multi-million-element buffer prop (point cloud positions, mesh triangle
// color buffers) explodes into tens of millions of key/value strings: ~20 s
// of GC thrash and then a renderer OOM at the ~4 GB V8 pointer-compression
// cap (which no --max-old-space-size flag can raise). A 4.3 M-triangle mesh's
// color-mode switch alone demands ~10 GB. Verified against react-dom 19.2.6
// (`addValueToProperties` in react-dom-client.development.js — the recursion
// is not guarded for TypedArrays).
//
// React gates the whole feature on `typeof console.timeStamp === 'function'`
// (checked once at module evaluation), so removing it here — before any React
// module evaluates — turns the track off. Cost: no "Components ⚛" lane in the
// Performance panel and no console.timeStamp API in dev. Production builds of
// React contain none of this instrumentation, so packaged apps are unaffected
// and we leave them untouched.
//
// This module must stay the FIRST import of main.tsx so it runs before
// react-dom's module-scope code.
if (import.meta.env.DEV) {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (console as any).timeStamp = undefined;
}

export {};
