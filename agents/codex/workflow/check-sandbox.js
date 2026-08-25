#!/usr/bin/env node
'use strict'

const fs = require('node:fs')
const path = require('node:path')
const { validateProviderCapabilities } = require('./context-envelope.js')

const WRITE_RESOURCE_KINDS = Object.freeze([
  'workspace', 'cache', 'database', 'service', 'port', 'generated', 'temporary',
])

class CheckSandboxError extends Error {
  constructor(code, message, details = {}) {
    super(message)
    this.name = 'CheckSandboxError'
    this.code = code
    this.details = details
  }
}

function nonEmpty(value) {
  return typeof value === 'string' && value.trim().length > 0
}

function canonicalResourceId(kind, id) {
  let value = String(id).trim()
  if (['workspace', 'cache', 'generated', 'temporary'].includes(kind)) {
    value = physicalPath(value)
    if (process.platform === 'win32') value = value.toLowerCase()
  }
  return `${kind}:${value}`
}

function physicalPath(value) {
  const resolved = path.resolve(value)
  try { return fs.realpathSync.native(resolved) } catch { return resolved }
}

function pathsOverlap(left, right) {
  const a = physicalPath(left)
  const b = physicalPath(right)
  if (process.platform === 'win32' ? a.toLowerCase() === b.toLowerCase() : a === b) return true
  const ab = path.relative(a, b)
  const ba = path.relative(b, a)
  return (ab && !ab.startsWith('..') && !path.isAbsolute(ab)) ||
    (ba && !ba.startsWith('..') && !path.isAbsolute(ba))
}

function normalizeResource(resource) {
  const item = typeof resource === 'string'
    ? { kind: 'workspace', id: resource }
    : resource
  const itemKind = item && (item.kind || item.type)
  const itemId = item && (item.id ?? item.name)
  if (!item || !nonEmpty(itemKind) || !nonEmpty(String(itemId ?? ''))) {
    throw new CheckSandboxError('INVALID_CHECK_RESOURCE', 'write resources require kind and id')
  }
  const kind = String(itemKind).toLowerCase()
  if (!WRITE_RESOURCE_KINDS.includes(kind)) {
    throw new CheckSandboxError('INVALID_CHECK_RESOURCE_KIND', `unknown check resource kind: ${kind}`)
  }
  const id = String(itemId).trim()
  if (kind === 'port') {
    const port = Number(id)
    if (!Number.isInteger(port) || port < 1 || port > 65535) {
      throw new CheckSandboxError('INVALID_CHECK_PORT', `invalid port resource: ${id}`)
    }
  }
  return Object.freeze({
    kind,
    id,
    key: canonicalResourceId(kind, id),
    mode: 'exclusive',
  })
}

function commandWrites(command) {
  if (typeof command === 'string') return command.trim().length > 0
  if (!command || typeof command !== 'object') return false
  if (command.readOnly === true) return false
  // Build/test commands are conservatively write-producing unless an adapter
  // positively marks them read-only.
  return true
}

function normalizeWriteManifest(checker, options = {}) {
  const input = checker || {}
  if (!nonEmpty(input.id)) throw new CheckSandboxError('INVALID_CHECKER', 'checker id is required')
  const commands = Array.isArray(input.commands) ? input.commands : (input.commands ? [input.commands] : [])
  const rawResources = []
  for (const declared of [input.writeResources, input.writeManifest, input.resourceManifest, input.resources]) {
    if (Array.isArray(declared)) rawResources.push(...declared)
    else if (declared !== undefined && declared !== null) {
      throw new CheckSandboxError('INVALID_CHECK_RESOURCE_MANIFEST', 'write resource manifest must be an array')
    }
  }
  for (const command of commands) {
    if (!command || typeof command !== 'object') continue
    for (const declared of [command.writeResources, command.writeManifest, command.resourceManifest, command.resources]) {
      if (Array.isArray(declared)) rawResources.push(...declared)
      else if (declared !== undefined && declared !== null) {
        throw new CheckSandboxError('INVALID_CHECK_RESOURCE_MANIFEST', 'command write resource manifest must be an array')
      }
    }
  }
  // A declared write surface is itself proof that the check may write. Caller
  // flags such as readOnly/writeProducing=false cannot downgrade it.
  const writeProducing = input.writeProducing === true || commands.some(commandWrites) || rawResources.length > 0
  const byKey = new Map()
  for (const resource of rawResources) {
    const normalized = normalizeResource(resource)
    byKey.set(normalized.key, normalized)
  }
  let resources = [...byKey.values()].sort((a, b) => a.key.localeCompare(b.key))
  let implicitIsolation = false
  if (writeProducing && resources.length === 0) {
    const workspace = input.workspace || options.workspace
    if (!nonEmpty(workspace)) {
      throw new CheckSandboxError(
        'CHECK_WORKSPACE_REQUIRED',
        `write-producing checker ${input.id} needs a workspace for default isolated serialization`,
      )
    }
    resources = [
      normalizeResource({ kind: 'workspace', id: workspace }),
      normalizeResource({ kind: 'service', id: '__autoprompt_unknown_check_effects__' }),
    ]
    implicitIsolation = true
  }
  return Object.freeze({
    checkerId: input.id.trim(),
    writeProducing,
    resources,
    requestedIsolation: input.isolation || null,
    snapshotPath: input.snapshotPath ? path.resolve(input.snapshotPath) : null,
    implicitIsolation,
    sourceWorkspace: (resources.find((resource) => resource.kind === 'workspace') || {}).id || null,
    sourceWorkspaces: resources.filter((resource) => resource.kind === 'workspace').map((resource) => resource.id),
  })
}

