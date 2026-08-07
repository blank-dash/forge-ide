import js from '@eslint/js'
import importPlugin from 'eslint-plugin-import'
import reactHooks from 'eslint-plugin-react-hooks'
import tseslint from 'typescript-eslint'

const common = {
  '@typescript-eslint/no-explicit-any': 'warn',
  '@typescript-eslint/no-floating-promises': 'off',
  '@typescript-eslint/no-misused-promises': 'off',
  'react-hooks/exhaustive-deps': 'error',
  'import/no-duplicates': 'error',
  'no-control-regex': 'off',
  'no-useless-escape': 'off'
}

export default tseslint.config(
  {
    ignores: [
      'out/**',
      'release/**',
      'node_modules/**',
      'src/renderer/styles/**',
      'scripts/make-icons.cjs'
    ]
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    files: ['src/**/*.ts', 'src/**/*.tsx', 'scripts/**/*.ts'],
    plugins: { import: importPlugin, 'react-hooks': reactHooks },
    rules: common
  },
  {
    files: ['src/main/**/*.ts'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            { group: ['react', 'react-dom'], message: 'Main must not import renderer libraries.' }
          ]
        }
      ],
      'no-control-regex': 'off',
      '@typescript-eslint/no-require-imports': 'off'
    }
  },
  {
    files: ['src/renderer/**/*.ts', 'src/renderer/**/*.tsx'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            { group: ['node:*', 'fs', 'path', 'electron'], message: 'Renderer must use IPC.' }
          ]
        }
      ]
    }
  },
  {
    files: ['src/shared/**/*.ts'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            {
              group: ['node:*', 'fs', 'path', 'electron', 'react', 'react-dom', 'zustand'],
              message: 'Shared code must remain platform independent.'
            }
          ]
        }
      ]
    }
  },
  {
    files: ['src/shared/*.test.ts'],
    rules: { 'no-restricted-imports': 'off' }
  },
  {
    files: ['scripts/**/*.{ts,mjs}', 'src/preload/**/*.ts'],
    rules: {
      'no-restricted-imports': 'off',
      'no-control-regex': 'off',
      'prefer-const': 'off',
      'no-useless-escape': 'off',
      'no-undef': 'off'
    }
  }
)
