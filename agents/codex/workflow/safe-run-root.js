'use strict'

const crypto = require('node:crypto')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { spawnSync } = require('node:child_process')

const OWNER_FILE = '.autoprompt-owner.json'
const OWNER_SCHEMA = 'autoprompt.run-root-owner.v2'
const DIRECTORY_MODE = 0o700
const FILE_MODE = 0o600

class RunRecordError extends Error {
  constructor(code, message, details = {}) {
    super(message)
    this.name = 'RunRecordError'
    this.code = code
    this.details = details
  }
}

function sha256(value) {
  return crypto.createHash('sha256').update(value).digest('hex')
}

function normalizeIdentityPath(value) {
  const resolved = path.resolve(value)
  return process.platform === 'win32' ? resolved.toLowerCase() : resolved
}

function pathIsInside(parent, child) {
  const relative = path.relative(path.resolve(parent), path.resolve(child))
  return relative === '' || (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative))
}

function statIdentity(stats) {
  return {
    dev: String(stats.dev),
    ino: String(stats.ino),
    mode: stats.mode,
    nlink: Number(stats.nlink),
  }
}

function sameIdentity(left, right) {
  return Boolean(left && right && String(left.dev) === String(right.dev) && String(left.ino) === String(right.ino))
}

function existingPrefixes(absolutePath) {
  const resolved = path.resolve(absolutePath)
  const root = path.parse(resolved).root
  const rest = resolved.slice(root.length).split(path.sep).filter(Boolean)
  const prefixes = [root]
  let current = root
  for (const part of rest) {
    current = path.join(current, part)
    prefixes.push(current)
  }
  return prefixes
}

// Node exposes symbolic links and Windows junctions through lstat().isSymbolicLink().
// O_NOFOLLOW adds the kernel check where supported. realpath comparison catches other
// name-surrogate/reparse redirects that Node can observe, while device/inode binding
// detects a later replacement. Unknown reparse tags cannot be safely opened by Node,
// so callers fall back to the provider-private root on any ambiguity.
function inspectPathNoFollow(candidate, options = {}) {
  const absolute = path.resolve(candidate)
  const mustBeDirectory = options.mustBeDirectory !== false
  const fileSystem = options.fsImpl || fs
  let last = null
  let targetStats = null

  for (const prefix of existingPrefixes(absolute)) {
    let stats
    try {
      stats = fileSystem.lstatSync(prefix)
    } catch (error) {
      if (error.code === 'ENOENT') break
      throw new RunRecordError('RUN_RECORD_UNSAFE', `Cannot inspect run-record path without following links: ${prefix}`, { cause: error.code })
    }
    if (stats.isSymbolicLink()) {
      throw new RunRecordError('RUN_RECORD_UNSAFE', `Linked, junction, or name-surrogate path is not allowed: ${prefix}`, { path: prefix })
    }
    if (prefix !== absolute && !stats.isDirectory()) {
      throw new RunRecordError('RUN_RECORD_UNSAFE', `A run-record ancestor is not a directory: ${prefix}`, { path: prefix })
    }
    if (prefix === absolute) targetStats = stats
    else last = { path: prefix, stats }
  }

  const disappeared = () => ({
    exists: false,
    path: absolute,
    nearestExisting: last && last.path,
    nearestIdentity: last && statIdentity(last.stats),
  })

  if (targetStats) {
    if (mustBeDirectory && !targetStats.isDirectory()) {
      throw new RunRecordError('RUN_RECORD_UNSAFE', `Run-record path is not a directory: ${absolute}`, { path: absolute })
    }
    let real
    try {
      real = fileSystem.realpathSync.native(absolute)
    } catch (error) {
      if (error.code === 'ENOENT') return disappeared()
      throw error
    }
    if (normalizeIdentityPath(real) !== normalizeIdentityPath(absolute)) {
      // On Windows a name deleted after lstat can briefly resolve through the
      // NTFS deleted-object namespace. Accept only proven disappearance; a
      // still-present redirect, junction, or replacement remains fail-closed.
      try { fileSystem.lstatSync(absolute) } catch (error) {
        if (error.code === 'ENOENT') return disappeared()
        throw new RunRecordError('RUN_RECORD_UNSAFE', `Cannot recheck redirected run-record path: ${absolute}`, { cause: error.code })
      }
      throw new RunRecordError('RUN_RECORD_UNSAFE', `Run-record path resolves through a redirect: ${absolute}`, { path: absolute, realpath: real })
    }
    return { exists: true, path: absolute, realpath: real, identity: statIdentity(targetStats) }
  }
  return disappeared()
}

function assertDirectoryBinding(binding) {
  if (!binding || !binding.path || !binding.identity) {
    throw new RunRecordError('RUN_RECORD_UNSAFE', 'A directory identity binding is required')
  }
  const inspected = inspectPathNoFollow(binding.path)
  if (!inspected.exists || !sameIdentity(binding.identity, inspected.identity)) {
    throw new RunRecordError('RUN_RECORD_UNSAFE', `Run-record directory was replaced after validation: ${binding.path}`, {
      expected: binding.identity,
      actual: inspected.identity || null,
    })
  }
  return inspected
}

function chmodPrivate(target, mode) {
  try {
    fs.chmodSync(target, mode)
  } catch (error) {
    throw new RunRecordError('PRIVACY_UNSUPPORTED', `Cannot apply private permissions to run-record path: ${target}`, { cause: error.code })
  }
}

