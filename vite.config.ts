import { defineConfig } from 'vite';
import { jevProxy } from './server/jev-proxy';

export default defineConfig({
  plugins: [jevProxy()],
  server: { port: 5297, strictPort: true },
  preview: { port: 5298, strictPort: true },
  worker: { format: 'es' },
  optimizeDeps: { exclude: ['@mujoco/mujoco'] },
  build: { target: 'es2022' },
});
