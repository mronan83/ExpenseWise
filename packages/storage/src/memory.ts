import type { ObjectStore } from './store.ts';

/** An in-memory store for tests and local development. `put` stands in for the browser. */
export function memoryObjectStore(): ObjectStore & {
  put(path: string, bytes: Uint8Array): void;
  readonly objects: ReadonlyMap<string, Uint8Array>;
} {
  const objects = new Map<string, Uint8Array>();
  let issued = 0;
  return {
    objects,
    put: (path, bytes) => void objects.set(path, bytes),
    signedUpload: (path) => Promise.resolve({ path, token: `upload-token-${++issued}` }),
    signedDownloadUrl: (path, expiresInSeconds) =>
      Promise.resolve(`memory://${path}?expires=${expiresInSeconds}`),
    download: (path) => Promise.resolve(objects.get(path) ?? null),
    save: (path, bytes) => {
      objects.set(path, bytes);
      return Promise.resolve();
    },
  };
}
