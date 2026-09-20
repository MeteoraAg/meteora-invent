module.exports = {
  extends: ['next/core-web-vitals', 'next/typescript', 'prettier'],
  ignorePatterns: ['src/components/AdvancedTradingView/**/*.d.ts'],
  rules: {
    '@typescript-eslint/no-explicit-any': 'off',
    '@typescript-eslint/no-unused-vars': 'off',
    '@typescript-eslint/no-empty-object-type': 'off',
    '@typescript-eslint/no-unsafe-function-type': 'off',
    '@typescript-eslint/no-unsafe-function': 'off',
    '@typescript-eslint/ban-types': 'off',
    // eslint-config-next 15.5.25 enables this without options; typescript-eslint v7
    // then crashes with "Cannot read properties of undefined (reading 'allowShortCircuit')".
    '@typescript-eslint/no-unused-expressions': [
      'error',
      {
        allowShortCircuit: true,
        allowTernary: true,
        allowTaggedTemplates: true,
      },
    ],
  },
  root: true,
};
