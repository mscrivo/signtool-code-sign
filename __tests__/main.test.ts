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
	setExecAsync
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
		const execCalls: string[] = []
		setExecAsync(async (cmd: string) => {
			execCalls.push(cmd)
			return {stdout: 'ok', stderr: ''}
		})
		// Mock execFile for verification step
		execFileMock.mockResolvedValue({stdout: 'verified', stderr: ''})

		// Fake supported extension by using actual .dll
		const file = 'C:/test/file.dll'
		await expect(trySign(file)).resolves.toBe(true)
		expect(execCalls).toHaveLength(1) // only sign command
		expect(execCalls[0]).toContain('/sha1')
		expect(execFileMock).toHaveBeenCalledTimes(1) // verify command
	})

	it('trySign retries 5 times then fails on persistent error', async () => {
		setInputs({})
		type ExecResult = {stdout: string; stderr: string}
		type ExecFn = (cmd: string) => Promise<ExecResult>
		const execMock: ExecFn & jest.Mock = jest
			.fn<Promise<ExecResult>, [string]>()
			.mockRejectedValue({stderr: 'fail', stdout: ''})
		setExecAsync(execMock)
		// Speed up by stubbing wait
		jest
			.spyOn({wait: () => Promise.resolve()}, 'wait')
			.mockImplementation(() => Promise.resolve())
		const file = 'C:/t/file.exe'
		await expect(trySign(file)).resolves.toBe(false)
		expect(execMock).toHaveBeenCalledTimes(5)
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

		const execCalls: string[] = []
		setExecAsync(async (cmd: string) => {
			execCalls.push(cmd)
			return {stdout: 'ok', stderr: ''}
		})

		await signFiles()

		// Each file should be signed once (no retries since both exec calls succeed)
		expect(execCalls.filter(c => c.includes('"sign"'))).toHaveLength(2)
		expect(execFileMock).toHaveBeenCalledTimes(2) // verify calls
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
		const execCalls: string[] = []
		setExecAsync(async (cmd: string) => {
			execCalls.push(cmd)
			return {stdout: 'ok', stderr: ''}
		})
		await run()
		expect(execCalls.some(c => c.includes('"sign"'))).toBe(true)
		expect(execFileMock).toHaveBeenCalled() // verify was called
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
