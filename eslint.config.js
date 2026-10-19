import js from '@eslint/js';
import globals from 'globals';

export default [
  { ignores: ['dist/**', 'dist-e2e/**', '**/.venv/**', 'node_modules/**', 'test-output/**'] },
  js.configs.recommended,
  {
    languageOptions: {
      ecmaVersion: 2024,
      sourceType: 'module',
      globals: { ...globals.browser, ...globals.webextensions, ...globals.worker, __VERSION__: 'readonly', __BUNDLED_MODEL__: 'readonly' },
    },
    rules: {
      'no-unused-vars': ['error', { args: 'none', caughtErrors: 'none' }],
    },
  },
  {
    // NFR-01/NFR-02: никаких сетевых API в коде расширения
    files: ['src/**/*.js'],
    rules: {
      'no-restricted-globals': [
        'error',
        { name: 'fetch', message: 'Сетевые запросы запрещены (NFR-01)' },
        { name: 'XMLHttpRequest', message: 'Сетевые запросы запрещены (NFR-01)' },
        { name: 'WebSocket', message: 'Сетевые запросы запрещены (NFR-01)' },
        { name: 'EventSource', message: 'Сетевые запросы запрещены (NFR-01)' },
      ],
      'no-restricted-properties': ['error', { object: 'navigator', property: 'sendBeacon', message: 'Сетевые запросы запрещены (NFR-01)' }],
    },
  },
  {
    // WP10-C: единственное исключение — чтение zip встроенной модели из СОБСТВЕННОГО пакета расширения (chrome-extension://
    // того же origin; другие адреса файл отклоняет до fetch, CSP connect-src 'self' — тоже). Сети нет, NFR-01 соблюдён.
    // fetch разрешён только здесь; сторож «fetch ровно в одном файле» — tests/unit/bundled-model.spec.js (К16).
    files: ['src/offscreen/package-fetch.js'],
    rules: {
      'no-restricted-globals': [
        'error',
        { name: 'XMLHttpRequest', message: 'Сетевые запросы запрещены (NFR-01)' },
        { name: 'WebSocket', message: 'Сетевые запросы запрещены (NFR-01)' },
        { name: 'EventSource', message: 'Сетевые запросы запрещены (NFR-01)' },
      ],
    },
  },
  {
    // Ядро чистое: без chrome.*
    files: ['src/core/**/*.js'],
    languageOptions: { globals: { chrome: 'off' } },
    rules: { 'no-restricted-globals': ['error', 'chrome', 'fetch', 'XMLHttpRequest', 'WebSocket', 'document', 'window'] },
  },
  {
    files: ['tests/**/*.js', 'scripts/**/*.mjs', '*.config.js'],
    languageOptions: { globals: { ...globals.node } },
  },
];