function ensureWindowsPrivateAcl(target) {
  if (process.platform !== 'win32') return { supported: true, mechanism: 'posix-mode' }
  const account = process.env.USERDOMAIN && process.env.USERNAME
    ? `${process.env.USERDOMAIN}\\${process.env.USERNAME}`
    : process.env.USERNAME
  if (!account) throw new RunRecordError('PRIVACY_UNSUPPORTED', 'Windows account identity is unavailable for a private run-record DACL')
  const result = spawnSync('icacls.exe', [target, '/inheritance:r', '/grant:r', `${account}:(OI)(CI)F`, '/grant:r', '*S-1-5-18:(OI)(CI)F'], {
    encoding: 'utf8',
    windowsHide: true,
  })
  if (result.status !== 0) {
    throw new RunRecordError('PRIVACY_UNSUPPORTED', `Cannot establish a private Windows DACL for run-record root: ${target}`, {
      status: result.status,
      stderr: result.stderr && result.stderr.trim(),
    })
  }
  return { supported: true, mechanism: 'windows-dacl' }
}

function windowsPowerShellEnvironment(extra = {}) {
  const environment = { ...process.env }
  // Codex Desktop can run Node from a bundled PowerShell host whose
  // PSModulePath points only at the bundled PowerShell modules. Passing that
  // value to Windows PowerShell prevents built-in commands such as Get-Acl
  // from loading Microsoft.PowerShell.Security. Let powershell.exe rebuild
  // its own native module search path instead.
  for (const key of Object.keys(environment)) {
    if (key.toLowerCase() === 'psmodulepath') delete environment[key]
  }
  return { ...environment, ...extra }
}

function validateWindowsAclSnapshot(snapshot) {
  if (!snapshot || typeof snapshot !== 'object' || !Array.isArray(snapshot.items) || !snapshot.currentName || !snapshot.currentSid) {
    throw new RunRecordError('PRIVACY_UNSUPPORTED', 'Windows ACL audit did not return a complete owner/rule snapshot')
  }
  const allowed = new Set([
    String(snapshot.currentName).toLowerCase(),
    String(snapshot.currentSid).toLowerCase(),
    'nt authority\\system',
    's-1-5-18',
  ])
  for (const [index, item] of snapshot.items.entries()) {
    // The first item is the audited run root. Its DACL must be protected;
    // descendants may safely inherit only the allowlisted ACL from that root.
    if (index === 0 && item.protected !== true) {
      throw new RunRecordError('PRIVACY_VIOLATION', `Private run-record path has an inherited or unprotected Windows DACL: ${item.path}`, {
        path: item.path,
        protected: item.protected === true,
      })
    }
    const owner = String(item.owner || '').toLowerCase()
    const ownerSid = String(item.ownerSid || '').toLowerCase()
    if (!allowed.has(owner) && !allowed.has(ownerSid)) throw new RunRecordError('PRIVACY_VIOLATION', `Private run-record path has a foreign Windows owner: ${item.path}`, { path: item.path, owner: item.owner })
    for (const rule of item.rules || []) {
      if (String(rule.type).toLowerCase() !== 'allow') continue
      const identity = String(rule.identity || '').toLowerCase()
      const identitySid = String(rule.sid || '').toLowerCase()
      if (!allowed.has(identity) && !allowed.has(identitySid)) {
        throw new RunRecordError('PRIVACY_VIOLATION', `Private run-record path grants Windows access to an unapproved identity: ${item.path}`, {
          path: item.path,
          identity: rule.identity,
          inherited: Boolean(rule.inherited),
        })
      }
    }
  }
  return { valid: true, mechanism: 'windows-dacl', paths: snapshot.items.length }
}

