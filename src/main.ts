import {
	getInput,
	error as log_error,
	info,
	setFailed,
	setSecret,
	warning
} from '@actions/core'
import {execFile} from 'child_process'
import {randomUUID} from 'crypto'
import {promises} from 'fs'
import {tmpdir} from 'os'
import path from 'path'
import util from 'util'

const execFileAsync = util.promisify(execFile)

// Temporary PFX file path, created lazily with a unique name so it is
// neither predictable nor shared between runs.
let certPath: string | null = null
function getCertPath(): string {
	if (!certPath) {
		certPath = path.join(tmpdir(), `codesign-${randomUUID()}.pfx`)
	}
	return certPath
}

interface SigntoolInfo {
	path: string
	version: string
}

/**
 * Find the latest available signtool.exe from Windows SDK installations.
 */
export async function findSigntool(): Promise<SigntoolInfo> {
	const sdkBasePath = 'C:/Program Files (x86)/Windows Kits/10/bin'

	try {
		// Read all directories in the SDK bin path
		const versions = await promises.readdir(sdkBasePath)

		// Filter for version directories (e.g., "10.0.17763.0", "10.0.19041.0")
		const versionDirs = versions.filter(dir => /^\d+\.\d+\.\d+\.\d+$/.test(dir))

		if (versionDirs.length === 0) {
			throw new Error('No Windows SDK versions found')
		}

		// Sort versions in descending order to get the latest
		versionDirs.sort((a, b) => {
			const aParts = a.split('.').map(Number)
			const bParts = b.split('.').map(Number)

			for (let i = 0; i < Math.max(aParts.length, bParts.length); i++) {
				const aVal = aParts[i] || 0
				const bVal = bParts[i] || 0
				if (aVal !== bVal) {
					return bVal - aVal // Descending order
				}
			}
			return 0
		})

		// Try each version until we find a working signtool.exe
		for (const version of versionDirs) {
			// eslint-disable-next-line i18n-text/no-en
			info(`Checking for signtool in SDK version: ${version}`)
			const signtoolPath = `${sdkBasePath}/${version}/x86/signtool.exe`
			try {
				await promises.stat(signtoolPath)
				// eslint-disable-next-line i18n-text/no-en
				info(`Found signtool at: ${signtoolPath}`)
				return {path: signtoolPath, version}
			} catch {
				info(`signtool not found at: ${signtoolPath}`)
				// File doesn't exist, try next version
				continue
			}
		}

		throw new Error('No accessible signtool.exe found in any SDK version')
	} catch (error) {
		// Fallback to hardcoded path if dynamic discovery fails
		const fallbackPath =
			'C:/Program Files (x86)/Windows Kits/10/bin/10.0.17763.0/x86/signtool.exe'
		const fallbackVersion = '10.0.17763.0'
		log_error(`signtool discovery failed: ${error.message}`)
		return {path: fallbackPath, version: fallbackVersion}
	}
}

// Cache the signtool info to avoid repeated filesystem searches
let signtoolInfo: SigntoolInfo | null = null

// Test helper to reset signtool cache
export function resetSigntoolCache(): void {
	signtoolInfo = null
}

async function getSigntoolInfo(): Promise<SigntoolInfo> {
	if (!signtoolInfo) {
		signtoolInfo = await findSigntool()
	}
	return signtoolInfo
}

/**
 * Check if the signtool version requires /fd <sha1|sha256> flag.
 * Returns true for version 10.0.26100.0 and later.
 */
function requiresFdFlag(version: string): boolean {
	const versionParts = version.split('.').map(Number)
	const targetVersion = [10, 0, 26100, 0]

	for (
		let i = 0;
		i < Math.max(versionParts.length, targetVersion.length);
		i++
	) {
		const versionVal = versionParts[i] || 0
		const targetVal = targetVersion[i] || 0

		if (versionVal > targetVal) return true
		if (versionVal < targetVal) return false
	}

	return true // Equal versions require the argument
}

// Test helper to inject mock signtool info
export function setSigntoolPath(toolPath: string): void {
	signtoolInfo = {path: toolPath, version: '10.0.17763.0'} // Default test version
}

export function setSigntoolInfo(toolInfo: SigntoolInfo): void {
	signtoolInfo = toolInfo
}

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
	const timestampServer = getInput('timestamp-server')
	if (folder.length === 0) {
		log_error('folder input must have a value.')
		return false
	}
	if (base64cert.length === 0) {
		log_error('certificate input must have a value.')
		return false
	}
	if (Buffer.from(base64cert, 'base64').length === 0) {
		log_error('certificate input must be valid base64-encoded PFX data.')
		return false
	}
	if (password.length === 0) {
		log_error('cert-password input must have a value.')
		return false
	}
	if (sha1.length === 0) {
		log_error('cert-sha1 input must have a value.')
		return false
	}
	if (!/^[0-9a-fA-F]{40}$/.test(sha1)) {
		log_error(
			'cert-sha1 input must be a 40 character hex string (certificate thumbprint).'
		)
		return false
	}
	if (timestampServer.length > 0 && !/^https?:\/\//.test(timestampServer)) {
		log_error('timestamp-server input must be an http(s) URL.')
		return false
	}
	return true
}

/**
 * Wait for X seconds and retry when code signing fails.
 *
 * @param seconds amount of seconds to wait.
 */
export function wait(seconds: number): Promise<void> {
	if (process.env.JEST_SKIP_WAIT) return Promise.resolve()
	if (seconds > 0) info(`waiting for ${seconds} seconds.`)
	return new Promise(resolve => setTimeout(resolve, seconds * 1000))
}

