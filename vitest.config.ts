import react from '@vitejs/plugin-react';
import { defineConfig } from 'vitest/config';

// Vitest runs only the React component tests, which need a DOM (jsdom). The
// server and src/lib tests use node:test (TEST-1); see AGENTS.md deviations.
export default defineConfig({
  plugins: [react()],
  test: {
    environment: 'jsdom',
    include: ['src/**/*.test.{ts,tsx}'],
    exclude: ['src/lib/**', 'node_modules/**'],
    setupFiles: ['./src/test/setup.ts'],
    pool: 'threads',
    maxWorkers: 1,
    fileParallelism: false,
  },
});
