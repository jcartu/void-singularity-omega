import { defineConfig } from 'vite';

// VOID SINGULARITY: OMEGA — build config.
// Targets WebGPU-capable evergreen browsers; ships a single self-hostable bundle.
export default defineConfig({
  base: './',
  build: {
    target: 'esnext',          // top-level await, modern features for WebGPU path
    sourcemap: true,
    chunkSizeWarningLimit: 2500,
    rollupOptions: {
      output: {
        manualChunks: {
          three: ['three'],
          // physics/audio chunks are added by the gameplay/audio lanes once imported.
        },
      },
    },
  },
  optimizeDeps: {
    // rapier ships wasm; let vite pre-bundle the compat (asm-free) build
    exclude: [],
  },
  assetsInclude: ['**/*.hdr', '**/*.ktx2', '**/*.glb', '**/*.gltf', '**/*.bin'],
  server: { host: true, port: 5173 },
});
