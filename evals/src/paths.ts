import { fileURLToPath } from 'node:url';

/** Eval documents and results live under evals/, and git ignores both (they are data). */
export const CACHE_DIR = fileURLToPath(new URL('../data/cache/', import.meta.url));
export const RESULTS_DIR = fileURLToPath(new URL('../results/', import.meta.url));
export const MANIFEST = `${CACHE_DIR}manifest.json`;
