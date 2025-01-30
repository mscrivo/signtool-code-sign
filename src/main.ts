import {getInput, error as core_error, info, setFailed} from '@actions/core'
import {exec} from 'child_process'
import {promises} from 'fs'
import path from 'path'
import {env} from 'process'
import util from 'util'

// Exec
const execAsync = util.promisify(exec)

// Internal paths
const certPath = `${env['TEMP']}\\certificate.pfx`
const signtool =
	'C:/Program Files (x86)/Windows Kits/10/bin/10.0.17763.0/x86/signtool.exe'

// Inputs
const coreFolder = getInput('folder')
const coreRecursive = getInput('recursive') === 'true'
const coreBase64cert = getInput('certificate')
const corePassword = getInput('cert-password')
const coreSha1 = getInput('cert-sha1')
const coreTimestampServer = getInput('timestamp-server')
const coreCertDesc = getInput('cert-description')

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
 *
 */
function validateInputs(): boolean {
	if (coreFolder.length === 0) {
		core_error('folder input must have a value.')
		return false
	}

	if (coreBase64cert.length === 0) {
		core_error('certificate input must have a value.')
		return false
	}

	if (corePassword.length === 0) {
		core_error('cert-password input must have a value.')
		return false
	}

	if (coreSha1.length === 0) {
		core_error('cert-sha1 input must have a value.')
		return false
	}

	if (corePassword.length === 0) {
		core_error('password must have a value.')
		return false
	}

	return true
}

/**
 * Wait for X seconds and retry when code signing fails.
 *
 * @param seconds amount of seconds to wait.
 */
function wait(seconds: number): unknown {
	if (seconds > 0) info(`waiting for ${seconds} seconds.`)
	return new Promise(resolve => setTimeout(resolve, seconds * 1000))
}

/**
 * Create PFX Certification file from base64 certification.
 *
 */
async function createCert(): Promise<boolean> {
	const cert = Buffer.from(coreBase64cert, 'base64')

	info(`creating PFX Certificate at path: ${certPath}`)
	await promises.writeFile(certPath, cert)

	return true
}

/**
 * Add Certificate to the store using certutil.
 *
 */
async function addCertToStore(): Promise<boolean> {
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
async function trySign(file: string): Promise<boolean> {
	const ext = path.extname(file)
	for (let i = 0; i < 5; i++) {
		await wait(i)
		if (supportedFileExt.includes(ext)) {
			try {
				let command = `"${signtool}" sign /sm /t ${coreTimestampServer} /sha1 "${coreSha1}"`
				if (coreCertDesc !== '')
					command = command.concat(` /d "${coreCertDesc}"`)

				command = command.concat(` "${file}"`)
				info(`signing file: ${file}\nCommand: ${command}`)
				const signCommandResult = await execAsync(command)
				info(signCommandResult.stdout)

				const verifyCommand = `"${signtool}" verify /pa "${file}"`
				info(`verifying signing for file: ${file}\nCommand: ${verifyCommand}`)
				const verifyCommandResult = await execAsync(verifyCommand)
				info(verifyCommandResult.stdout)

				return true
			} catch (error) {
				core_error(error.stderr)
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
async function signFiles(): Promise<void> {
	for await (const file of getFiles(coreFolder, coreRecursive))
		await trySign(file)
}

/* eslint-disable @typescript-eslint/no-explicit-any */
/**
 * Return files one by one to be signed.
 *
 */
async function* getFiles(folder: string, recursive: boolean): any {
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
/* eslint-enable @typescript-eslint/no-explicit-any */

async function run(): Promise<void> {
	try {
		validateInputs()
		if ((await createCert()) && (await addCertToStore())) await signFiles()
	} catch (error) {
		setFailed(`code Signing failed\nError: ${error}`)
	}
}

run()