function auditPrivatePermissions(runPath, options = {}) {
  const absolute = path.resolve(runPath)
  const additional = (options.additionalPaths || []).map(item => path.resolve(item))
  const recurse = options.recurse !== false
  if (process.platform !== 'win32') {
    const paths = [absolute, ...additional]
    const visit = (candidate, recurse) => {
      const stats = fs.lstatSync(candidate)
      if (stats.isSymbolicLink()) throw new RunRecordError('PRIVACY_VIOLATION', `Private path is linked: ${candidate}`)
      if (typeof process.getuid === 'function' && Number(stats.uid) !== process.getuid()) {
        throw new RunRecordError('PRIVACY_VIOLATION', `Private path has a foreign POSIX owner: ${candidate}`, { uid: Number(stats.uid) })
      }
      const expected = stats.isDirectory() ? 0o700 : 0o600
      const actual = stats.mode & 0o777
      if (actual !== expected) throw new RunRecordError('PRIVACY_VIOLATION', `Private path mode is broader or incompatible: ${candidate}`, { expected, actual })
      if (stats.isDirectory() && recurse) for (const name of fs.readdirSync(candidate)) visit(path.join(candidate, name), true)
    }
    visit(absolute, recurse)
    for (const candidate of additional) visit(candidate, false)
    return { valid: true, mechanism: 'posix-mode' }
  }
  const script = [
    "$ErrorActionPreference='Stop'",
    '$inputPaths=@($env:AUTOPROMPT_ACL_AUDIT_PATHS|ConvertFrom-Json)',
    '$root=$inputPaths[0]',
    '$targets=@($root)',
    "if($env:AUTOPROMPT_ACL_AUDIT_RECURSE -eq '1'){$targets+=@(Get-ChildItem -LiteralPath $root -Force -Recurse | ForEach-Object { $_.FullName })}",
    'for($i=1;$i -lt $inputPaths.Count;$i++){if(Test-Path -LiteralPath $inputPaths[$i]){$targets+=$inputPaths[$i]}}',
    '$identity=[System.Security.Principal.WindowsIdentity]::GetCurrent()',
    '$items=@()',
    'foreach($p in ($targets | Select-Object -Unique)){',
    '  $acl=Get-Acl -LiteralPath $p',
    '  $ownerSid=(New-Object System.Security.Principal.NTAccount($acl.Owner)).Translate([System.Security.Principal.SecurityIdentifier]).Value',
    '  $rules=@($acl.Access | ForEach-Object {$sid=$null;try{$sid=$_.IdentityReference.Translate([System.Security.Principal.SecurityIdentifier]).Value}catch{};[pscustomobject]@{identity=$_.IdentityReference.Value;sid=$sid;type=$_.AccessControlType.ToString();inherited=$_.IsInherited;rights=$_.FileSystemRights.ToString()}})',
    '  $items+=[pscustomobject]@{path=$p;owner=$acl.Owner;ownerSid=$ownerSid;protected=$acl.AreAccessRulesProtected;rules=$rules}',
    '}',
    '[pscustomobject]@{currentName=$identity.Name;currentSid=$identity.User.Value;items=$items}|ConvertTo-Json -Compress -Depth 7',
  ].join(';')
  const result = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], {
    encoding: 'utf8', windowsHide: true,
    env: windowsPowerShellEnvironment({
      AUTOPROMPT_ACL_AUDIT_PATHS: JSON.stringify([absolute, ...additional]),
      AUTOPROMPT_ACL_AUDIT_RECURSE: recurse ? '1' : '0',
    }),
  })
  if (result.status !== 0) throw new RunRecordError('PRIVACY_UNSUPPORTED', 'Cannot revalidate Windows run-record ACLs', { status: result.status, stderr: result.stderr && result.stderr.trim() })
  let snapshot
  try { snapshot = JSON.parse(result.stdout) } catch { throw new RunRecordError('PRIVACY_UNSUPPORTED', 'Windows ACL audit returned invalid JSON') }
  return validateWindowsAclSnapshot(snapshot)
}

function ensureDirectoryNoFollow(directory, boundary) {
  const absolute = path.resolve(directory)
  if (boundary && !pathIsInside(boundary, absolute)) {
    throw new RunRecordError('RUN_RECORD_UNSAFE', `Run-record directory escapes its registered root: ${absolute}`, { boundary })
  }
  const prefixes = existingPrefixes(absolute)
  for (const prefix of prefixes) {
    if (boundary && !pathIsInside(boundary, prefix) && !pathIsInside(prefix, boundary)) continue
    const before = inspectPathNoFollow(prefix)
    if (!before.exists) {
      try {
        fs.mkdirSync(prefix, { mode: DIRECTORY_MODE })
      } catch (error) {
        if (error.code !== 'EEXIST') throw error
      }
      chmodPrivate(prefix, DIRECTORY_MODE)
    }
    inspectPathNoFollow(prefix)
  }
  return inspectPathNoFollow(absolute)
}

function writeExclusiveFile(filename, bytes) {
  const flags = fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | (fs.constants.O_NOFOLLOW || 0)
  let fd
  try {
    fd = fs.openSync(filename, flags, FILE_MODE)
    const buffer = Buffer.isBuffer(bytes) ? bytes : Buffer.from(String(bytes))
    let offset = 0
    while (offset < buffer.length) offset += fs.writeSync(fd, buffer, offset, buffer.length - offset)
    fs.fsyncSync(fd)
  } finally {
    if (fd !== undefined) fs.closeSync(fd)
  }
  chmodPrivate(filename, FILE_MODE)
}

function processIsAlive(pid) {
  if (!Number.isSafeInteger(pid) || pid <= 0) return false
  try { process.kill(pid, 0); return true } catch (error) { return error.code === 'EPERM' }
}

function syncContainingDirectory(filename) {
  try {
    const descriptor = fs.openSync(path.dirname(filename), 'r')
    try { fs.fsyncSync(descriptor) } finally { fs.closeSync(descriptor) }
  } catch (error) {
    if (!error || !['EINVAL', 'EPERM', 'EISDIR', 'EBADF'].includes(error.code)) throw error
  }
}

