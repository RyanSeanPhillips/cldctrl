import { defineConfig } from 'tsup';

export default defineConfig({
  entry: ['src/index.ts', 'src/daemon.ts'],
  format: ['esm'],
  target: 'node18',
  outDir: 'dist',
  clean: true,
  splitting: true,
  sourcemap: true,
  dts: false, // Skip declaration files for the build
  external: ['react', 'ink', 'yoga-wasm-web'],
  banner: {
    // Needed for ESM + __dirname
    js: `import { createRequire } from 'module'; const require = createRequire(import.meta.url);`,
  },
});
