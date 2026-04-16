import path from 'node:path'
import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: {
      '@gtg/ui/fonts.css': path.resolve(__dirname, '../../packages/ui/src/fonts.css'),
      '@gtg/ui/tokens.css': path.resolve(__dirname, '../../packages/ui/src/tokens.css'),
      '@gtg/ui/components.css': path.resolve(__dirname, '../../packages/ui/src/components.css'),
      '@gtg/ui': path.resolve(__dirname, '../../packages/ui/src/index.ts'),
    },
    // Guarantee a single React instance across all workspace packages.
    // Without this, @gtg/ui and the app could each bundle their own copy.
    dedupe: ['react', 'react-dom'],
  },
  optimizeDeps: {
    // Workspace packages export raw TypeScript source — Vite processes them
    // on the fly. Pre-bundling them as CJS would break type resolution.
    exclude: ['@gtg/api', '@gtg/config', '@gtg/domain', '@gtg/supabase', '@gtg/types', '@gtg/ui', '@gtg/utils'],
  },
  server: {
    port: 3000,
    host: '127.0.0.1',
    strictPort: true,
  },
})
