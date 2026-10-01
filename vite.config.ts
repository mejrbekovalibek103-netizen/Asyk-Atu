import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// base: './' — относительные пути, чтобы сборка работала на любом статическом
// хостинге (GitHub Pages в подпапке, Vercel, Netlify) без перенастройки.
export default defineConfig({
  base: './',
  plugins: [react()],
  server: { host: true },
});