function withOwnedLock(lockPath, operation, options = {}) {
  const staleAfterMs = Number.isSafeInteger(options.staleAfterMs) && options.staleAfterMs >= 0 ? options.staleAfterMs : 1000
  const now = options.now instanceof Date ? options.now : new Date(options.now || Date.now())
  const owner = {
    schema: 'autoprompt.private-lock.v3',
    pid: process.pid,
    hostname: os.hostname(),
    createdAt: now.toISOString(),
    processStartedAt: new Date(Date.now() - Math.floor(process.uptime() * 1000)).toISOString(),
    ownerToken: crypto.randomBytes(16).toString('hex'),
  }
  const ownerBytes = Buffer.from(`${JSON.stringify(owner)}\n`, 'utf8')
  const ownerPath = path.join(lockPath, 'owner.json')
  const publicationName = `.owner.${process.pid}.${owner.ownerToken}.tmp`
  const publicationPath = path.join(lockPath, publicationName)
  const recoveryDirectory = options.recoveryDirectory || path.join(path.dirname(lockPath), 'recovered-locks')
  let recovered = false

  const preserveEvidence = (bytes) => {
    ensureDirectoryNoFollow(recoveryDirectory, path.dirname(lockPath))
    const evidencePath = path.join(recoveryDirectory, `${sha256(bytes)}.json`)
    try { writeExclusiveFile(evidencePath, bytes) } catch (error) {
      if (error.code !== 'EEXIST') throw error
      const retained = readFileNoFollow(evidencePath)
      if (!retained || !retained.equals(bytes)) {
        throw new RunRecordError('RUN_RECORD_RECOVERY_REQUIRED', `Existing stale-lock evidence does not match: ${evidencePath}`)
      }
    }
    syncContainingDirectory(evidencePath)
  }

  const removeOwnedDirectory = (recordPath) => {
    if (recordPath) fs.unlinkSync(recordPath)
    if (fs.readdirSync(lockPath).length !== 0) {
      throw new RunRecordError('RUN_RECORD_UNSAFE', `Writer lock contains foreign entries: ${lockPath}`)
    }
    fs.rmdirSync(lockPath)
    syncContainingDirectory(lockPath)
  }

  for (let attempt = 0; attempt < 2; attempt++) {
    let acquired = false
    try {
      // mkdir is the atomic ownership primitive. The metadata is published only
      // after the private directory exists, so fresh empty/partial publication is
      // distinguishable from durable corrupt metadata and is treated as BUSY.
      fs.mkdirSync(lockPath, { mode: DIRECTORY_MODE })
      acquired = true
      chmodPrivate(lockPath, DIRECTORY_MODE)
      syncContainingDirectory(lockPath)
      if (typeof options.afterLockDirectoryCreate === 'function') options.afterLockDirectoryCreate({ lockPath, owner })
      writeExclusiveFile(publicationPath, ownerBytes)
      if (typeof options.beforeLockPublish === 'function') options.beforeLockPublish({ lockPath, publicationPath, owner })
      fs.renameSync(publicationPath, ownerPath)
      syncContainingDirectory(ownerPath)
      syncContainingDirectory(lockPath)
      try {
        if (typeof options.afterLockPublish === 'function') options.afterLockPublish({ lockPath, owner })
        return operation({ owner, recovered })
      } finally {
        const current = readFileNoFollow(ownerPath)
        let saved = null
        try { saved = current && JSON.parse(current.toString('utf8')) } catch {}
        if (!saved || saved.ownerToken !== owner.ownerToken) {
          throw new RunRecordError('RUN_RECORD_UNSAFE', `Writer lock ownership changed before release: ${lockPath}`)
        }
        removeOwnedDirectory(ownerPath)
      }
    } catch (error) {
      if (acquired) {
        // Normal local failures are cleaned up. A process crash bypasses this path;
        // the next contender observes the bounded incomplete directory below.
        try {
          if (fs.existsSync(publicationPath)) fs.unlinkSync(publicationPath)
          if (fs.existsSync(ownerPath)) {
            const bytes = readFileNoFollow(ownerPath)
            let saved = null
            try { saved = JSON.parse(bytes.toString('utf8')) } catch {}
            if (!saved || saved.ownerToken !== owner.ownerToken) throw error
            fs.unlinkSync(ownerPath)
          }
          if (fs.existsSync(lockPath) && fs.readdirSync(lockPath).length === 0) fs.rmdirSync(lockPath)
          syncContainingDirectory(lockPath)
        } catch (cleanupError) {
          if (cleanupError !== error) throw cleanupError
        }
        throw error
      }
      if (error.code !== 'EEXIST') throw error

      let lockItem
      try { lockItem = fs.lstatSync(lockPath) } catch (inspectionError) {
        if (inspectionError.code === 'ENOENT') continue
        throw inspectionError
      }
      if (typeof options.afterContendedLockLstat === 'function') options.afterContendedLockLstat({ lockPath, lockItem, attempt })
      if (lockItem.isSymbolicLink()) {
        throw new RunRecordError('RUN_RECORD_UNSAFE', `Writer lock is a link or name surrogate: ${lockPath}`)
      }
      // Preserve compatibility with already persisted v2 lock files. They may be
      // recovered once, but a hard-linked/foreign object is never trusted.
      if (!lockItem.isDirectory()) {
        if (!lockItem.isFile() || Number(lockItem.nlink) !== 1) {
          throw new RunRecordError('RUN_RECORD_UNSAFE', `Writer lock is not one physical object: ${lockPath}`)
        }
        let bytes
        try { bytes = readFileNoFollow(lockPath) } catch (readError) {
          if (readError.code === 'ENOENT') continue
          throw readError
        }
        if (bytes === null) continue
        let staleOwner
        try { staleOwner = JSON.parse(bytes.toString('utf8')) } catch {
          throw new RunRecordError('RUN_RECORD_RECOVERY_REQUIRED', `Writer lock metadata is corrupt: ${lockPath}`)
        }
        const created = Date.parse(staleOwner.createdAt)
        const ageMs = Number.isFinite(created) ? now.getTime() - created : -1
        const safelyStale = staleOwner.schema === 'autoprompt.private-lock.v2' && staleOwner.hostname === os.hostname() &&
          Number.isSafeInteger(staleOwner.pid) && !processIsAlive(staleOwner.pid) && ageMs >= staleAfterMs
        if (!safelyStale) throw new RunRecordError('RUN_RECORD_BUSY', `Writer lock is active or not safely stale: ${lockPath}`, { owner: staleOwner, ageMs, staleAfterMs })
        preserveEvidence(bytes)
        fs.unlinkSync(lockPath)
        syncContainingDirectory(lockPath)
        recovered = true
        continue
      }

      const inspected = inspectPathNoFollow(lockPath)
      if (!inspected.exists) continue
      let entries
      try { entries = fs.readdirSync(lockPath) } catch (inspectionError) {
        if (inspectionError.code === 'ENOENT') continue
        throw inspectionError
      }
      const publications = entries.filter((entry) => /^\.owner\.\d+\.[a-f0-9]{32}\.tmp$/.test(entry))
      const metadataExists = entries.includes('owner.json')
      const foreign = entries.filter((entry) => entry !== 'owner.json' && !publications.includes(entry))
      if (foreign.length || publications.length > 1 || (metadataExists && publications.length)) {
        throw new RunRecordError('RUN_RECORD_UNSAFE', `Writer lock contains foreign or ambiguous entries: ${lockPath}`, { entries })
      }
      const lockAgeMs = now.getTime() - lockItem.mtimeMs
      let bytes = null
      let staleOwner = null
      let recordPath = null
      if (metadataExists) {
        recordPath = ownerPath
        try { bytes = readFileNoFollow(recordPath) } catch (readError) {
          if (readError.code === 'ENOENT') continue
          throw readError
        }
        if (bytes === null) continue
        try { staleOwner = JSON.parse(bytes.toString('utf8')) } catch {
          if (lockAgeMs < staleAfterMs) throw new RunRecordError('RUN_RECORD_BUSY', `Writer lock publication is still in progress: ${lockPath}`, { ageMs: lockAgeMs, staleAfterMs })
          throw new RunRecordError('RUN_RECORD_RECOVERY_REQUIRED', `Writer lock metadata is corrupt: ${lockPath}`)
        }
      } else if (publications.length) {
        recordPath = path.join(lockPath, publications[0])
        try { bytes = readFileNoFollow(recordPath) } catch (readError) {
          if (readError.code === 'ENOENT') continue
          throw readError
        }
        if (bytes === null) continue
        try { staleOwner = JSON.parse(bytes.toString('utf8')) } catch {}
      }
      const created = staleOwner && Date.parse(staleOwner.createdAt)
      const ageMs = Number.isFinite(created) ? now.getTime() - created : -1
      const safelyStale = staleOwner && staleOwner.schema === 'autoprompt.private-lock.v3' && staleOwner.hostname === os.hostname() &&
        Number.isSafeInteger(staleOwner.pid) && !processIsAlive(staleOwner.pid) && ageMs >= staleAfterMs
      if (safelyStale) {
        const afterRead = inspectPathNoFollow(lockPath)
        if (!sameIdentity(inspected.identity, afterRead.identity)) throw new RunRecordError('RUN_RECORD_UNSAFE', `Writer lock changed during stale recovery: ${lockPath}`)
        preserveEvidence(bytes)
        removeOwnedDirectory(recordPath)
        recovered = true
        continue
      }
      if (!metadataExists && lockAgeMs >= staleAfterMs) {
        const evidence = Buffer.from(`${JSON.stringify({
          schema: 'autoprompt.incomplete-private-lock.v1',
          lockName: path.basename(lockPath),
          entries,
          bytesSha256: bytes ? sha256(bytes) : null,
          directoryIdentity: inspected.identity,
        })}\n`, 'utf8')
        preserveEvidence(evidence)
        removeOwnedDirectory(recordPath)
        recovered = true
        continue
      }
      throw new RunRecordError('RUN_RECORD_BUSY', `Writer lock is active or publication is not safely stale: ${lockPath}`, { owner: staleOwner, ageMs, lockAgeMs, staleAfterMs })
    }
  }
  throw new RunRecordError('RUN_RECORD_BUSY', `Could not acquire writer lock after bounded stale recovery: ${lockPath}`)
}

