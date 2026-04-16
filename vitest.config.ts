import path from 'node:path'
import { defineConfig } from 'vitest/config'

export default defineConfig({
  resolve: {
    alias: {
      '@gtg/ui': path.resolve(__dirname, 'packages/ui/src/index.ts'),
    },
  },
  test: {
    environment: 'node',
    include: [
      'apps/**/__tests__/**/*.test.tsx',
      'packages/**/__tests__/**/*.test.ts',
      'supabase/functions/test/**/*.test.ts',
    ],
    setupFiles: ['./vitest.setup.ts'],
    reporters: ['default'],
    coverage: {
      provider: 'v8',
      reporter: ['text', 'lcov'],
    },
  },
})
