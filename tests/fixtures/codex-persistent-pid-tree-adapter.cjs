'use strict'

const crypto = require('node:crypto')
const fs = require('node:fs')
const path = require('node:path')
const { spawn, spawnSync } = require('node:child_process')

const CAPABILITIES = Object.freeze({
  groupAtCreation: true,
  descendantEnumeration: true,
  groupSignal: true,
  stableIdentity: true,
  persistentIdentity: true,
  reservationRecovery: true,
})

function hash(value) {
  return crypto.createHash('sha256').update(String(value)).digest('hex')
}

function processAlive(pid) {
  if (!Number.isSafeInteger(pid) || pid < 1) return false
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    return Boolean(error && error.code === 'EPERM')
  }
}

function pidFromIdentity(identity) {
  const match = /^persistent-pid-tree:v1:(\d+)$/.exec(String(identity))
  if (!match) throw new Error(`invalid persistent PID-tree identity: ${identity}`)
  const pid = Number(match[1])
  if (!Number.isSafeInteger(pid) || pid < 1) throw new Error(`invalid persistent PID-tree PID: ${identity}`)
  return pid
}

function sidecarPath(controlRoot, reservationId) {
  return path.join(controlRoot, `${hash(reservationId)}.json`)
}

function readSidecar(controlRoot, reservationId) {
  const filename = sidecarPath(controlRoot, reservationId)
  if (!fs.existsSync(filename)) return null
  const record = JSON.parse(fs.readFileSync(filename, 'utf8'))
  if (!record || record.schemaVersion !== 1 || record.reservationId !== reservationId ||
      record.reservationHash !== hash(reservationId) ||
      !Number.isSafeInteger(record.rootPid) || record.rootPid < 1 ||
      record.groupIdentity !== `persistent-pid-tree:v1:${record.rootPid}`) {
    throw new Error(`invalid persistent PID-tree sidecar: ${filename}`)
  }
  return record
}

function terminateTree(pid, signal = 'KILL') {
  if (!processAlive(pid)) return
  if (process.platform === 'win32') {
    const result = spawnSync('taskkill.exe', ['/PID', String(pid), '/T', '/F'], {
      encoding: 'utf8',
      windowsHide: true,
    })
    if (result.status !== 0 && processAlive(pid)) {
      throw new Error(result.stderr || result.stdout || `taskkill failed for PID ${pid}`)
    }
    return
  }
  try {
    process.kill(-pid, signal === 'KILL' ? 'SIGKILL' : 'SIGTERM')
  } catch (error) {
    if (!error || error.code !== 'ESRCH') throw error
  }
}

function createPersistentPidTreeAdapter(options = {}) {
  if (typeof options.controlRoot !== 'string' || !path.isAbsolute(options.controlRoot)) {
    throw new Error('persistent PID-tree adapter requires an absolute controlRoot')
  }
  const controlRoot = path.resolve(options.controlRoot)
  fs.mkdirSync(controlRoot, { recursive: true })
  const kind = process.platform === 'win32' ? 'windows-job-object' : 'posix-process-group'
  const adapter = {
    kind,
    capabilities: CAPABILITIES,
    async admit() { return { supported: true, mechanism: 'test-persistent-pid-tree' } },
    async spawnOwned(spec) {
      const child = spawn(spec.executable, spec.argv, {
        cwd: spec.cwd,
        env: { ...(spec.env || {}) },
        detached: process.platform !== 'win32',
        shell: false,
        windowsHide: true,
        stdio: [spec.stdin || 'ignore', spec.stdout || 'ignore', spec.stderr || 'ignore'],
      })
      if (!child || !Number.isSafeInteger(child.pid) || child.pid < 1) {
        throw new Error('persistent PID-tree spawn returned no PID')
      }
      const record = {
        schemaVersion: 1,
        reservationId: spec.reservationId,
        reservationHash: hash(spec.reservationId),
        rootPid: child.pid,
        groupIdentity: `persistent-pid-tree:v1:${child.pid}`,
        targetKey: spec.targetKey,
      }
      fs.writeFileSync(sidecarPath(controlRoot, spec.reservationId), `${JSON.stringify(record)}\n`, {
        encoding: 'utf8', flag: 'wx', mode: 0o600,
      })
      child.unref()
      return { rootPid: record.rootPid, groupIdentity: record.groupIdentity, child }
    },
    async recoverReservation(reservationId) {
      const record = readSidecar(controlRoot, reservationId)
      if (!record || !processAlive(record.rootPid)) return null
      return { rootPid: record.rootPid, groupIdentity: record.groupIdentity }
    },
    async listOwned(identity) {
      const pid = pidFromIdentity(identity)
      return processAlive(pid) ? [pid] : []
    },
    async signalOwned(identity, signal) {
      terminateTree(pidFromIdentity(identity), signal)
    },
    async verifyOwnership({ rootPid, groupIdentity }) {
      return pidFromIdentity(groupIdentity) === rootPid && processAlive(rootPid)
    },
    async listTargetOwned(targetKey, records) {
      const live = []
      for (const record of records.filter(item => item.targetKey === targetKey && item.status === 'RUNNING')) {
        live.push(...await adapter.listOwned(record.groupIdentity))
      }
      return live
    },
  }
  return adapter
}

function livePersistentPidTrees(controlRoot) {
  if (!fs.existsSync(controlRoot)) return []
  const live = []
  for (const name of fs.readdirSync(controlRoot)) {
    if (!name.endsWith('.json')) continue
    let record
    try { record = JSON.parse(fs.readFileSync(path.join(controlRoot, name), 'utf8')) } catch { continue }
    if (record && Number.isSafeInteger(record.rootPid) && processAlive(record.rootPid)) live.push(record.rootPid)
  }
  return [...new Set(live)].sort((left, right) => left - right)
}

function killAllPersistentPidTrees(controlRoot) {
  for (const pid of livePersistentPidTrees(controlRoot)) terminateTree(pid, 'KILL')
  return livePersistentPidTrees(controlRoot)
}

module.exports = {
  createPersistentPidTreeAdapter,
  killAllPersistentPidTrees,
  livePersistentPidTrees,
}
