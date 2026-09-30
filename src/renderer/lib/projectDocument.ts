// The renderer's half of a .phyto project: the scene document.
//
// Format and the whole-file layout: docs/docs/developers/architecture/
// project-file.md. The backend stores this document's bytes verbatim (as
// `scene.bin`) and never parses them, so the format is ours alone.
//
// The scene is plain data with three things JSON cannot hold, each written as
// a tagged object:
//   {"$buf": k, "dtype": "f32"}  a typed array, stored as buffer k
//   {"$map": [[key, value], ...]} a Map
//   {"$set": [...]}              a Set
// and one thing it holds badly:
//   {"$chunks": [k, ...]}        a long array, its items as JSON in buffers
//                                k... (dtype "json"), CHUNK_ITEMS per chunk
// V8 caps a string at ~512 MB, and the document used to be ONE
// JSON.stringify on save and one JSON.parse on open: a scene with a big LAD
// result (a record per voxel), many QSM cylinders or a large inventory could
// fail to save or, worse, save and then fail to open. With long arrays
// chunked, no string is ever bigger than one chunk.
// Everything else is JSON as-is. Serializing generically, rather than per
// object type, is what keeps a new field on a mesh or scan from being silently
// dropped by the project file.
//
// Container ("PSC1"): 'PSC1' | u32 header length | header JSON (UTF-8) |
// zero-pad to 8 | each buffer's bytes, each padded to 8. The header holds the
// document and the buffer table [{dtype, byteLength}].

import * as THREE from 'three';

export const PROJECT_SCENE_MAGIC = 'PSC1';
// 2: long arrays as `$chunks`. A version-1 document still decodes.
export const PROJECT_DOC_VERSION = 2;

/** Items per `$chunks` chunk (and the length above which an array is chunked). */
export const CHUNK_ITEMS = 8192;

/** A chunk of JSON text travelling in the buffer table (dtype "json"). */
class JsonChunk extends Uint8Array {}

type TypedArray =
  | Float32Array | Float64Array | Int8Array | Uint8Array | Uint8ClampedArray
  | Int16Array | Uint16Array | Int32Array | Uint32Array;

const DTYPES: Record<string, { ctor: new (buf: ArrayBuffer, off: number, len: number) => TypedArray; bytes: number }> = {
  f32: { ctor: Float32Array, bytes: 4 },
  f64: { ctor: Float64Array, bytes: 8 },
  i8: { ctor: Int8Array, bytes: 1 },
  u8: { ctor: Uint8Array, bytes: 1 },
  u8c: { ctor: Uint8ClampedArray, bytes: 1 },
  i16: { ctor: Int16Array, bytes: 2 },
  u16: { ctor: Uint16Array, bytes: 2 },
  i32: { ctor: Int32Array, bytes: 4 },
  u32: { ctor: Uint32Array, bytes: 4 },
};

function dtypeOf(a: TypedArray): string {
  if (a instanceof JsonChunk) return 'json';
  if (a instanceof Float32Array) return 'f32';
  if (a instanceof Float64Array) return 'f64';
  if (a instanceof Int8Array) return 'i8';
  if (a instanceof Uint8ClampedArray) return 'u8c';
  if (a instanceof Uint8Array) return 'u8';
  if (a instanceof Int16Array) return 'i16';
  if (a instanceof Uint16Array) return 'u16';
  if (a instanceof Int32Array) return 'i32';
  return 'u32';
}

/** Turn a value into JSON-safe data, moving typed arrays into `buffers`. */
export function toDocValue(v: unknown, buffers: TypedArray[]): unknown {
  if (v === null || v === undefined) return v ?? null;
  if (ArrayBuffer.isView(v) && !(v instanceof DataView)) {
    const a = v as TypedArray;
    buffers.push(a);
    return { $buf: buffers.length - 1, dtype: dtypeOf(a) };
  }
  if (v instanceof Map) return { $map: toDocValue([...v.entries()], buffers) };
  if (v instanceof Set) return { $set: toDocValue([...v], buffers) };
  if (Array.isArray(v)) {
    if (v.length <= CHUNK_ITEMS) return v.map(x => toDocValue(x, buffers));
    const enc = new TextEncoder();
    const chunks: number[] = [];
    for (let i = 0; i < v.length; i += CHUNK_ITEMS) {
      const items = v.slice(i, i + CHUNK_ITEMS).map(x => toDocValue(x, buffers));
      const bytes = enc.encode(JSON.stringify(items));
      const chunk = new JsonChunk(bytes.buffer, bytes.byteOffset, bytes.byteLength);
      buffers.push(chunk);
      chunks.push(buffers.length - 1);
    }
    return { $chunks: chunks };
  }
  if (typeof v === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, x] of Object.entries(v as Record<string, unknown>)) {
      if (x === undefined || typeof x === 'function') continue;
      out[k] = toDocValue(x, buffers);
    }
    return out;
  }
  if (typeof v === 'number' && !Number.isFinite(v)) {
    // JSON has no NaN/Infinity; tag them so they survive.
    return { $num: Number.isNaN(v) ? 'NaN' : v > 0 ? 'Infinity' : '-Infinity' };
  }
  if (typeof v === 'function' || typeof v === 'symbol') return null;
  return v;
}

