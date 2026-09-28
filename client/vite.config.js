import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import path from 'path';
import fs from 'fs';

const BUILD_ID = Date.now().toString();

function buildMetaPlugin() {
  return {
    name: 'build-meta',
    closeBundle() {
      const outDir = path.resolve(__dirname, 'dist');
      fs.writeFileSync(path.join(outDir, 'build.json'), JSON.stringify({ build: BUILD_ID }));
    },
  };
}

export default defineConfig({
  plugins: [react(), buildMetaPlugin()],
  define: {
    __BUILD_ID__: JSON.stringify(BUILD_ID),
  },
  resolve: {
    alias: {
      '@': path.resolve(__dirname, './src'),
    },
  },
  server: {
    port: 5173,
    proxy: {
      '/api': {
        target: 'http://localhost:3000',
        changeOrigin: true,
      },
    },
  },
  build: {
    outDir: 'dist',
  },
});