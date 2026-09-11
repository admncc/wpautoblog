'use strict';
/**
 * Nur eine Frage an den Code: Gibt es jeden Namen, der benutzt wird?
 *
 * Dreimal ist genau das schiefgegangen ("images is not defined", "usage is not
 * defined", "transcript is not defined"). Solche Fehler zeigen sich erst, wenn
 * genau dieser Zweig laeuft, und ein Zweig, der einen Anthropic-Aufruf braucht,
 * laeuft in der Funktionspruefung nicht. Deshalb prueft das hier jemand, der den
 * Code liest, statt ihn auszufuehren. Stilfragen bleiben aussen vor.
 */
module.exports = [
  {
    files: ['**/*.js'],
    languageOptions: {
      ecmaVersion: 2023,
      sourceType: 'commonjs',
      globals: {
        require: 'readonly', module: 'writable', exports: 'writable',
        process: 'readonly', console: 'readonly', Buffer: 'readonly',
        __dirname: 'readonly', __filename: 'readonly',
        setTimeout: 'readonly', clearTimeout: 'readonly', setInterval: 'readonly', clearInterval: 'readonly',
        URL: 'readonly', URLSearchParams: 'readonly', fetch: 'readonly', AbortSignal: 'readonly',
        TextEncoder: 'readonly', TextDecoder: 'readonly', structuredClone: 'readonly',
      },
    },
    rules: {
      'no-undef': 'error',
      'no-unused-vars': ['warn', { args: 'none', varsIgnorePattern: '^_' }],
      'no-dupe-keys': 'error',
      'no-unreachable': 'error',
      'no-const-assign': 'error',
    },
  },
  {
    files: ['public/**/*.js'],
    languageOptions: {
      sourceType: 'script',
      globals: {
        window: 'readonly', document: 'readonly', location: 'readonly', history: 'readonly',
        fetch: 'readonly', console: 'readonly', localStorage: 'readonly', sessionStorage: 'readonly',
        setTimeout: 'readonly', clearTimeout: 'readonly', setInterval: 'readonly', clearInterval: 'readonly',
        alert: 'readonly', confirm: 'readonly', prompt: 'readonly', navigator: 'readonly',
        URL: 'readonly', URLSearchParams: 'readonly', FormData: 'readonly', Event: 'readonly',
        CSS: 'readonly', IntersectionObserver: 'readonly', matchMedia: 'readonly',
      },
    },
  },
];