function readFileNoFollow(filename) {
  const inspected = inspectPathNoFollow(filename, { mustBeDirectory: false })
  if (!inspected.exists) return null
  const stats = fs.lstatSync(filename)
  if (!stats.isFile()) throw new RunRecordError('RUN_RECORD_UNSAFE', `Expected a regular ownership file: ${filename}`)
  if (Number(stats.nlink) !== 1) {
    throw new RunRecordError('RUN_RECORD_UNSAFE', `Hard-linked private run-record files are not allowed: ${filename}`, { nlink: Number(stats.nlink) })
  }
  const flags = fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0)
  const fd = fs.openSync(filename, flags)
  try {
    const opened = fs.fstatSync(fd)
    if (!sameIdentity(statIdentity(stats), statIdentity(opened))) {
      throw new RunRecordError('RUN_RECORD_UNSAFE', `Ownership file changed while it was opened: ${filename}`)
    }
    return fs.readFileSync(fd)
  } finally {
    fs.closeSync(fd)
  }
}

function canonicalTargetIdentity(options) {
  if (options.targetKind === 'non-filesystem' || options.nonFilesystem === true) {
    if (!options.targetIdentity) throw new RunRecordError('RUN_RECORD_UNSAFE', 'A stable targetIdentity is required for a non-filesystem target')
    return `non-filesystem:${options.targetIdentity}`
  }
  if (!options.targetPath) throw new RunRecordError('RUN_RECORD_UNSAFE', 'targetPath is required for a filesystem target')
  const target = path.resolve(options.targetPath)
  let real = target
  try {
    real = fs.realpathSync.native(target)
  } catch (error) {
    if (error.code !== 'ENOENT') throw new RunRecordError('RUN_RECORD_UNSAFE', `Cannot identify target: ${target}`, { cause: error.code })
  }
  return `filesystem:${normalizeIdentityPath(real)}`
}

