import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    strictPort: true,
  },
  build: {
    sourcemap: true,
    rollupOptions: {
      output: {
        manualChunks(id) {
          if (!id.includes('node_modules')) return undefined;
          if (id.includes('aws-amplify') || id.includes('@aws-amplify')) return 'authentication';
          if (/react-markdown|remark-|rehype-|unified|micromark|mdast|hast/.test(id)) return 'markdown';
          return undefined;
        },
      },
    },
  },
});
