import {error, setFailed} from '@actions/core'
// Mutable inputs map backing mocked getInput
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

function setInputs(over: Record<string, string>): void {
	for (const k of Object.keys(inputs)) delete inputs[k]
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
		jest.clearAllMocks()
		jest.restoreAllMocks()
		process.env.TEMP = 'C:/Temp'
		process.env.JEST_SKIP_WAIT = '1'
	})

	it('validateInputs success', async () => {
		setInputs({})
		const mod = await import('../src/main')
		expect(mod.validateInputs()).toBe(true)
	})

	it('validateInputs failure missing folder', async () => {
		setInputs({folder: ''})
		const mod = await import('../src/main')
		const err = error as jest.Mock
		const result = mod.validateInputs()
		expect(result).toBe(false)
		expect(err.mock.calls.map(c => c[0])).toContain(
			'folder input must have a value.'
		)
	})

	it('createCert writes file', async () => {
		setInputs({})
		const mod = await import('../src/main')
		writeFileMock.mockResolvedValue(undefined)
		await expect(mod.createCert()).resolves.toBe(true)
		expect(writeFileMock).toHaveBeenCalledTimes(1)
	})

	it('validateInputs failure empty certificate', async () => {
		setInputs({certificate: ''})
		const mod = await import('../src/main')
		const err = error as jest.Mock
		expect(mod.validateInputs()).toBe(false)
		expect(err.mock.calls.flat()).toContain(
			'certificate input must have a value.'
		)
	})

	it('validateInputs failure empty password', async () => {
		setInputs({'cert-password': ''})
		const mod = await import('../src/main')
		const err = error as jest.Mock
		expect(mod.validateInputs()).toBe(false)
		expect(err.mock.calls.flat()).toContain(
			'cert-password input must have a value.'
		)
	})

	it('validateInputs failure empty sha1', async () => {
		setInputs({'cert-sha1': ''})
		const mod = await import('../src/main')
		const err = error as jest.Mock
		expect(mod.validateInputs()).toBe(false)
		expect(err.mock.calls.flat()).toContain(
			'cert-sha1 input must have a value.'
		)
	})

	it('trySign success signs and verifies supported file', async () => {
		setInputs({})
		const mod = await import('../src/main')
		const execCalls: string[] = []
		mod.setExecAsync(async (cmd: string) => {
			execCalls.push(cmd)
			return {stdout: 'ok', stderr: ''}
		})
		// Fake supported extension by using actual .dll
		const file = 'C:/test/file.dll'
		await expect(mod.trySign(file)).resolves.toBe(true)
		expect(execCalls).toHaveLength(2) // sign + verify
		expect(execCalls[0]).toContain('/sha1 "sha1"')
	})

	it('trySign retries 5 times then fails on persistent error', async () => {
		setInputs({})
		const mod = await import('../src/main')
		type ExecResult = {stdout: string; stderr: string}
		type ExecFn = (cmd: string) => Promise<ExecResult>
		const execMock: ExecFn & jest.Mock = jest
			.fn<Promise<ExecResult>, [string]>()
			.mockRejectedValue({stderr: 'fail', stdout: ''})
		mod.setExecAsync(execMock)
		// Speed up by stubbing wait
		jest.spyOn(mod, 'wait').mockImplementation(() => Promise.resolve())
		const file = 'C:/t/file.exe'
		await expect(mod.trySign(file)).resolves.toBe(false)
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
		const mod2 = await import('../src/main')
		const collected: string[] = []
		for await (const f of mod2.getFiles('folder', true)) collected.push(f)
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
		const mod = await import('../src/main')
		const execCalls: string[] = []
		mod.setExecAsync(async (cmd: string) => {
			execCalls.push(cmd)
			return {stdout: 'ok', stderr: ''}
		})
		await mod.signFiles()
		// each file => sign + verify = 4 calls
		expect(execCalls.filter(c => c.includes('sign '))).toHaveLength(2)
	})

	it('run orchestrates success path', async () => {
		setInputs({recursive: 'true'})
		readdirMock.mockResolvedValue(['a.dll'])
		statMock.mockImplementation(() => ({
			isFile: () => true,
			isDirectory: () => false
		}))
		writeFileMock.mockResolvedValue(undefined)
		const mod = await import('../src/main')
		const execCalls: string[] = []
		mod.setExecAsync(async (cmd: string) => {
			execCalls.push(cmd)
			return {stdout: 'ok', stderr: ''}
		})
		await mod.run()
		expect(execCalls.some(c => c.includes('sign '))).toBe(true)
		expect(execCalls.some(c => c.includes('verify '))).toBe(true)
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
		const mod = await import('../src/main')
		const execCalls: string[] = []
		mod.setExecAsync(async (cmd: string) => {
			if (cmd.startsWith('certutil')) throw new Error('fail')
			execCalls.push(cmd)
			return {stdout: 'ok', stderr: ''}
		})
		await mod.run()
		// Signing should not have occurred
		expect(execCalls.some(c => c.includes('sign '))).toBe(false)
	})

	it('run handles createCert write error and calls setFailed', async () => {
		setInputs({})
		// Force write failure
		writeFileMock.mockRejectedValue(new Error('disk full'))
		const mod = await import('../src/main')
		await mod.run()
		const sf = setFailed as jest.Mock
		expect(sf.mock.calls.flat().join(' ')).toContain('code Signing failed')
	})
})