/**
 * Create PFX Certification file from base64 certification.
 *
 */
export async function createCert(): Promise<boolean> {
	const base64cert = getInput('certificate')
	const cert = Buffer.from(base64cert, 'base64')
	const dest = getCertPath()

	info(`creating PFX Certificate at path: ${dest}`)
	await promises.writeFile(dest, cert)

	return true
}

/**
 * Add Certificate to the store using certutil.
 *
 * Runs certutil via execFile (no shell) so the password is never
 * interpreted by a command interpreter, and is never written to the log.
 */
export async function addCertToStore(): Promise<boolean> {
	const password = getInput('cert-password')
	const dest = getCertPath()
	try {
		info(
			`adding to store using "certutil -f -p *** -importpfx ${dest}" command`
		)

		const {stdout} = await execFileAsync('certutil', [
			'-f',
			'-p',
			password,
			'-importpfx',
			dest
		])
		info(stdout)

		return true
	} catch (error) {
		log_error(error.stdout)
		log_error(error.stderr)
		return false
	}
}

/**
 * Best-effort cleanup: remove the imported certificate from the machine
 * store and delete the temporary PFX file. Never fails the action.
 */
export async function cleanup(): Promise<void> {
	const sha1 = getInput('cert-sha1')
	if (sha1.length > 0) {
		try {
			await execFileAsync('certutil', ['-delstore', 'My', sha1])
			info('removed certificate from store')
		} catch {
			warning('failed to remove certificate from store')
		}
	}
	if (certPath) {
		try {
			await promises.rm(certPath, {force: true})
			certPath = null
			info('deleted temporary certificate file')
		} catch {
			warning('failed to delete temporary certificate file')
		}
	}
}

/**
 * Sign file using signtool.
 *
 * @param file File to be signed.
 */
export async function trySign(file: string): Promise<boolean> {
	const ext = path.extname(file)
	if (!supportedFileExt.includes(ext)) {
		warning(`unsupported file extension ${ext}, skipping: ${file}`)
		return false
	}

	// Read inputs dynamically to allow testing
	const timestampServer = getInput('timestamp-server')
	const sha1 = getInput('cert-sha1')
	const certDesc = getInput('cert-description')

	const toolInfo = await getSigntoolInfo()
	const signtool = toolInfo.path

	for (let i = 0; i < 5; i++) {
		await wait(i)
		try {
			const signArgs = ['sign', '/sm', '/t', timestampServer, '/sha1', sha1]

			// Add /fd sha1 for signtool version 10.0.26100.0 and later
			if (requiresFdFlag(toolInfo.version)) {
				signArgs.push('/fd', 'sha1')
			}

			if (certDesc !== '') signArgs.push('/d', certDesc)
			signArgs.push(file)

			info(
				`signing file: ${file}\nArguments: ${[signtool, ...signArgs].join(' ')}`
			)
			const signCommandResult = await execFileAsync(signtool, signArgs)
			info(signCommandResult.stdout)

			const verifyArgs = ['verify', '/pa', file]
			info(
				`verifying signing for file: ${file}\nArguments: ${[signtool, ...verifyArgs].join(' ')}`
			)
			const verifyCommandResult = await execFileAsync(signtool, verifyArgs)
			info(verifyCommandResult.stdout)

			return true
		} catch (error) {
			log_error(error.stderr)
		}
	}
	return false
}

/**
 * Sign all files in folder, this is done recursively if recursive == 'true'
 * Returns true if all files were signed successfully, false if any failed.
 */
export async function signFiles(): Promise<boolean> {
	// Read inputs dynamically to allow testing
	const folder = getInput('folder')
	const recursive = getInput('recursive') === 'true'
	let allSucceeded = true
	let fileCount = 0
	for await (const file of getFiles(folder, recursive)) {
		fileCount++
		const success = await trySign(file)
		if (!success) {
			allSucceeded = false
		}
	}
	if (fileCount === 0) {
		// eslint-disable-next-line i18n-text/no-en
		info('No files found to sign')
	}
	return allSucceeded
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
			if (supportedFileExt.includes(ext)) yield fullPath
		} else if (stat.isDirectory() && recursive)
			yield* getFiles(fullPath, recursive)
	}
}

export async function run(): Promise<void> {
	try {
		// Mask secrets in logs even when they were not passed from the
		// `secrets` context (defense in depth).
		const password = getInput('cert-password')
		if (password.length > 0) setSecret(password)
		const base64cert = getInput('certificate')
		if (base64cert.length > 0) setSecret(base64cert)

		if (!validateInputs()) {
			// eslint-disable-next-line i18n-text/no-en
			setFailed('Code signing failed: Invalid inputs')
			return
		}
		if (!(await createCert())) {
			// eslint-disable-next-line i18n-text/no-en
			setFailed('Code signing failed: Could not create certificate file')
			return
		}
		try {
			if (!(await addCertToStore())) {
				setFailed(
					// eslint-disable-next-line i18n-text/no-en
					'Code signing failed: Could not import certificate to store. The certificate may be invalid, expired, or the password may be incorrect.'
				)
				return
			}
			const success = await signFiles()
			if (!success) {
				setFailed(
					// eslint-disable-next-line i18n-text/no-en
					'Code signing failed: One or more files could not be signed. Check the logs for details.'
				)
			}
		} finally {
			await cleanup()
		}
	} catch (error) {
		// eslint-disable-next-line i18n-text/no-en
		setFailed(`Code signing failed\nError: ${error}`)
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
	cleanup,
	trySign,
	signFiles,
	getFiles,
	run
}