function markerFor(rootKind, providerId, targetIdentity) {
  return {
    schema: OWNER_SCHEMA,
    owner: 'autoprompt',
    provider_id: providerId,
    root_kind: rootKind,
    target_identity_sha256: sha256(targetIdentity),
  }
}

function markerMatches(actual, expected) {
  return actual && Object.keys(expected).every(key => actual[key] === expected[key])
}

function preflightOwnedRoot(rootPath, expectedMarker) {
  const inspected = inspectPathNoFollow(rootPath)
  if (!inspected.exists) return { claimable: true, exists: false }
  const markerPath = path.join(rootPath, OWNER_FILE)
  const markerBytes = readFileNoFollow(markerPath)
  if (markerBytes === null) {
    const entries = fs.readdirSync(rootPath)
    if (entries.length === 0) return { claimable: true, exists: true }
    throw new RunRecordError('RUN_RECORD_UNSAFE', `Existing run root has no Autoprompt ownership marker: ${rootPath}`, { path: rootPath })
  }
  let actual
  try { actual = JSON.parse(markerBytes.toString('utf8')) } catch {
    throw new RunRecordError('RUN_RECORD_UNSAFE', `Run-root ownership marker is invalid: ${markerPath}`, { path: markerPath })
  }
  if (!markerMatches(actual, expectedMarker)) {
    throw new RunRecordError('RUN_RECORD_UNSAFE', `Run root is owned by another target or provider: ${rootPath}`, { expected: expectedMarker, actual })
  }
  return { claimable: false, exists: true }
}

function verifyRootOwnership(rootPath, rootKind, providerId, targetIdentity) {
  const expected = markerFor(rootKind, providerId, targetIdentity)
  const result = preflightOwnedRoot(path.resolve(rootPath), expected)
  if (!result.exists || result.claimable) {
    throw new RunRecordError('RUN_RECORD_UNSAFE', `Run root has no confirmed ownership marker: ${rootPath}`)
  }
  return true
}

function claimRoot(rootPath, expectedMarker, boundary) {
  const preflight = preflightOwnedRoot(rootPath, expectedMarker)
  ensureDirectoryNoFollow(rootPath, boundary)
  const markerPath = path.join(rootPath, OWNER_FILE)
  if (preflight.claimable) {
    try {
      writeExclusiveFile(markerPath, `${JSON.stringify(expectedMarker)}\n`)
    } catch (error) {
      if (error.code !== 'EEXIST') throw error
    }
  }
  const confirmed = preflightOwnedRoot(rootPath, expectedMarker)
  if (!confirmed.exists) throw new RunRecordError('RUN_RECORD_FAILURE', `Failed to claim run root: ${rootPath}`)
  const bound = inspectPathNoFollow(rootPath)
  const privacy = ensureWindowsPrivateAcl(rootPath)
  return { path: rootPath, identity: bound.identity, realpath: bound.realpath, privacy }
}

function projectEligibility(options, targetPath) {
  const disallowed = [
    ['project mutation was not explicitly allowed', options.allowProjectMutation !== true && options.projectMutationAllowed !== true],
    ['target is read-only', options.readOnly === true],
    ['exact-tree behavior is required', options.exactTree === true],
    ['target is an archive or package input', options.archive === true || options.packageInput === true],
    ['target is non-filesystem', options.targetKind === 'non-filesystem' || options.nonFilesystem === true],
    ['provider policy forbids target history', options.policyRestricted === true],
  ]
  const blocked = disallowed.find(([, value]) => value)
  if (blocked) return { eligible: false, reason: blocked[0] }

  let target
  try { target = inspectPathNoFollow(targetPath) } catch (error) { return { eligible: false, reason: error.message } }
  if (!target.exists) return { eligible: false, reason: 'target directory does not exist' }

  try { fs.accessSync(targetPath, fs.constants.R_OK | fs.constants.W_OK) } catch { return { eligible: false, reason: 'target directory is not writable' } }
  const gitDir = path.join(targetPath, '.git')
  try {
    const git = inspectPathNoFollow(gitDir)
    if (!git.exists) return { eligible: false, reason: 'non-Git targets use a sidecar' }
  } catch (error) {
    return { eligible: false, reason: error.message }
  }
  if (fs.existsSync(path.join(targetPath, 'package.json'))) {
    return { eligible: false, reason: 'package targets use a sidecar until their package boundary is mechanically proven' }
  }
  const infoDir = path.join(gitDir, 'info')
  try {
    const info = inspectPathNoFollow(infoDir)
    if (!info.exists) return { eligible: false, reason: 'Git info directory is unavailable for a local-only exclude' }
    const exclude = path.join(infoDir, 'exclude')
    const exclusion = inspectPathNoFollow(exclude, { mustBeDirectory: false })
    if (exclusion.exists && !fs.lstatSync(exclude).isFile()) return { eligible: false, reason: 'Git exclude is not a regular file' }
  } catch (error) {
    return { eligible: false, reason: error.message }
  }
  try {
    preflightOwnedRoot(path.join(targetPath, '.autoprompt'), markerFor('project', options.providerId || 'codex', canonicalTargetIdentity(options)))
  } catch (error) {
    return { eligible: false, reason: error.message }
  }
  return { eligible: true, reason: null }
}