function collidingResources(left, right) {
  if (!left.writeProducing || !right.writeProducing) return []
  const collisions = []
  for (const first of left.resources) {
    for (const second of right.resources) {
      const pathKinds = ['workspace', 'cache', 'generated', 'temporary']
      const physicalPaths = pathKinds.includes(first.kind) && pathKinds.includes(second.kind)
      if (first.key === second.key || (physicalPaths && pathsOverlap(first.id, second.id))) {
        collisions.push(`${first.key}<->${second.key}`)
      }
    }
  }
  return [...new Set(collisions)].sort()
}

function isolatedSchedulerResources(manifest) {
  return manifest.resources.map((resource) => ({
    id: resource.key,
    mode: 'exclusive',
    isolationId: manifest.checkerId,
  }))
}

function exclusiveSchedulerResources(manifest) {
  return manifest.resources.map((resource) => ({ id: resource.key, mode: 'exclusive' }))
}

/**
 * Plan L4 execution without claiming read-only semantics for write-producing
 * checks.  When real provider isolation exists, every checker receives a unique
 * namespace.  Otherwise overlapping manifests are placed in different batches
 * and acquire exclusive scheduler resources.
 */
function planCheckerSandboxes(checkers, options = {}) {
  if (!Array.isArray(checkers) || checkers.length === 0) {
    throw new CheckSandboxError('CHECKERS_REQUIRED', 'at least one checker is required')
  }
  let providerCapabilities
  try {
    providerCapabilities = validateProviderCapabilities(options.providerCapabilities, [])
  } catch (error) {
    throw new CheckSandboxError(error.code, error.message, error.details)
  }
  const manifests = checkers.map((checker) => normalizeWriteManifest(checker, options))
  const ids = new Set()
  for (const manifest of manifests) {
    if (ids.has(manifest.checkerId)) {
      throw new CheckSandboxError('DUPLICATE_CHECKER', `duplicate checker id: ${manifest.checkerId}`)
    }
    ids.add(manifest.checkerId)
  }

  const isolationRequested = options.isolatedChecking === true || manifests.some((manifest) =>
    manifest.implicitIsolation || manifest.requestedIsolation === 'snapshot' || manifest.snapshotPath,
  )
  if (isolationRequested && providerCapabilities.isolatedChecking !== true) {
    throw new CheckSandboxError('PROVIDER_UNSUPPORTED', 'provider does not support required isolated checking', {
      unsupported: ['isolatedChecking'],
    })
  }
  const isolatedChecking = options.isolatedChecking === true
  const assignments = manifests.map((manifest) => {
    const explicitlyIsolated = manifest.requestedIsolation === 'snapshot' || Boolean(manifest.snapshotPath)
    const isolated = manifest.writeProducing && (isolatedChecking || explicitlyIsolated || manifest.implicitIsolation)
    if (manifest.snapshotPath && manifest.sourceWorkspaces.some((workspace) => pathsOverlap(manifest.snapshotPath, workspace))) {
      throw new CheckSandboxError('SNAPSHOT_NOT_ISOLATED', 'snapshot is the same as or nested with its source workspace', {
        checkerId: manifest.checkerId,
      })
    }
    return {
      checkerId: manifest.checkerId,
      writeProducing: manifest.writeProducing,
      mode: isolated ? 'isolated' : (manifest.writeProducing ? 'exclusive' : 'read-only'),
      snapshotRequired: isolated && !manifest.snapshotPath,
      snapshotPath: manifest.snapshotPath,
      sourceWorkspace: manifest.sourceWorkspace,
      sourceWorkspaces: manifest.sourceWorkspaces,
      forceSerialized: manifest.implicitIsolation,
      resources: manifest.resources,
      schedulerResources: isolated
        ? isolatedSchedulerResources(manifest)
        : exclusiveSchedulerResources(manifest),
    }
  })
  for (let left = 0; left < assignments.length; left++) {
    for (let right = left + 1; right < assignments.length; right++) {
      if (assignments[left].snapshotPath && assignments[right].snapshotPath &&
          pathsOverlap(assignments[left].snapshotPath, assignments[right].snapshotPath)) {
        throw new CheckSandboxError('SNAPSHOT_COLLISION', 'same or nested snapshot paths cannot count as isolation', {
          checkers: [assignments[left].checkerId, assignments[right].checkerId],
        })
      }
    }
  }

  const batches = []
  // Stable greedy coloring: isolated snapshots may share a batch only when
  // their physical paths are distinct. Implicit/default isolation stays
  // serialized because the command's write surface is unknown.
  for (let index = 0; index < manifests.length; index++) {
    const manifest = manifests[index]
    const currentAssignment = assignments[index]
    let placed = false
    for (const batch of batches) {
      const collision = batch.some((checkerId) => {
        const otherIndex = manifests.findIndex((item) => item.checkerId === checkerId)
        const other = manifests[otherIndex]
        const otherAssignment = assignments[otherIndex]
        if (currentAssignment.forceSerialized || otherAssignment.forceSerialized) return true
        if (currentAssignment.mode === 'isolated' && otherAssignment.mode === 'isolated') {
          if (currentAssignment.snapshotPath && otherAssignment.snapshotPath) {
            return pathsOverlap(currentAssignment.snapshotPath, otherAssignment.snapshotPath)
          }
          return false
        }
        return collidingResources(manifest, other).length > 0
      })
      if (!collision) {
        batch.push(manifest.checkerId)
        placed = true
        break
      }
    }
    if (!placed) batches.push([manifest.checkerId])
  }

  const collisions = []
  for (let left = 0; left < manifests.length; left++) {
    for (let right = left + 1; right < manifests.length; right++) {
      const resources = collidingResources(manifests[left], manifests[right])
      if (resources.length > 0) {
        collisions.push({
          checkers: [manifests[left].checkerId, manifests[right].checkerId],
          resources,
        })
      }
    }
  }

  return Object.freeze({
    schemaVersion: 1,
    isolated: assignments.some((assignment) => assignment.mode === 'isolated'),
    providerCapabilities,
    parallel: batches.length === 1,
    batches: batches.map((batch) => Object.freeze([...batch])),
    collisions,
    assignments: assignments.map((assignment) => Object.freeze(assignment)),
  })
}

