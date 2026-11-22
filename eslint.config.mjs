import globals from 'globals';

export default [
  { ignores: ['node_modules/**', 'docs/**'] },
  {
    files: ['**/*.js'],
    languageOptions: { ecmaVersion: 2023, sourceType: 'script', globals: { ...globals.browser, ...globals.node } },
    rules: { 'no-unused-vars': 'error', 'no-undef': 'error', 'prefer-const': 'error', eqeqeq: 'error' },
  },
  {
    files: ['**/*.mjs'],
    languageOptions: { ecmaVersion: 2023, sourceType: 'module', globals: { ...globals.node, ...globals.browser } },
    rules: { 'no-unused-vars': 'error', 'no-undef': 'error', 'prefer-const': 'error', eqeqeq: 'error' },
  },
];