function appendGitInfoExclude(targetPath) {
  const exclude = path.join(targetPath, '.git', 'info', 'exclude')
  const current = readFileNoFollow(exclude)
  const text = current ? current.toString('utf8') : ''
  if (text.split(/\r?\n/).some(line => line.trim() === '.autoprompt/')) return
  const prefix = text.length > 0 && !text.endsWith('\n') ? '\n' : ''
  const flags = fs.constants.O_WRONLY | fs.constants.O_APPEND | fs.constants.O_CREAT | (fs.constants.O_NOFOLLOW || 0)
  const fd = fs.openSync(exclude, flags, FILE_MODE)
  try {
    fs.writeSync(fd, `${prefix}.autoprompt/\n`)
    fs.fsyncSync(fd)
  } finally { fs.closeSync(fd) }
}

function selectSafeRunRoot(options = {}) {
  const providerId = options.providerId || 'codex'
  const targetIdentity = canonicalTargetIdentity(options)
  const targetHash = sha256(targetIdentity)
  const targetPath = options.targetPath && path.resolve(options.targetPath)
  const eligibility = targetPath ? projectEligibility({ ...options, providerId }, targetPath) : { eligible: false, reason: 'target is non-filesystem' }

  if (eligibility.eligible) {
    const rootPath = path.join(targetPath, '.autoprompt')
    const marker = markerFor('project', providerId, targetIdentity)
    const binding = claimRoot(rootPath, marker, targetPath)
    appendGitInfoExclude(targetPath)
    return Object.freeze({
      kind: 'project', rootPath, binding, targetPath, targetIdentity, targetIdentitySha256: targetHash,
      providerId, projectRejection: null, ownerFile: path.join(rootPath, OWNER_FILE),
    })
  }

  const configuredCanonicalRoot = options.canonicalProviderPrivateRoot || process.env.AUTOPROMPT_PRIVATE_ROOT ||
    path.join(process.env.CODEX_HOME || path.join(os.homedir(), '.codex'), 'autoprompt-private')
  const privateBase = path.resolve(configuredCanonicalRoot)
  if (options.providerPrivateRoot && path.resolve(options.providerPrivateRoot) !== privateBase) {
    throw new RunRecordError('SIDECAR_ROOT_NONCANONICAL', 'Caller-supplied providerPrivateRoot cannot choose a second run-history root; use the provider-owned canonicalProviderPrivateRoot', {
      supplied: path.resolve(options.providerPrivateRoot),
      canonical: privateBase,
    })
  }
  const canonicalFilesystemTarget = targetIdentity.startsWith('filesystem:') ? targetIdentity.slice('filesystem:'.length) : null
  if (targetPath && (pathIsInside(targetPath, privateBase) || (canonicalFilesystemTarget && pathIsInside(canonicalFilesystemTarget, privateBase)))) {
    throw new RunRecordError('RUN_RECORD_UNSAFE', 'Provider-private sidecar root must resolve outside the target tree', { targetPath, privateBase })
  }
  const baseParent = path.dirname(privateBase)
  inspectPathNoFollow(baseParent)
  ensureDirectoryNoFollow(privateBase, baseParent)
  const rootPath = path.join(privateBase, 'targets', targetHash, '.autoprompt')
  const marker = markerFor('sidecar', providerId, targetIdentity)
  const binding = claimRoot(rootPath, marker, privateBase)
  return Object.freeze({
    kind: 'sidecar', rootPath, binding, targetPath: targetPath || null, targetIdentity, targetIdentitySha256: targetHash,
    providerId, projectRejection: eligibility.reason, ownerFile: path.join(rootPath, OWNER_FILE),
  })
}

function assertNoPrivatePackagePaths(selection, files) {
  const list = Array.isArray(files) ? files : []
  const privatePaths = list.map(item => typeof item === 'string' ? item : item && (item.path || item.name)).filter(Boolean)
    .filter(item => item.replace(/\\/g, '/').toLowerCase().split('/').includes('.autoprompt'))
  if (privatePaths.length) throw new RunRecordError('RUN_RECORD_UNSAFE', 'Private run records entered a package or archive boundary', { privatePaths })
  return { checked: true, privatePaths: [] }
}