function assertSafeParallel(plan) {
  if (!plan || !Array.isArray(plan.batches)) {
    throw new CheckSandboxError('INVALID_CHECK_PLAN', 'checker sandbox plan is required')
  }
  if (plan.batches.length > 1) {
    throw new CheckSandboxError('CHECK_RESOURCE_COLLISION', 'write-producing checks must be serialized', {
      collisions: plan.collisions || [],
      batches: plan.batches,
    })
  }
  return true
}

/**
 * Materialize snapshots only through a caller-supplied provider function.  An
 * empty temp directory is not mislabeled as a clone/snapshot.
 */
function materializeCheckerSandboxes(plan, snapshotFactory) {
  if (!plan || !Array.isArray(plan.assignments)) {
    throw new CheckSandboxError('INVALID_CHECK_PLAN', 'checker sandbox plan is required')
  }
  const needsSnapshot = plan.assignments.filter((assignment) => assignment.snapshotRequired)
  if (needsSnapshot.length > 0 && typeof snapshotFactory !== 'function') {
    throw new CheckSandboxError(
      'ISOLATED_CHECKING_UNAVAILABLE',
      'provider promised isolated checking but supplied no snapshot factory',
      { checkers: needsSnapshot.map((assignment) => assignment.checkerId) },
    )
  }
  const materialized = plan.assignments.map((assignment) => {
    let snapshotPath = assignment.snapshotPath
    let projectionReceipt = assignment.projectionReceipt || null
    if (assignment.snapshotRequired) {
      const snapshot = snapshotFactory(assignment.checkerId, assignment.resources)
      if (snapshot && typeof snapshot === 'object') {
        snapshotPath = snapshot.snapshotPath
        projectionReceipt = snapshot.projectionReceipt || null
      } else {
        snapshotPath = snapshot
      }
      if (!nonEmpty(snapshotPath)) {
        throw new CheckSandboxError('SNAPSHOT_CREATION_FAILED', `snapshot factory failed for ${assignment.checkerId}`)
      }
    }
    if (assignment.mode === 'isolated') {
      if (!nonEmpty(snapshotPath)) {
        throw new CheckSandboxError('SNAPSHOT_CREATION_FAILED', `isolated checker has no snapshot: ${assignment.checkerId}`)
      }
      snapshotPath = physicalPath(snapshotPath)
      let stat
      try { stat = fs.statSync(snapshotPath) } catch {
        throw new CheckSandboxError('SNAPSHOT_CREATION_FAILED', `snapshot does not exist: ${snapshotPath}`)
      }
      if (!stat.isDirectory()) throw new CheckSandboxError('SNAPSHOT_CREATION_FAILED', 'snapshot must be a directory')
      const sourceWorkspaces = assignment.sourceWorkspaces || (assignment.sourceWorkspace ? [assignment.sourceWorkspace] : [])
      if (sourceWorkspaces.some((workspace) => pathsOverlap(snapshotPath, workspace))) {
        throw new CheckSandboxError('SNAPSHOT_NOT_ISOLATED', 'snapshot is the same as or nested with its source workspace', {
          checkerId: assignment.checkerId,
        })
      }
    }
    let schedulerResources = assignment.schedulerResources
    if (assignment.mode === 'isolated') {
      const sourceWorkspaces = assignment.sourceWorkspaces || (assignment.sourceWorkspace ? [assignment.sourceWorkspace] : [])
      schedulerResources = assignment.resources.map((resource) => {
        const pathKinds = ['workspace', 'cache', 'generated', 'temporary']
        if (!pathKinds.includes(resource.kind)) return { id: resource.key, mode: 'exclusive' }
        const source = sourceWorkspaces.find((workspace) => pathsOverlap(resource.id, workspace))
        if (!source) return { id: resource.key, mode: 'exclusive' }
        const relative = path.relative(physicalPath(source), physicalPath(resource.id))
        const mapped = path.resolve(snapshotPath, relative)
        return { id: `${resource.kind}:${mapped}`, mode: 'exclusive' }
      })
      // Even an otherwise empty manifest owns the concrete snapshot workspace.
      // This lets the central scheduler catch identical or nested snapshots
      // across checker plans launched at different times.
      schedulerResources.push({ id: `workspace:${snapshotPath}`, mode: 'exclusive' })
    }
    return { ...assignment, snapshotRequired: false, snapshotPath, projectionReceipt, schedulerResources }
  })
  const isolated = materialized.filter((assignment) => assignment.mode === 'isolated')
  for (let left = 0; left < isolated.length; left++) {
    for (let right = left + 1; right < isolated.length; right++) {
      if (pathsOverlap(isolated[left].snapshotPath, isolated[right].snapshotPath)) {
        throw new CheckSandboxError('SNAPSHOT_COLLISION', 'checker snapshots share physical identity or containment', {
          checkers: [isolated[left].checkerId, isolated[right].checkerId],
        })
      }
    }
  }
  return materialized
}

