import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

const alias = (relative: string): string => new URL(relative, import.meta.url).pathname;

export default defineConfig({
  plugins: [react()],
  clearScreen: false,
  resolve: {
    alias: {
      '#doc-model': alias('./packages/doc-model/src/index.ts'),
      '#canvas-engine': alias('./packages/canvas-engine/src/index.ts'),
    },
  },
  server: {
    port: 5173,
    strictPort: true,
  },
  build: {
    target: 'safari18',
    sourcemap: true,
  },
});
