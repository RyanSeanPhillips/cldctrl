import { defineConfig } from 'tsup';

export default defineConfig({
  entry: ['src/index.ts', 'src/daemon.ts', 'src/mini-entry.ts', 'src/mcp-server.ts'],
  format: ['esm'],
  target: 'node18',
  outDir: 'dist',
  clean: true,
  splitting: true,
  sourcemap: true,
  dts: false, // Skip declaration files for the build
  // node-pty is native and must not be bundled; ws is required at runtime too.
  external: ['react', 'ink', 'yoga-wasm-web', 'node-pty', 'ws'],
  banner: {
    // Needed for ESM + __dirname
    js: `import { createRequire } from 'module'; const require = createRequire(import.meta.url);`,
  },
  // Bundle the browser dashboard into dist/web/ after the main build (clean:true
  // wipes dist first, so this must run as onSuccess, not before).
  onSuccess: 'node scripts/build-web.mjs',
});
