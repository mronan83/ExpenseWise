import nextVitals from 'eslint-config-next/core-web-vitals';
import { defineConfig } from 'eslint/config';
import root from '../../eslint.config.js';

// The root config already applies type-aware typescript-eslint rules. Next's own
// TypeScript block registers a second copy of that plugin, so keep only its React,
// hooks and Core Web Vitals rules.
const nextRules = nextVitals.filter((config) => config.name !== 'next/typescript');

// Root comes last so its type-aware TypeScript parser wins over Next's default parser.
export default defineConfig(nextRules, root, {
  ignores: ['.next/**', 'playwright-report/**', 'test-results/**', 'next-env.d.ts'],
});
