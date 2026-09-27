import { defineConfig } from 'vite';

export default defineConfig({
  root: 'src/web',
  // Relative asset URLs: the app also works behind a reverse proxy sub-path.
  base: './',
  build: {
    outDir: '../../dist/web',
    emptyOutDir: true,
  },
  server: {
    proxy: {
      // Only API calls: a plain '/api' prefix would also catch src/web/api.ts.
      '^/api/': { target: 'http://localhost:8080' },
    },
  },
});
