import { defineConfig } from 'tsup';

// Bundles the API with the workspace packages (which ship as TypeScript source); third-party
// dependencies stay external and are installed in the container image.
export default defineConfig({
  entry: ['src/main.ts'],
  format: ['esm'],
  platform: 'node',
  target: 'node24',
  sourcemap: true,
  clean: true,
  noExternal: [/^@astra\//],
});
