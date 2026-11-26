import { defineConfig } from 'tsup';

// Bundles the worker with the workspace packages (which ship as TypeScript source). Every third-party package,
// including those the workspace packages depend on, stays external and is installed in the container image: bundling
// a CommonJS library into an ES module fails at start-up.
export default defineConfig({
  entry: ['src/main.ts'],
  format: ['esm'],
  platform: 'node',
  target: 'node24',
  sourcemap: true,
  clean: true,
  noExternal: [/^@astra\//],
  external: [/^(?!@astra\/)(?![A-Za-z]:)[@A-Za-z]/],
});
