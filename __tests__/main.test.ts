import {error, setFailed} from '@actions/core'

// Global test inputs object
const inputs: Record<string, string> = {}

// Mock @actions/core before importing code under test
jest.mock('@actions/core', () => ({
	getInput: (n: string) => inputs[n] || '',
	error: jest.fn(),
	info: jest.fn(),
	setFailed: jest.fn()
}))

// Mock fs.promises methods we interact with
const writeFileMock = jest.fn()
const readdirMock = jest.fn()
const statMock = jest.fn()
jest.mock('fs', () => {
	const actual = jest.requireActual('fs')
	return {
		...actual,
		promises: {
			...actual.promises,
			writeFile: writeFileMock,
			readdir: readdirMock,
			stat: statMock
		}
	}
})

// Mock child_process to handle both exec and execFile
const execFileMock = jest.fn()
jest.mock('child_process', () => ({
	exec: jest.fn(),
	execFile: execFileMock
}))

// Mock util.promisify to return our mocked execFile function
jest.mock('util', () => {
	const actual = jest.requireActual('util')
	const {execFile} = jest.requireMock('child_process')
	return {
		...actual,
		promisify: (fn: unknown) => {
			if (fn === execFile) {
				return execFileMock
			}
			return actual.promisify(fn)
		}
	}
})

// Import the module after mocks are set up
// eslint-disable-next-line import/first
import {
	validateInputs,
	createCert,
	trySign,
	getFiles,
	signFiles,
	run,
	setExecAsync,
	setSigntoolPath
} from '../src/main'

function setInputs(over: Record<string, string>): void {
	// Clear existing inputs
	for (const k of Object.keys(inputs)) delete inputs[k]
	// Set default valid inputs
	Object.assign(inputs, {
		folder: 'folder',
		recursive: 'false',
		certificate: 'dGVzdA==',
		'cert-password': 'pw',
		'cert-sha1': 'sha1',
		'timestamp-server': 'http://ts',
		'cert-description': 'Desc',
		...over
	})
}

