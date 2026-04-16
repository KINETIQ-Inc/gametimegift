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
    dedupe: ['react', 'react-dom'],
  },
  optimizeDeps: {
    exclude: ['@gtg/api', '@gtg/config', '@gtg/domain', '@gtg/supabase', '@gtg/types', '@gtg/ui', '@gtg/utils'],
  },
  server: {
    port: 3002,
  },
})
