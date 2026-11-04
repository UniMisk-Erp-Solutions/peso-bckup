/// <reference types="vitest" />
import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react-swc'
import path from 'path'

export default defineConfig({
  plugins: [react()],
  test: {
    globals: true,
    // A local .env.local may enable the Tally Sync control; existing suites assert the default UI.
    env: { VITE_PWT_SYNC: '0' },
    environment: 'jsdom',
    setupFiles: ['./src/test/setup.ts'],
    css: true,
    pool: 'forks',
    poolOptions: {
      forks: {
        execArgv: ['--max-old-space-size=8192'],
      },
    },
  },
  resolve: {
    alias: {
      '@': path.resolve(__dirname, './src'),
    },
  },
})
