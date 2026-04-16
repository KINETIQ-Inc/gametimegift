import js from '@eslint/js'
import globals from 'globals'
import reactHooks from 'eslint-plugin-react-hooks'
import reactRefresh from 'eslint-plugin-react-refresh'
import tseslint from 'typescript-eslint'
import { defineConfig, globalIgnores } from 'eslint/config'

export default defineConfig([
  globalIgnores(['dist']),
  {
    files: ['**/*.{ts,tsx}'],
    extends: [
      js.configs.recommended,
      tseslint.configs.recommended,
      reactHooks.configs.flat.recommended,
      reactRefresh.configs.vite,
    ],
    languageOptions: {
      ecmaVersion: 2020,
      globals: globals.browser,
    },
    rules: {
      'no-restricted-imports': ['error', {
        paths: [
          {
            name: '@gtg/supabase',
            message: 'UI code must import from @gtg/api only.',
          },
          {
            name: '@supabase/supabase-js',
            message: 'UI code must import from @gtg/api only.',
          },
          {
            name: '@gtg/api',
            importNames: ['getClient'],
            message: 'UI code must use API wrappers instead of direct client access.',
          },
        ],
        patterns: [
          {
            group: ['**/components/checkout/CheckoutPanel', '../components/checkout/CheckoutPanel'],
            message: 'Use the dedicated /checkout page as the only checkout entry point.',
          },
          {
            group: ['@gtg/api/src/*'],
            message: 'Import from the public @gtg/api surface only.',
          },
        ],
      }],
    },
  },
])