/** The inverse of toDocValue. */
export function fromDocValue(v: unknown, buffers: TypedArray[]): unknown {
  if (v === null || typeof v !== 'object') return v;
  if (Array.isArray(v)) return v.map(x => fromDocValue(x, buffers));
  const o = v as Record<string, unknown>;
  if ('$chunks' in o && Array.isArray(o.$chunks) && Object.keys(o).length === 1) {
    const dec = new TextDecoder();
    const out: unknown[] = [];
    for (const k of o.$chunks as number[]) {
      const b = buffers[k];
      if (!(b instanceof Uint8Array)) throw new Error(`project scene is missing chunk ${k}`);
      for (const x of JSON.parse(dec.decode(b)) as unknown[]) out.push(fromDocValue(x, buffers));
    }
    return out;
  }
  if ('$buf' in o && typeof o.$buf === 'number') {
    const b = buffers[o.$buf];
    if (!b) throw new Error(`project scene is missing buffer ${o.$buf}`);
    return b;
  }
  if ('$map' in o && o.$map && typeof o.$map === 'object') {
    // An array of [key, value] pairs, or (a long map) that array chunked.
    return new Map(fromDocValue(o.$map, buffers) as [unknown, unknown][]);
  }
  if ('$set' in o && o.$set && typeof o.$set === 'object') return new Set(fromDocValue(o.$set, buffers) as unknown[]);
  if ('$num' in o && typeof o.$num === 'string' && Object.keys(o).length === 1) return Number(o.$num);
  const out: Record<string, unknown> = {};
  for (const [k, x] of Object.entries(o)) out[k] = fromDocValue(x, buffers);
  return out;
}

const pad8 = (n: number) => (n + 7) & ~7;

/** Encode a document into the PSC1 container. */
export function encodeProjectScene(doc: unknown): Uint8Array {
  const buffers: TypedArray[] = [];
  const data = toDocValue(doc, buffers);
  const header = new TextEncoder().encode(JSON.stringify({
    version: PROJECT_DOC_VERSION,
    buffers: buffers.map(b => ({ dtype: dtypeOf(b), byteLength: b.byteLength })),
    doc: data,
  }));
  let total = pad8(8 + header.length);
  for (const b of buffers) total += pad8(b.byteLength);
  const out = new Uint8Array(total);
  out.set(new TextEncoder().encode(PROJECT_SCENE_MAGIC), 0);
  new DataView(out.buffer).setUint32(4, header.length, true);
  out.set(header, 8);
  let off = pad8(8 + header.length);
  for (const b of buffers) {
    out.set(new Uint8Array(b.buffer, b.byteOffset, b.byteLength), off);
    off += pad8(b.byteLength);
  }
  return out;
}

/** Decode a PSC1 container back into the document (buffers are views into a
 * copy-free slice of `bytes` when aligned, else copies). */
export function decodeProjectScene(bytes: ArrayBuffer | Uint8Array): unknown {
  const u8 = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  if (u8.length < 8 || new TextDecoder().decode(u8.subarray(0, 4)) !== PROJECT_SCENE_MAGIC) {
    throw new Error('Not a Phytograph project scene.');
  }
  const hlen = new DataView(u8.buffer, u8.byteOffset, u8.byteLength).getUint32(4, true);
  if (8 + hlen > u8.length) throw new Error('Project scene is truncated.');
  const header = JSON.parse(new TextDecoder().decode(u8.subarray(8, 8 + hlen))) as {
    version: number; buffers: { dtype: string; byteLength: number }[]; doc: unknown;
  };
  if (header.version > PROJECT_DOC_VERSION) {
    throw new Error('This project was saved by a newer Phytograph; update to open it.');
  }
  let off = pad8(8 + hlen);
  const buffers: TypedArray[] = header.buffers.map(({ dtype, byteLength }) => {
    if (dtype === 'json') {
      if (off + byteLength > u8.length) throw new Error('Project scene is truncated.');
      const chunk = u8.subarray(off, off + byteLength);
      off += pad8(byteLength);
      return chunk;
    }
    const spec = DTYPES[dtype];
    if (!spec) throw new Error(`Unknown array type ${dtype} in project.`);
    if (off + byteLength > u8.length) throw new Error('Project scene is truncated.');
    // Copy into its own buffer: aligned, independent of the download buffer,
    // and transferable to the renderers as ordinary typed arrays.
    const copy = u8.slice(off, off + byteLength);
    off += pad8(byteLength);
    return new spec.ctor(copy.buffer, 0, byteLength / spec.bytes);
  });
  return fromDocValue(header.doc, buffers);
}

