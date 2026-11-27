import { defineConfig } from 'tsup';

// Bundles the API with the workspace packages (which ship as TypeScript source). Every third-party package, including
// those the workspace packages depend on, stays external and is installed in the container image: bundling a CommonJS
// library into an ES module fails at start-up.
export default defineConfig({
  // The migration command ships in the same image, so a release and its database changes are one artefact.
  entry: {
    main: 'src/main.ts',
    migrate: '../../packages/platform/src/db/migrate-cli.ts',
    // Loads the invented sample data set into a development environment; it does nothing unless asked.
    'demo/seed': 'src/demo/seed.ts',
  },
  format: ['esm'],
  platform: 'node',
  target: 'node24',
  sourcemap: true,
  clean: true,
  noExternal: [/^@astra\//],
  external: [/^(?!@astra\/)(?![A-Za-z]:)[@A-Za-z]/],
});