function assertNpmPackExcludesRunRecords(selection, options = {}) {
  const packageCandidate = options.packageRoot || selection.targetPath
  if (!packageCandidate) return { checked: false, files: [] }
  const packageRoot = path.resolve(packageCandidate)
  if (!fs.existsSync(path.join(packageRoot, 'package.json'))) return { checked: false, files: [] }
  const npmCommand = options.npmCommand || 'npm'
  const command = process.platform === 'win32' ? (process.env.ComSpec || 'cmd.exe') : npmCommand
  const args = process.platform === 'win32'
    ? ['/d', '/s', '/c', options.npmCommand || 'npm.cmd', 'pack', '--dry-run', '--json', '--ignore-scripts']
    : ['pack', '--dry-run', '--json', '--ignore-scripts']
  const result = spawnSync(command, args, {
    cwd: packageRoot,
    encoding: 'utf8',
    windowsHide: true,
    env: { ...process.env, npm_config_cache: options.npmCache || path.join(os.tmpdir(), 'autoprompt-npm-pack-cache') },
  })
  if (result.status !== 0) throw new RunRecordError('RUN_RECORD_FAILURE', 'Cannot prove the npm package boundary excludes run records', {
    status: result.status,
    cause: result.error && (result.error.code || result.error.message),
    stderr: result.stderr && result.stderr.trim(),
    stdout: result.stdout && result.stdout.trim(),
  })
  let reports
  try { reports = JSON.parse(result.stdout) } catch { throw new RunRecordError('RUN_RECORD_FAILURE', 'npm pack did not return its machine-readable file list') }
  const files = reports.flatMap(report => report.files || [])
  assertNoPrivatePackagePaths(selection, files)
  return { checked: true, files }
}

function assertRunRecordBoundary(selection, options = {}) {
  assertDirectoryBinding(selection.binding)
  assertProjectRecordUntracked(selection)
  assertNoPrivatePackagePaths(selection, options.packageFiles || options.archiveFiles || [])
  const pack = options.runNpmPack === false ? { checked: false, files: [] } : assertNpmPackExcludesRunRecords(selection, options)
  return { phase: options.phase || 'unspecified', localOnly: true, pack }
}

function validRunId(value) {
  return typeof value === 'string' && value !== '.' && value !== '..' && /^[A-Za-z0-9][A-Za-z0-9._-]{7,127}$/.test(value)
}

function generatedRunId(now = new Date()) {
  return `${now.toISOString().replace(/[-:]/g, '').replace(/\.\d{3}Z$/, 'Z')}-${crypto.randomBytes(8).toString('hex')}`
}

function allocateRunDirectory(selection, options = {}) {
  assertDirectoryBinding(selection.binding)
  const runsPath = path.join(selection.rootPath, 'runs')
  ensureDirectoryNoFollow(runsPath, selection.rootPath)
  const supplied = options.runId
  if (supplied !== undefined && !validRunId(supplied)) throw new RunRecordError('RUN_RECORD_FAILURE', `Invalid run id: ${supplied}`)

  const attempts = supplied === undefined ? 16 : 1
  for (let attempt = 0; attempt < attempts; attempt++) {
    const runId = supplied || generatedRunId(options.now)
    const runPath = path.join(runsPath, runId)
    if (!pathIsInside(runsPath, runPath)) throw new RunRecordError('RUN_RECORD_UNSAFE', `Run id escapes the runs directory: ${runId}`)
    try {
      fs.mkdirSync(runPath, { mode: DIRECTORY_MODE })
      chmodPrivate(runPath, DIRECTORY_MODE)
      ensureWindowsPrivateAcl(runPath)
      const inspected = inspectPathNoFollow(runPath)
      assertDirectoryBinding(selection.binding)
      return Object.freeze({ runId, runPath, binding: { path: runPath, identity: inspected.identity, realpath: inspected.realpath } })
    } catch (error) {
      if (error.code !== 'EEXIST') throw error
      if (supplied !== undefined) {
        throw new RunRecordError('RUN_ID_COLLISION', `Run id is already allocated: ${runId}`, { runId, runPath })
      }
    }
  }
  throw new RunRecordError('RUN_RECORD_FAILURE', 'Could not allocate a unique run directory')
}

function assertProjectRecordUntracked(selection) {
  if (selection.kind !== 'project') return { checked: false, tracked: [] }
  const result = spawnSync('git', ['-C', selection.targetPath, 'ls-files', '--cached', '--', '.autoprompt'], { encoding: 'utf8', windowsHide: true })
  if (result.status !== 0) throw new RunRecordError('RUN_RECORD_FAILURE', `Cannot prove project run records are untracked: ${result.stderr.trim()}`)
  const tracked = result.stdout.split(/\r?\n/).filter(Boolean)
  if (tracked.length) throw new RunRecordError('RUN_RECORD_UNSAFE', 'Project run records are tracked or staged', { tracked })
  return { checked: true, tracked: [] }
}

module.exports = {
  OWNER_FILE,
  OWNER_SCHEMA,
  DIRECTORY_MODE,
  FILE_MODE,
  RunRecordError,
  sha256,
  pathIsInside,
  inspectPathNoFollow,
  readFileNoFollow,
  ensureDirectoryNoFollow,
  assertDirectoryBinding,
  canonicalTargetIdentity,
  verifyRootOwnership,
  selectSafeRunRoot,
  resolveSafeRunRoot: selectSafeRunRoot,
  allocateRunDirectory,
  assertProjectRecordUntracked,
  assertNoPrivatePackagePaths,
  assertNpmPackExcludesRunRecords,
  assertRunRecordBoundary,
  ensureWindowsPrivateAcl,
  validateWindowsAclSnapshot,
  auditPrivatePermissions,
  withOwnedLock,
}
