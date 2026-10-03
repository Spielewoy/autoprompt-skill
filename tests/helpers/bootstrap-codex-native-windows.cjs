'use strict'

const childProcess = require('node:child_process')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const {
  resolveCodexExecutable,
  withCodexManagedEnvironment,
} = require('../../agents/codex/workflow/codex-executable.js')
const { inspectActivationPrerequisites } = require('../../scripts/codex-configure.cjs')

const shim = path.resolve('.native-provider', 'node_modules', '.bin', 'codex.cmd')
if (!fs.lstatSync(shim).isFile()) throw new Error('Expected the generated Codex npm shim')
const environment = { ...process.env }
const inheritedPathKey = Object.keys(environment)
  .find(key => key.toLowerCase() === 'path')
const inheritedPath = inheritedPathKey ? environment[inheritedPathKey] : ''
for (const key of Object.keys(environment)) {
  if (key.toLowerCase() === 'path') delete environment[key]
}
environment.PATH = `${path.dirname(shim)}${path.delimiter}${inheritedPath || ''}`
const runtime = resolveCodexExecutable('codex', { environment })
if (path.extname(runtime.executable).toLowerCase() !== '.exe') {
  throw new Error('Codex package did not resolve to its native Windows executable')
}
const codexHome = fs.mkdtempSync(path.join(os.homedir(), '.autoprompt-codex-preflight-'))
const sandboxWorkspace = fs.mkdtempSync(path.join(os.homedir(), '.autoprompt-codex-workspace-'))
const systemRoot = process.env.SystemRoot || process.env.WINDIR
if (!systemRoot || /[\r\n\0]/.test(systemRoot)) throw new Error('SystemRoot is unavailable')
const command = path.join(systemRoot, 'System32', 'cmd.exe')
if (!fs.lstatSync(command).isFile()) throw new Error('Bound Windows command is unavailable')
const childEnvironment = withCodexManagedEnvironment({
  ...environment,
  CODEX_HOME: codexHome,
}, runtime)
const setup = childProcess.spawnSync(runtime.executable, [
  'sandbox', 'setup', '--elevated', '--current-user',
], {
  cwd: codexHome,
  env: childEnvironment,
  encoding: 'utf8',
  shell: false,
  timeout: 300_000,
  windowsHide: true,
})
if (setup.error || setup.status !== 0 || setup.signal) {
  const detail = String(setup.stderr || setup.stdout || setup.error?.message || '')
    .replace(/[\r\n]+/g, ' ').slice(0, 2048)
  throw new Error(`Native Codex elevated sandbox setup failed (${setup.status}/${setup.signal}): ${detail}`)
}
const result = childProcess.spawnSync(runtime.executable, [
  'sandbox', '--permission-profile', ':workspace', '--cd', sandboxWorkspace,
  '--', command, '/d', '/c', 'exit', '0',
], {
  cwd: sandboxWorkspace,
  env: childEnvironment,
  encoding: 'utf8',
  shell: false,
  timeout: 300_000,
  windowsHide: true,
})
if (result.error || result.status !== 0 || result.signal) {
  const detail = String(result.stderr || result.stdout || result.error?.message || '')
    .replace(/[\r\n]+/g, ' ').slice(0, 2048)
  throw new Error(`Native Codex sandbox bootstrap failed (${result.status}/${result.signal}): ${detail}`)
}
const prerequisites = inspectActivationPrerequisites({ env: childEnvironment })
if (prerequisites.activationPrerequisitesReady !== true ||
    prerequisites.sandboxIdentity !== 'available' ||
    prerequisites.runtimeSource !== 'official-package-runtime') {
  throw new Error(`Codex sandbox bootstrap was not qualified: ${JSON.stringify(prerequisites)}`)
}
if (/[\r\n]/.test(codexHome)) throw new Error('Codex home cannot be exported safely')
fs.appendFileSync(process.env.GITHUB_ENV, `CODEX_HOME=${codexHome}\n`)
