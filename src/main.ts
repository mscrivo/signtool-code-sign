import {getInput, error as core_error, info, setFailed} from '@actions/core'
import {exec, execFile} from 'child_process'
import {promises} from 'fs'
import path from 'path'
import {env} from 'process'
import util from 'util'

// Exec (mutable for tests)
interface ExecResult {
	stdout: string
	stderr: string
}
type ExecFn = (command: string) => Promise<ExecResult>
let execAsync: ExecFn = util.promisify(exec) as unknown as ExecFn
const execFileAsync = util.promisify(execFile)
export function setExecAsync(fn: ExecFn): void {
	// test helper to inject mock implementation
	execAsync = fn
}

// Internal paths
const certPath = `${env['TEMP']}\\certificate.pfx`
const signtool =
	'C:/Program Files (x86)/Windows Kits/10/bin/10.0.17763.0/x86/signtool.exe'

// Inputs (used in various functions)
const coreBase64cert = getInput('certificate')
const corePassword = getInput('cert-password')

// Supported files
const supportedFileExt = [
	'.dll',
	'.exe',
	'.sys',
	'.vxd',
	'.msix',
	'.msixbundle',
	'.appx',
	'.appxbundle',
	'.msi',
	'.msp',
	'.msm',
	'.cab',
	'.ps1',
	'.psm1'
]

/**
 * Validate workflow inputs.
 */
export function validateInputs(): boolean {
	// Fetch fresh values to allow dynamic testing
	const folder = getInput('folder')
	const base64cert = getInput('certificate')
	const password = getInput('cert-password')
	const sha1 = getInput('cert-sha1')
	if (folder.length === 0) {
		core_error('folder input must have a value.')
		return false
	}
	if (base64cert.length === 0) {
		core_error('certificate input must have a value.')
		return false
	}
	if (password.length === 0) {
		core_error('cert-password input must have a value.')
		return false
	}
	if (sha1.length === 0) {
		core_error('cert-sha1 input must have a value.')
		return false
	}
	return true
}

/**
 * Wait for X seconds and retry when code signing fails.
 *
 * @param seconds amount of seconds to wait.
 */
export function wait(seconds: number): unknown {
	if (process.env.JEST_SKIP_WAIT) return Promise.resolve()
	if (seconds > 0) info(`waiting for ${seconds} seconds.`)
	return new Promise(resolve => setTimeout(resolve, seconds * 1000))
}

/**
 * Create PFX Certification file from base64 certification.
 *
 */
export async function createCert(): Promise<boolean> {
	const cert = Buffer.from(coreBase64cert, 'base64')

	info(`creating PFX Certificate at path: ${certPath}`)
	await promises.writeFile(certPath, cert)

	return true
}

/**
 * Add Certificate to the store using certutil.
 *
 */
export async function addCertToStore(): Promise<boolean> {
	try {
		const command = `certutil -f -p ${corePassword} -importpfx ${certPath}`
		info(`adding to store using "${command}" command`)

		const {stdout} = await execAsync(command)
		info(stdout)

		return true
	} catch (error) {
		core_error(error.stdout)
		core_error(error.stderr)
		return false
	}
}

/**
 * Sign file using signtool.
 *
 * @param file File to be signed.
 */
export async function trySign(file: string): Promise<boolean> {
	const ext = path.extname(file)
	// Read inputs dynamically to allow testing
	const timestampServer = getInput('timestamp-server')
	const sha1 = getInput('cert-sha1')
	const certDesc = getInput('cert-description')

	for (let i = 0; i < 5; i++) {
		await wait(i)
		if (supportedFileExt.includes(ext)) {
			try {
				const signArgs = ['sign', '/sm', '/t', timestampServer, '/sha1', sha1]
				if (certDesc !== '') signArgs.push('/d', certDesc)
				signArgs.push(file)

				const signCommand = `"${signtool}" ${signArgs.map(arg => `"${arg}"`).join(' ')}`
				info(`signing file: ${file}\nCommand: ${signCommand}`)
				const signCommandResult = await execAsync(signCommand)
				info(signCommandResult.stdout)
				const verifyCommand = `"${signtool}" verify /pa "${file}"`
				info(`verifying signing for file: ${file}\nCommand: ${verifyCommand}`)
				const verifyCommandResult = await execFileAsync(signtool, [
					'verify',
					'/pa',
					file
				])
				info(verifyCommandResult.stdout)

				return true
			} catch (error) {
				core_error(error.stderr)
			}
		}
	}
	return false
}

/**
 * Sign all files in folder, this is done recursively if recursive == 'true'
 *
 */
export async function signFiles(): Promise<void> {
	// Read inputs dynamically to allow testing
	const folder = getInput('folder')
	const recursive = getInput('recursive') === 'true'
	for await (const file of getFiles(folder, recursive)) await trySign(file)
}

/**
 * Return files one by one to be signed.
 *
 */
export async function* getFiles(
	folder: string,
	recursive: boolean
): AsyncGenerator<string, void, unknown> {
	const files = await promises.readdir(folder)
	for (const file of files) {
		const fullPath = `${folder}/${file}`
		const stat = await promises.stat(fullPath)
		if (stat.isFile()) {
			const ext = path.extname(file)
			if (supportedFileExt.includes(ext) || ext === '.nupkg') yield fullPath
		} else if (stat.isDirectory() && recursive)
			yield* getFiles(fullPath, recursive)
	}
}

export async function run(): Promise<void> {
	try {
		validateInputs()
		if ((await createCert()) && (await addCertToStore())) await signFiles()
	} catch (error) {
		setFailed(`code Signing failed\nError: ${error}`)
	}
}

// Only auto-run when not under Jest (so tests can import without side-effects)
if (!process.env.JEST_WORKER_ID) {
	run()
}

export default {
	validateInputs,
	wait,
	createCert,
	addCertToStore,
	trySign,
	signFiles,
	getFiles,
	run
}