class TemporarySandboxRegistry {
  constructor(rootDirectory) {
    if (!nonEmpty(rootDirectory)) throw new CheckSandboxError('INVALID_SANDBOX_ROOT', 'temporary sandbox root is required')
    fs.mkdirSync(path.resolve(rootDirectory), { recursive: true })
    this.root = physicalPath(rootDirectory)
    this._registered = new Set()
  }

  create(checkerId) {
    if (!nonEmpty(checkerId)) throw new CheckSandboxError('INVALID_CHECKER', 'checker id is required')
    const safePrefix = checkerId.replace(/[^A-Za-z0-9_.-]/g, '-').slice(0, 48)
    const created = fs.mkdtempSync(path.join(this.root, `${safePrefix}-`))
    this._registered.add(physicalPath(created))
    return created
  }

  registered() {
    return [...this._registered].sort()
  }

  cleanup(directory) {
    const resolved = physicalPath(directory)
    const relative = path.relative(this.root, resolved)
    if (!this._registered.has(resolved) || !relative || relative.startsWith('..') || path.isAbsolute(relative)) {
      throw new CheckSandboxError('UNREGISTERED_SANDBOX', 'cleanup is limited to an exact registered sandbox')
    }
    fs.rmSync(resolved, { recursive: true, force: true })
    this._registered.delete(resolved)
    return true
  }
}

module.exports = {
  WRITE_RESOURCE_KINDS,
  CheckSandboxError,
  TemporarySandboxRegistry,
  physicalPath,
  pathsOverlap,
  normalizeWriteManifest,
  collidingResources,
  planCheckerSandboxes,
  planCheckSandboxes: planCheckerSandboxes,
  planCheckResources: planCheckerSandboxes,
  assertSafeParallel,
  materializeCheckerSandboxes,
}
