import eslint from '@eslint/js'
import tseslint from 'typescript-eslint'
import github from 'eslint-plugin-github'
import pluginJest from 'eslint-plugin-jest'

export default tseslint.config(
	eslint.configs.recommended,
	tseslint.configs.recommended,
	github.getFlatConfigs().browser,
	github.getFlatConfigs().recommended,
	github.getFlatConfigs().react,
	...github.getFlatConfigs().typescript,
	{
		files: ['**/*.{js,mjs,cjs,jsx,mjsx,ts,tsx,mtsx}'],
		ignores: ['eslint.config.mjs'],
		plugins: {jest: pluginJest},
		rules: {
			'github/array-foreach': 'error',
			'github/async-preventdefault': 'warn',
			'github/no-then': 'error',
			'github/no-blur': 'error',
			'eslintComments/no-use': 'off',
			'importPlugin/no-nodejs-modules': 'off',
			'jest/no-disabled-tests': 'warn',
			'jest/no-focused-tests': 'error',
			'jest/no-identical-title': 'error',
			'jest/prefer-to-have-length': 'warn',
			'jest/valid-expect': 'error'
		}
	}
)
