// In-memory mock of the preload-exposed `window.electronAPI` for Vitest.
// Mirrors src/preload/preload.ts so renderer code can be exercised without
// Electron present. Reset between tests via `resetElectronAPIMock()`.

import { afterEach, beforeEach, vi } from 'vitest';
import type { FileDropPayload } from '../../src/shared/ipc';

type FileDropHandler = (payload: FileDropPayload) => void;

interface MockState {
  store: Map<string, unknown>;
  files: Map<string, string | ArrayBuffer>;
  fileDropHandlers: Set<FileDropHandler>;
  dialogOpenResult: string | string[] | null;
  dialogSaveResult: string | null;
}

const state: MockState = {
  store: new Map(),
  files: new Map(),
  fileDropHandlers: new Set(),
  dialogOpenResult: null,
  dialogSaveResult: null,
};

export const electronAPIMock = {
  __state: state,
  setDialogOpenResult(value: string | string[] | null) {
    state.dialogOpenResult = value;
  },
  setDialogSaveResult(value: string | null) {
    state.dialogSaveResult = value;
  },
  seedFile(path: string, contents: string | ArrayBuffer) {
    state.files.set(path, contents);
  },
  seedStore(key: string, value: unknown) {
    state.store.set(key, value);
  },
  emitFileDrop(payload: FileDropPayload) {
    for (const h of state.fileDropHandlers) h(payload);
  },
};

function makeApi() {
  return {
    backend: {
      getInfo: vi.fn(async () => ({
        url: 'http://127.0.0.1:8008',
        expectedVersion: '0.2.0',
        isDev: false,
      })),
    },
    dialog: {
      open: vi.fn(async () => state.dialogOpenResult),
      save: vi.fn(async () => state.dialogSaveResult),
    },
    fs: {
      readText: vi.fn(async (path: string) => {
        const v = state.files.get(path);
        if (typeof v !== 'string') throw new Error(`No text file seeded at ${path}`);
        return v;
      }),
      readBinary: vi.fn(async (path: string) => {
        const v = state.files.get(path);
        if (!(v instanceof ArrayBuffer)) throw new Error(`No binary file seeded at ${path}`);
        return v;
      }),
      writeText: vi.fn(async (path: string, contents: string) => {
        state.files.set(path, contents);
      }),
      writeBinary: vi.fn(async (path: string, contents: ArrayBuffer) => {
        state.files.set(path, contents);
      }),
    },
    store: {
      get: vi.fn(async <T,>(key: string) => state.store.get(key) as T | undefined),
      set: vi.fn(async (key: string, value: unknown) => {
        state.store.set(key, value);
      }),
      delete: vi.fn(async (key: string) => {
        state.store.delete(key);
      }),
    },
    getPathForFile: vi.fn((file: File) => `/mock/path/${file.name}`),
    onFileDrop: vi.fn((handler: FileDropHandler) => {
      state.fileDropHandlers.add(handler);
      return () => state.fileDropHandlers.delete(handler);
    }),
  };
}

function resetState() {
  state.store.clear();
  state.files.clear();
  state.fileDropHandlers.clear();
  state.dialogOpenResult = null;
  state.dialogSaveResult = null;
}

beforeEach(() => {
  // Use defineProperty so the assignment works in strict TS environments where
  // `window.electronAPI` is typed as non-optional.
  Object.defineProperty(window, 'electronAPI', {
    value: makeApi(),
    writable: true,
    configurable: true,
  });
  // Polyfill crypto.randomUUID for happy-dom older versions, used by store.ts.
  if (!globalThis.crypto?.randomUUID) {
    (globalThis as { crypto: Crypto }).crypto = {
      ...(globalThis.crypto ?? {}),
      randomUUID: () =>
        '00000000-0000-4000-8000-000000000000'.replace(/[0-9a-f]/g, () =>
          Math.floor(Math.random() * 16).toString(16),
        ) as `${string}-${string}-${string}-${string}-${string}`,
    } as Crypto;
  }
});

afterEach(() => {
  resetState();
});
