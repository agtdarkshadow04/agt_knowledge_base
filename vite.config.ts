import react from '@vitejs/plugin-react';
import { defineConfig, type Connect, type Plugin } from 'vite';

/** Serves admin.html for /admin and /admin/, as the API does in production. */
const adminEntryRewrite: Connect.NextHandleFunction = (request, _response, next) => {
  const [path, query] = (request.url ?? '').split('?');
  if (path === '/admin' || path === '/admin/') request.url = `/admin.html${query ? `?${query}` : ''}`;
  next();
};

function adminEntry(): Plugin {
  return {
    name: 'agt-admin-entry',
    configureServer(server) { server.middlewares.use(adminEntryRewrite); },
    configurePreviewServer(server) { server.middlewares.use(adminEntryRewrite); },
  };
}

// The API is proxied so the browser sees one origin, as in production: the
// Admin session cookie is scoped to /api/admin and same-origin only.
const apiProxy = {
  '/api/': { target: 'http://localhost:3001' },
};

export default defineConfig({
  plugins: [react(), adminEntry()],
  server: {
    port: 5173,
    strictPort: true,
    proxy: apiProxy,
  },
  preview: {
    proxy: apiProxy,
  },
  build: {
    sourcemap: true,
    rollupOptions: {
      // Two entries: the member app and the admin panel. The member bundle
      // never imports admin code.
      input: {
        main: 'index.html',
        admin: 'admin.html',
      },
      output: {
        manualChunks(id) {
          if (!id.includes('node_modules')) return undefined;
          if (/react-markdown|remark-|rehype-|unified|micromark|mdast|hast/.test(id)) return 'markdown';
          return undefined;
        },
      },
    },
  },
});
