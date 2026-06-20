import nextConfigVitals from 'eslint-config-next/core-web-vitals'
import tsEslint from 'typescript-eslint'
import reactPlugin from 'eslint-plugin-react'

const config = [
  {
    ignores : ['app/(payload)/admin/importMap.js', 'camera-service/**'],
  },
  ...nextConfigVitals,
  ...tsEslint.configs.recommended,
  {
    plugins : {
      react                : reactPlugin,
      '@typescript-eslint' : tsEslint.plugin,
    },
    rules : {
      '@typescript-eslint/no-unused-vars'  : 'error',
      '@typescript-eslint/no-explicit-any' : 'warn',
      'no-console'                         : 'error',
      'no-multiple-empty-lines'            : ['error', { max : 1, maxEOF : 0 }],
      'react/react-in-jsx-scope'           : 'off',
      'react/jsx-max-props-per-line'       : [1, { maximum : 1 }],
      'react/jsx-closing-bracket-location' : 1,
      'key-spacing'                        : [
        'error',
        {
          align       : 'colon',
          beforeColon : true,
          afterColon  : true,
        },
      ],
      'brace-style'   : 'error',
      indent          : ['error', 2],
      'comma-spacing' : [
        'error',
        {
          before : false,
          after  : true,
        },
      ],
      'space-in-parens'                 : ['error', 'always'],
      'padding-line-between-statements' : [
        'error',
        {
          blankLine : 'always',
          prev      : 'var',
          next      : 'return',
        },
      ],
      'newline-before-return' : 'error',
      'object-curly-spacing'  : ['error', 'always'],
    },
  },
]

export default config