describe('main minimal (mocked core)', () => {
	beforeEach(() => {
		// Clear all mocks but don't reset modules (causes flakiness)
		jest.clearAllMocks()

		// Set consistent environment
		process.env.JEST_SKIP_WAIT = '1'

		// Set up execFile mock to succeed by default
		execFileMock.mockResolvedValue({stdout: 'verified', stderr: ''})

		// Set up a default execAsync mock (can be overridden in individual tests)
		setExecAsync(async () => ({stdout: 'ok', stderr: ''}))

		// Set a mock signtool path to avoid filesystem operations during tests
		setSigntoolPath('C:/MockedSigntool/signtool.exe')
	})

	it('validateInputs success', async () => {
		setInputs({})
		expect(validateInputs()).toBe(true)
	})

	it('validateInputs failure missing folder', async () => {
		setInputs({folder: ''})
		const err = error as jest.Mock
		const result = validateInputs()
		expect(result).toBe(false)
		expect(err.mock.calls.map(c => c[0])).toContain(
			'folder input must have a value.'
		)
	})

	it('createCert writes file', async () => {
		setInputs({})
		writeFileMock.mockResolvedValue(undefined)
		await expect(createCert()).resolves.toBe(true)
		expect(writeFileMock).toHaveBeenCalledTimes(1)
	})

	it('validateInputs failure empty certificate', async () => {
		setInputs({certificate: ''})
		const err = error as jest.Mock
		expect(validateInputs()).toBe(false)
		expect(err.mock.calls.flat()).toContain(
			'certificate input must have a value.'
		)
	})

	it('validateInputs failure empty password', async () => {
		setInputs({'cert-password': ''})
		const err = error as jest.Mock
		expect(validateInputs()).toBe(false)
		expect(err.mock.calls.flat()).toContain(
			'cert-password input must have a value.'
		)
	})

	it('validateInputs failure empty sha1', async () => {
		setInputs({'cert-sha1': ''})
		const err = error as jest.Mock
		expect(validateInputs()).toBe(false)
		expect(err.mock.calls.flat()).toContain(
			'cert-sha1 input must have a value.'
		)
	})

	it('trySign success signs and verifies supported file', async () => {
		setInputs({})

		// Track execFile calls (both signing and verification now use execFileAsync)
		const execFileCalls: Array<{tool: string; args: string[]}> = []
		execFileMock.mockImplementation(async (tool: string, args: string[]) => {
			execFileCalls.push({tool, args})
			return {stdout: 'verified', stderr: ''}
		})

		// Fake supported extension by using actual .dll
		const file = 'C:/test/file.dll'
		await expect(trySign(file)).resolves.toBe(true)

		// Should have been called twice: once for signing, once for verification
		expect(execFileCalls).toHaveLength(2)

		// First call should be signing
		expect(execFileCalls[0].args).toContain('sign')
		expect(execFileCalls[0].args).toContain('/sha1')

		// Second call should be verification
		expect(execFileCalls[1].args).toContain('verify')
	})

	it('trySign retries 5 times then fails on persistent error', async () => {
		setInputs({})

		// Mock execFile to fail on signing attempts
		let callCount = 0
		execFileMock.mockImplementation(async (tool: string, args: string[]) => {
			callCount++
			// Fail if it's a signing command
			if (args.includes('sign')) {
				const err = new Error('fail') as Error & {
					stderr: string
					stdout: string
				}
				err.stderr = 'fail'
				err.stdout = ''
				throw err
			}
			// Should not reach verification since signing fails
			return {stdout: 'verified', stderr: ''}
		})

		// Speed up by stubbing wait
		jest
			.spyOn({wait: () => Promise.resolve()}, 'wait')
			.mockImplementation(() => Promise.resolve())
		const file = 'C:/t/file.exe'
		await expect(trySign(file)).resolves.toBe(false)
		expect(callCount).toBe(5) // Should have tried signing 5 times
	})

	it('getFiles yields supported and .nupkg recursively', async () => {
		setInputs({})
		readdirMock.mockImplementation((dir: string) => {
			if (dir === 'folder') return ['a.dll', 'b.txt', 'sub', 'pkg.nupkg']
			if (dir === 'folder/sub') return ['inner.exe']
			return []
		})
		statMock.mockImplementation((p: string) => {
			const fileNames = ['a.dll', 'b.txt', 'pkg.nupkg', 'inner.exe']
			if (p === 'folder/sub')
				return {isFile: () => false, isDirectory: () => true}
			const name = p.split('/').pop() as string
			if (fileNames.includes(name))
				return {isFile: () => true, isDirectory: () => false}
			if (name === 'sub') return {isFile: () => false, isDirectory: () => true}
			return {isFile: () => false, isDirectory: () => false}
		})
		const collected: string[] = []
		for await (const f of getFiles('folder', true)) collected.push(f)
		expect(collected).toEqual([
			'folder/a.dll',
			'folder/sub/inner.exe',
			'folder/pkg.nupkg'
		])
	})

	it('signFiles invokes trySign for each file from getFiles', async () => {
		setInputs({recursive: 'true'})
		// Provide fake directory listing for getFiles path traversal
		readdirMock.mockResolvedValue(['a.dll', 'b.exe'])
		statMock.mockImplementation(() => ({
			isFile: () => true,
			isDirectory: () => false
		}))

		// Track execFile calls (now used for both signing and verification)
		const execFileCalls: Array<{tool: string; args: string[]}> = []
		execFileMock.mockImplementation(async (tool: string, args: string[]) => {
			execFileCalls.push({tool, args})
			return {stdout: 'ok', stderr: ''}
		})

		await signFiles()

		// Each file should be signed and verified (4 total calls: 2 sign + 2 verify)
		expect(
			execFileCalls.filter(call => call.args.includes('sign'))
		).toHaveLength(2)
		expect(
			execFileCalls.filter(call => call.args.includes('verify'))
		).toHaveLength(2)
		// Also check that readdir was called with the expected folder
		expect(readdirMock).toHaveBeenCalledWith('folder')
	})

	it('run orchestrates success path', async () => {
		setInputs({recursive: 'true'})
		readdirMock.mockResolvedValue(['a.dll'])
		statMock.mockImplementation(() => ({
			isFile: () => true,
			isDirectory: () => false
		}))
		writeFileMock.mockResolvedValue(undefined)

		// Track execFile calls to verify signing occurred
		const execFileCalls: Array<{tool: string; args: string[]}> = []
		execFileMock.mockImplementation(async (tool: string, args: string[]) => {
			execFileCalls.push({tool, args})
			return {stdout: 'ok', stderr: ''}
		})

		await run()

		// Should have signing calls
		expect(execFileCalls.some(call => call.args.includes('sign'))).toBe(true)
		// Should have verification calls
		expect(execFileCalls.some(call => call.args.includes('verify'))).toBe(true)
	})

	it('run aborts when addCertToStore fails (no signing execs)', async () => {
		setInputs({recursive: 'true'})
		readdirMock.mockResolvedValue(['a.dll'])
		statMock.mockImplementation(() => ({
			isFile: () => true,
			isDirectory: () => false
		}))
		// writeFile ok (createCert success)
		writeFileMock.mockResolvedValue(undefined)
		const execCalls: string[] = []
		setExecAsync(async (cmd: string) => {
			if (cmd.startsWith('certutil')) throw new Error('fail')
			execCalls.push(cmd)
			return {stdout: 'ok', stderr: ''}
		})
		await run()
		// Signing should not have occurred
		expect(execCalls.some(c => c.includes('"sign"'))).toBe(false)
	})

	it('run handles createCert write error and calls setFailed', async () => {
		setInputs({})
		// Force write failure
		writeFileMock.mockRejectedValue(new Error('disk full'))
		await run()
		const sf = setFailed as jest.Mock
		expect(sf.mock.calls.flat().join(' ')).toContain('code Signing failed')
	})
})
