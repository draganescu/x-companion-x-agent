import { defineConfig } from 'vitest/config';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const here = path.dirname(fileURLToPath(import.meta.url));

/**
 * The single package lives in `x-agent/mcp/` but the test suite lives one level
 * up in `x-agent/tests/` (that is the layout the spec's file_layout pins).
 * Vitest `root` therefore points at `x-agent/` while dependency resolution keeps
 * working from `x-agent/mcp/node_modules` via the explicit alias below.
 */
export default defineConfig({
  root: path.resolve(here, '..'),
  test: {
    environment: 'node',
    include: ['tests/**/*.test.ts'],
    hookTimeout: 30_000,
    testTimeout: 30_000,
  },
});
