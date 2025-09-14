// eslint-disable-next-line import/no-commonjs, no-undef
module.exports = {
	clearMocks: true,
	resetMocks: true,
	resetModules: true,
	restoreMocks: true,
	moduleFileExtensions: ['js', 'ts'],
	testEnvironment: 'node',
	testMatch: ['**/*.test.ts'],
	testRunner: 'jest-circus/runner',
	transform: {
		'^.+\\.ts$': 'ts-jest'
	},
	verbose: true
}
