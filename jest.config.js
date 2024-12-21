// eslint-disable-next-line no-undef, importPlugin/no-commonjs
module.exports = {
	clearMocks: true,
	moduleFileExtensions: ['js', 'ts'],
	testEnvironment: 'node',
	testMatch: ['**/*.test.ts'],
	testRunner: 'jest-circus/runner',
	transform: {
		'^.+\\.ts$': 'ts-jest'
	},
	verbose: true
}
