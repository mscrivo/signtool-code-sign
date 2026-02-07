// Manual mock for @actions/core (ESM module)
// This provides a CommonJS-compatible mock for Jest

module.exports = {
	getInput: jest.fn(),
	error: jest.fn(),
	info: jest.fn(),
	setFailed: jest.fn()
}
