import { defineConfig } from 'vite';
import { jevProxy } from './server/jev-proxy';
import { localMind } from './server/local-mind';

export default defineConfig({
  plugins: [jevProxy(), localMind()],
  server: { port: 5297, strictPort: true },
  preview: { port: 5298, strictPort: true },
  worker: { format: 'es' },
  optimizeDeps: { exclude: ['@mujoco/mujoco'] },
  build: { target: 'es2022' },
});
