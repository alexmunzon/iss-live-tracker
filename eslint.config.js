import js from '@eslint/js';
import tseslint from 'typescript-eslint';
import reactHooks from 'eslint-plugin-react-hooks';
import globals from 'globals';

export default tseslint.config(
  {
    ignores: [
      'dist',
      'coverage',
      'node_modules',
      'test-results',
      'playwright-report',
      '.claude/worktrees',
    ],
  },
  js.configs.recommended,
  ...tseslint.configs.strict,
  reactHooks.configs.flat['recommended-latest'],
  {
    languageOptions: { globals: { ...globals.browser } },
    rules: {
      'no-eval': 'error',
      'no-implied-eval': 'error',
      'no-new-func': 'error',
      '@typescript-eslint/no-explicit-any': 'error',
      'no-restricted-properties': [
        'error',
        { object: 'document', property: 'write', message: 'Render remote values as text.' },
      ],
      'no-restricted-syntax': [
        'error',
        {
          selector: "AssignmentExpression[left.property.name='innerHTML']",
          message: 'Render remote values as text (textContent), never innerHTML.',
        },
        {
          selector: "JSXAttribute[name.name='dangerouslySetInnerHTML']",
          message: 'No unsafe HTML.',
        },
        {
          selector: "AssignmentExpression[left.property.name='outerHTML']",
          message: 'Render remote values as text, never outerHTML.',
        },
        {
          selector:
            'CallExpression[callee.property.name=/^(insertAdjacentHTML|createContextualFragment|bindPopup|bindTooltip|setContent|setPopupContent|setTooltipContent)$/]',
          message: 'HTML sink: build DOM nodes with textContent instead (G1-v2).',
        },
        {
          selector:
            "CallExpression[callee.property.name='setAttribute'][arguments.0.value='style']",
          message: "setAttribute('style') breaks the style-src CSP. Use element.style instead.",
        },
        {
          selector: "CallExpression[callee.property.name='divIcon'] Property[key.name='html']",
          message: 'Leaflet divIcon html is an HTML sink. Use className and CSS (G1-v2).',
        },
      ],
    },
  },
  {
    files: ['*.config.{js,ts}', 'eslint.config.js'],
    languageOptions: { globals: { ...globals.node } },
  },
);
