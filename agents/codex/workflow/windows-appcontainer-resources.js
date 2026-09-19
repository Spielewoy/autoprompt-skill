'use strict'

const fs = require('node:fs')
const path = require('node:path')
const cp = require('node:child_process')
const crypto = require('node:crypto')
const { createWindowsFilesystemCapture } = require('./windows-filesystem.js')
const LIMIT = 8 * 1024 * 1024
const MAX_RESOURCE_ENTRIES = 16 * 1024, MAX_RECOVERY_ENTRIES = 2 * MAX_RESOURCE_ENTRIES
const sha = bytes => crypto.createHash('sha256').update(bytes).digest('hex')
const exact = (value, keys) => value && typeof value === 'object' && !Array.isArray(value) && Object.keys(value).length === keys.length && keys.every(key => Object.hasOwn(value, key))
function fail(code, message) { const error = new Error(message); error.code = code; throw error }
function need(value, code = 'WINDOWS_RESOURCE_INVALID') { if (!value) fail(code, 'Windows resource lease refused an invalid or changed binding') }
function absolute(value) {
  need(typeof value === 'string' && /^[A-Za-z]:\\/.test(value) && value.length <= 32760 && !value.includes('\0'))
  const parts = value.slice(3).split('\\')
  need(parts.length > 0 && parts.length <= 128 && parts.every(part => part && part !== '.' && part !== '..' && !/[<>:"/|?*\x00-\x1f]/.test(part) && !/[ .]$/.test(part)))
  need(path.win32.normalize(value).toLowerCase() === value.toLowerCase())
  return value
}
const within = (root, value) => value.toLowerCase() === root.toLowerCase() || value.toLowerCase().startsWith(root.toLowerCase() + '\\')
function resourceRoots(policy, controlRoot, executableRoots) {
  need(policy && typeof policy === 'object' && typeof policy.readOnly === 'boolean')
  absolute(controlRoot); absolute(policy.targetPath); absolute(policy.scratchPath)
  for (const key of ['readableRoots', 'writableRoots']) need(Array.isArray(policy[key]) && policy[key].length <= 32 && policy[key].every(value => absolute(value)))
  need(policy.writableRoots.every(root => policy.readableRoots.some(read => within(read, root))))
  need(policy.writableRoots.some(root => within(root, policy.scratchPath)))
  if (policy.readOnly) need(policy.writableRoots.every(root => within(policy.scratchPath, root)) && !within(policy.targetPath, policy.scratchPath) && !within(policy.scratchPath, policy.targetPath))
  else need(policy.writableRoots.some(root => within(root, policy.targetPath)))
  need(policy.readableRoots.some(root => within(root, policy.targetPath)))
  // The journal must remain outside every worker resource, in both directions.
  need([...policy.readableRoots, ...policy.writableRoots].every(root => !within(root, controlRoot) && !within(controlRoot, root)))
  need(Array.isArray(executableRoots) && executableRoots.length > 0 && executableRoots.length <= 16)
  const roots = new Map()
  const add = (value, kind, writable) => {
    absolute(value)
    const key = value.toLowerCase(), old = roots.get(key)
    need(!old || old.kind === kind)
    roots.set(key, { path: value, kind, writable: writable || Boolean(old && old.writable) })
  }
  for (const root of policy.readableRoots) add(root, 'directory', false)
  for (const root of policy.writableRoots) add(root, 'directory', true)
  for (const root of executableRoots) {
    need(exact(root, ['path', 'kind']) && ['file', 'directory'].includes(root.kind))
    // Exact command files inside the controller root may be admitted; never its directory.
    need(root.kind === 'file' || (!within(root.path, controlRoot) && !within(controlRoot, root.path)))
    add(root.path, root.kind, false)
  }
  need(roots.size <= 64)
  return [...roots.values()]
}
function validatePlan(plan, expected = {}) {
  need(exact(plan, ['schemaVersion', 'profileName', 'profileSid', 'roots', 'entries']) && plan.schemaVersion === 3 && /^Autoprompt_[a-f0-9]{32}$/.test(plan.profileName) && /^S-1-15-2-(?:[0-9]+-){6}[0-9]+$/.test(plan.profileSid))
  need(!expected.profileName || plan.profileName === expected.profileName)
  need(Array.isArray(plan.roots) && plan.roots.length > 0 && plan.roots.length <= 64 && Array.isArray(plan.entries) && plan.entries.length > 0)
  need(plan.entries.length <= MAX_RESOURCE_ENTRIES, 'WINDOWS_RESOURCE_LIMIT')
  const ids = new Map(), validIdentity = entry => typeof entry.identity === 'string' && /^[a-f0-9]{8}:[a-f0-9]{16}$/.test(entry.identity) && typeof entry.creation === 'string' && /^[0-9]{1,19}$/.test(entry.creation)
  for (const entry of plan.entries) {
    need(exact(entry, ['identity', 'creation', 'label', 'directory', 'writable', 'git', 'root', 'daclProtected', 'inheritedAces', 'explicitAces']) && validIdentity(entry) && ['directory', 'writable', 'git', 'root', 'daclProtected'].every(key => typeof entry[key] === 'boolean') && typeof entry.label === 'string' && entry.label.length <= 5464 && Buffer.from(entry.label, 'base64').toString('base64') === entry.label && !ids.has(entry.identity))
    need(Array.isArray(entry.inheritedAces) && Array.isArray(entry.explicitAces) && entry.inheritedAces.length + entry.explicitAces.length <= 8192)
    need((entry.git && !entry.daclProtected) || (!entry.inheritedAces.length && !entry.explicitAces.length))
    let aclBytes = 8
    const decodeAce = (value, inherited) => {
      need(typeof value === 'string' && value.length <= 87380)
      const bytes = Buffer.from(value, 'base64'); aclBytes += bytes.length
      need(bytes.length >= 4 && bytes.length <= 65528 && !(bytes.length & 3) && bytes.readUInt16LE(2) === bytes.length && bytes.toString('base64') === value && Boolean(bytes[1] & 16) === inherited && aclBytes <= 65535)
      bytes[1] &= ~16
      return bytes.toString('base64')
    }
    const flattened = new Set(entry.inheritedAces.map(value => decodeAce(value, true)))
    for (const value of entry.explicitAces) need(flattened.has(decodeAce(value, false)))
    ids.set(entry.identity, entry)
  }
  for (const root of plan.roots) {
    need(exact(root, ['path', 'kind', 'identity', 'creation', 'writable']) && validIdentity(root) && ['file', 'directory'].includes(root.kind) && typeof root.writable === 'boolean')
    absolute(root.path)
    const entry = ids.get(root.identity)
    need(entry && entry.creation === root.creation && entry.directory === (root.kind === 'directory') && entry.root)
  }
  if (expected.roots) need(JSON.stringify(plan.roots.map(({ path, kind, writable }) => ({ path, kind, writable }))) === JSON.stringify(expected.roots))
  need(Buffer.byteLength(JSON.stringify(plan)) <= LIMIT - 4096, 'WINDOWS_RESOURCE_LIMIT')
  return plan
}
function bind(file, max, single = true) {
  const canonical = fs.realpathSync.native(file)
  need(canonical.toLowerCase() === path.resolve(file).toLowerCase(), 'WINDOWS_RUNTIME_INVALID')
  for (let cursor = canonical; ; cursor = path.dirname(cursor)) {
    const stat = fs.lstatSync(cursor)
    need(!stat.isSymbolicLink() && (cursor === canonical || stat.isDirectory()), 'WINDOWS_RUNTIME_INVALID')
    if (cursor === path.parse(cursor).root) break
  }
  const fd = fs.openSync(canonical, 'r')
  try {
    const before = fs.fstatSync(fd, { bigint: true })
    need(before.isFile() && (!single || before.nlink === 1n) && before.size > 0n && before.size <= BigInt(max), 'WINDOWS_RUNTIME_INVALID')
    const bytes = fs.readFileSync(fd), after = fs.fstatSync(fd, { bigint: true })
    need(['dev', 'ino', 'size', 'mtimeNs', 'ctimeNs'].every(key => before[key] === after[key]) && bytes.length === Number(before.size), 'WINDOWS_RUNTIME_MISMATCH')
    return { path: canonical, dev: String(before.dev), ino: String(before.ino), size: Number(before.size), sha256: sha(bytes) }
  } finally { fs.closeSync(fd) }
}
function nativeBackend(controlRoot, deploymentRoot) {
  need(process.platform === 'win32', 'COMMAND_SANDBOX_UNSUPPORTED')
  // Standalone crash recovery creates a fresh verified deployment under the
  // retained controller root; command execution supplies its existing one.
  const ownedDeployment = deploymentRoot ? null : require('./windows-helper-deployment.js').stageWindowsHelperDeployment(controlRoot)
  deploymentRoot ||= ownedDeployment.root
  try {
    const systemRoot = process.env.SystemRoot
    need(typeof systemRoot === 'string' && /^[A-Za-z]:\\Windows$/i.test(systemRoot), 'WINDOWS_RUNTIME_INVALID')
    const files = [
      [path.join(deploymentRoot, 'windows-appcontainer-resources.ps1'), 1024 * 1024, true],
      [path.join(deploymentRoot, 'windows-appcontainer-resources-native.cs'), 4 * 1024 * 1024, true],
      [path.join(systemRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe'), 64 * 1024 * 1024, false],
    ]
    const bindings = files.map(args => bind(...args)), capture = createWindowsFilesystemCapture()
    capture.assertRecordParent(bindings[0].path)
    const verify = () => files.forEach((args, index) => need(JSON.stringify(bind(...args)) === JSON.stringify(bindings[index]), 'WINDOWS_RUNTIME_MISMATCH'))
    return { capture, cleanup: ownedDeployment?.cleanup, invoke(request) {
      verify()
      const input = JSON.stringify(request); need(Buffer.byteLength(input) <= 12 * 1024 * 1024, 'WINDOWS_RESOURCE_LIMIT')
      const result = cp.spawnSync(bindings[2].path, ['-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', bindings[0].path, '-NativeSha256', bindings[1].sha256, '-Request'], {
        input, encoding: 'utf8', timeout: 120000, maxBuffer: 12 * 1024 * 1024, windowsHide: true, shell: false, cwd: path.dirname(bindings[2].path),
        env: { SystemRoot: systemRoot, WINDIR: systemRoot, SystemDrive: systemRoot.slice(0, 2), PATH: path.join(systemRoot, 'System32'), PSModulePath: '', TEMP: controlRoot, TMP: controlRoot },
      })
      verify()
      need(!result.error && result.status === 0 && !result.signal && result.stderr === '', 'WINDOWS_RESOURCE_HELPER_FAILED')
      let wire; try { wire = JSON.parse(result.stdout) } catch { fail('WINDOWS_RESOURCE_PROTOCOL', 'Resource helper returned invalid JSON') }
      if ((exact(wire, ['schemaVersion', 'status', 'code']) || (exact(wire, ['schemaVersion', 'status', 'code', 'diagnostic']) && typeof wire.diagnostic === 'string' && /^[A-Za-z0-9_ .:()-]{1,256}$/.test(wire.diagnostic))) && wire.schemaVersion === 1 && wire.status === 'REFUSED' && /^(?:WINDOWS|FILESYSTEM|PREIMAGE)_[A-Z_]{1,80}$/.test(wire.code)) fail(wire.code, `Resource helper refused ${request.operation}${wire.diagnostic ? `: ${wire.diagnostic}` : ''}`)
      const field = request.operation === 'plan' ? 'plan' : 'result', status = { plan: 'PLANNED', apply: 'PREPARED', restore: 'RESTORED' }[request.operation]
      need(exact(wire, ['schemaVersion', 'status', field]) && wire.schemaVersion === 1 && wire.status === status, 'WINDOWS_RESOURCE_PROTOCOL')
      return wire[field]
    } }
  } catch (error) { ownedDeployment?.cleanup(); throw error }
}
// The factory is an explicit controller dependency seam; normal callers use the
// exports below, whose backend is always the bound native helper.
function createWindowsAppContainerResources(backendFactory = nativeBackend) {
  function restoreResult(result) {
    need(exact(result, ['restored', 'newEntries', 'deletedEntries']) && Object.values(result).every(value => Number.isSafeInteger(value) && value >= 0) && result.restored <= MAX_RESOURCE_ENTRIES && result.deletedEntries <= MAX_RESOURCE_ENTRIES && result.newEntries <= MAX_RECOVERY_ENTRIES && result.restored + result.newEntries <= MAX_RECOVERY_ENTRIES, 'WINDOWS_RESOURCE_PROTOCOL')
    return Object.freeze({ ...result })
  }
  function journalBytes(leaseId, plan) {
    const body = { schemaVersion: 1, leaseId, plan }
    const bytes = Buffer.from(JSON.stringify({ ...body, sha256: sha(JSON.stringify(body)) }) + '\n')
    need(bytes.length <= LIMIT, 'WINDOWS_RESOURCE_LIMIT'); return bytes
  }
  function leaseFor(plan, leaseId, journalPath, backend, verifyDrainEvidence, environment) {
    let released = false
    return Object.freeze({ profileName: plan.profileName, profileSid: plan.profileSid,
      environment: Object.freeze(environment || {}), recovery: Object.freeze({ journalPath, leaseId }),
      async release(evidence) {
        try {
          need(typeof verifyDrainEvidence === 'function' && verifyDrainEvidence(evidence, { profileSid: plan.profileSid, leaseId }) === true, 'APPCONTAINER_CLEANUP_UNCONFIRMED')
          if (released) return
          // A durable completion receipt makes recovery idempotent even after
          // the controller has subsequently removed its private scratch root.
          let completed
          try { completed = backend.capture.captureFileBytes(journalPath + '.restored').content } catch (error) { if (error.code !== 'ENOENT') throw error }
          if (completed) {
            need(Buffer.isBuffer(completed) && completed.length <= 4096, 'WINDOWS_RESOURCE_JOURNAL_MISMATCH')
            let receipt; try { receipt = JSON.parse(completed.toString('utf8')) } catch { fail('WINDOWS_RESOURCE_JOURNAL_MISMATCH', 'Resource completion receipt is invalid') }
            need(exact(receipt, ['schemaVersion', 'leaseId', 'profileSid', 'result']) && receipt.schemaVersion === 1 && receipt.leaseId === leaseId && receipt.profileSid === plan.profileSid, 'WINDOWS_RESOURCE_JOURNAL_MISMATCH')
            const result = restoreResult(receipt.result)
            need(result.restored + result.deletedEntries === plan.entries.length, 'WINDOWS_RESOURCE_JOURNAL_MISMATCH')
            released = true; backend.cleanup?.(); return result
          }
          const result = restoreResult(await backend.invoke({ schemaVersion: 1, operation: 'restore', plan }))
          need(result.restored + result.deletedEntries === plan.entries.length, 'WINDOWS_RESOURCE_PROTOCOL')
          const done = Buffer.from(JSON.stringify({ schemaVersion: 1, leaseId, profileSid: plan.profileSid, result }) + '\n')
          try { backend.capture.publishRecordExclusive(journalPath + '.restored', done) } catch (error) { if (error.code !== 'EEXIST') throw error; need(backend.capture.captureFileBytes(journalPath + '.restored').content.equals(done), 'WINDOWS_RESOURCE_JOURNAL_MISMATCH') }
          released = true
          backend.cleanup?.()
          return result
        } catch (error) {
          error.recovery = Object.freeze({ journalPath, leaseId, profileSid: plan.profileSid }); throw error
        }

      },
    })
  }
  return {
    async prepareWindowsAppContainerResources(options) {
      const { policy, controlRoot, executableRoots, verifyDrainEvidence } = options
      need(typeof verifyDrainEvidence === 'function', 'APPCONTAINER_CLEANUP_UNCONFIRMED')
      const roots = resourceRoots(policy, controlRoot, executableRoots)
      const leaseId = crypto.randomBytes(16).toString('hex'), profileName = `Autoprompt_${leaseId}`
      const backend = backendFactory(controlRoot, options.deploymentRoot), journalPath = path.win32.join(controlRoot, `${leaseId}.resources.json`)
      try {
        backend.capture.assertRecordParent(journalPath)
        const plan = validatePlan(await backend.invoke({ schemaVersion: 1, operation: 'plan', profileName, roots }), { profileName, roots })
        backend.capture.publishRecordExclusive(journalPath, journalBytes(leaseId, plan))
        try {
          const result = await backend.invoke({ schemaVersion: 1, operation: 'apply', plan })
          need(exact(result, ['profileName', 'profileSid', 'profilePath']) && result.profileName === profileName && result.profileSid === plan.profileSid, 'WINDOWS_RESOURCE_PROTOCOL')
          absolute(result.profilePath)
          return leaseFor(plan, leaseId, journalPath, backend, verifyDrainEvidence, { USERPROFILE: result.profilePath, HOME: result.profilePath, APPDATA: result.profilePath, TEMP: policy.scratchPath, TMP: policy.scratchPath })
        } catch (error) {
          error.recovery = Object.freeze({ journalPath, leaseId, profileSid: plan.profileSid }); throw error
        }
      } catch (error) { backend.cleanup?.(); throw error }
    },
    async recoverWindowsAppContainerResources(options) {
      const { controlRoot, journalPath, verifyDrainEvidence, evidence } = options
      absolute(controlRoot); absolute(journalPath)
      need(path.win32.dirname(journalPath).toLowerCase() === controlRoot.toLowerCase() && /^[a-f0-9]{32}\.resources\.json$/.test(path.win32.basename(journalPath)))
      const backend = backendFactory(controlRoot, options.deploymentRoot)
      try {
        backend.capture.assertRecordParent(journalPath)
        const captured = backend.capture.captureFileBytes(journalPath)
        need(Buffer.isBuffer(captured.content) && captured.content.length <= LIMIT)
        let journal; try { journal = JSON.parse(captured.content.toString('utf8')) } catch { fail('WINDOWS_RESOURCE_JOURNAL_INVALID', 'Resource journal is invalid') }
        need(exact(journal, ['schemaVersion', 'leaseId', 'plan', 'sha256']) && journal.schemaVersion === 1 && /^[a-f0-9]{32}$/.test(journal.leaseId) && path.win32.basename(journalPath) === `${journal.leaseId}.resources.json` && journal.sha256 === sha(JSON.stringify({ schemaVersion: 1, leaseId: journal.leaseId, plan: journal.plan })), 'WINDOWS_RESOURCE_JOURNAL_INVALID')
        const plan = validatePlan(journal.plan, { profileName: `Autoprompt_${journal.leaseId}` })
        return await leaseFor(plan, journal.leaseId, journalPath, backend, verifyDrainEvidence).release(evidence)
      } finally { backend.cleanup?.() }
    },
  }
}
module.exports = { ...createWindowsAppContainerResources(), createWindowsAppContainerResources, resourceRoots, validatePlan }
