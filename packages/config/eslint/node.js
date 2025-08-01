module.exports = {
  extends: ['./index.js'],
  env: {
    node: true,
    es2022: true
  },
  rules: {
    // Node.js specific rules
    'no-process-exit': 'error',

    // Allow console in Node.js scripts
    'no-console': 'off',

    // Node.js error handling
    'handle-callback-err': 'error',
    'no-new-require': 'error',
    'no-path-concat': 'error'
  }
};