// ---------------------------------------------------------------- scene -----

interface OctreeLike { sessionId?: string; divergedFromSource?: boolean; cacheId?: string; missOctreeCacheId?: string | null }
interface ScanLike { id: string; data?: { octree?: OctreeLike | null; bounds?: unknown } | null }

type Vec = { x: number; y: number; z: number };
const isVec = (v: unknown): v is Vec =>
  !!v && typeof v === 'object' && typeof (v as Vec).x === 'number'
  && typeof (v as Vec).y === 'number' && typeof (v as Vec).z === 'number';

/** A cloud's `bounds` holds THREE.Vector3s, which the document stores as
 *  plain {x,y,z}; code that calls `.clone()` on them (duplicating a flat
 *  cloud) threw on every reopened cloud. */
function reviveBounds<B>(bounds: B): B {
  if (!bounds || typeof bounds !== 'object') return bounds;
  const out: Record<string, unknown> = { ...(bounds as Record<string, unknown>) };
  for (const [k, v] of Object.entries(out)) {
    if (isVec(v) && !(v instanceof THREE.Vector3)) out[k] = new THREE.Vector3(v.x, v.y, v.z);
  }
  return out as B;
}
interface MeshLike { plantSessionId?: string }

/**
 * Point every cloud at its reopened session, and mark it as diverged from
 * its source file: after an open the SESSION is the truth (the source may
 * not even exist on this machine), so octree recovery must rebuild from the
 * session and never re-read the file. Live plant-growth sessions do not
 * survive a save; their meshes lose the link (the plant keeps its seed and
 * parameters and can be regenerated).
 *
 * `octreeMap` renames display octrees the backend rebuilt from a session on
 * open (a project leaves out any octree its session reproduces exactly); the
 * rebuild hashes to a new cache id, so every reference has to follow it.
 */
export function rewireOpenedScene<S extends { scans: ScanLike[]; meshes: MeshLike[] }>(
  scene: S, sessionMap: Record<string, string>, octreeMap: Record<string, string> = {},
): { scene: S; missing: string[] } {
  const missing: string[] = [];
  const scans = scene.scans.map((s0) => {
    const s = s0.data?.bounds ? { ...s0, data: { ...s0.data, bounds: reviveBounds(s0.data.bounds) } } : s0;
    const oct = s.data?.octree;
    if (!oct?.sessionId) return s;
    const next = sessionMap[oct.sessionId];
    if (!next) missing.push(s.id);
    const remapped: OctreeLike = { ...oct, sessionId: next ?? undefined, divergedFromSource: true };
    if (oct.cacheId && octreeMap[oct.cacheId]) remapped.cacheId = octreeMap[oct.cacheId];
    if (oct.missOctreeCacheId && octreeMap[oct.missOctreeCacheId]) {
      remapped.missOctreeCacheId = octreeMap[oct.missOctreeCacheId];
    }
    return { ...s, data: { ...s.data, octree: remapped } };
  });
  const meshes = scene.meshes.map(m => (m.plantSessionId ? { ...m, plantSessionId: undefined } : m));
  return { scene: { ...scene, scans, meshes }, missing };
}

/**
 * A saved tree inventory's staleness key (`treeInventoryStateKey`: the octree
 * cache id it was measured on, then the edit state, `|`-joined) with its
 * octree id followed through `octreeMap`. Without it an inventory reopened on
 * a machine that rebuilt the octree read "stale" and hid its overlays,
 * although nothing about the cloud had changed.
 */
export function remapInventoryStateKey(key: string, octreeMap: Record<string, string>): string {
  if (typeof key !== 'string') return key;
  const bar = key.indexOf('|');
  const cid = bar < 0 ? key : key.slice(0, bar);
  const next = octreeMap[cid];
  return next ? next + (bar < 0 ? '' : key.slice(bar)) : key;
}

/** Session ids and octree cache ids a scene uses, for the save request. */
export function sceneBackendRefs(scans: ScanLike[]): { sessionIds: string[]; octreeIds: string[] } {
  const sessionIds = new Set<string>();
  const octreeIds = new Set<string>();
  for (const s of scans) {
    const o = s.data?.octree;
    if (!o) continue;
    if (o.sessionId) sessionIds.add(o.sessionId);
    if (o.cacheId) octreeIds.add(o.cacheId);
    if (o.missOctreeCacheId) octreeIds.add(o.missOctreeCacheId);
  }
  return { sessionIds: [...sessionIds], octreeIds: [...octreeIds] };
}
