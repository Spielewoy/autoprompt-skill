'use strict'

const crypto = require('node:crypto')
const fs = require('node:fs')
const path = require('node:path')
const { execFileSync } = require('node:child_process')
const {
  CodexSupervisorRuntime,
} = require('../../agents/codex/workflow/phase-budget.js')
const {
  WorkerWorkspaceManager,
} = require('../../agents/codex/workflow/worker-workspace.js')

function readJson(filename) {
  return JSON.parse(fs.readFileSync(filename, 'utf8'))
}

function hashCandidate(repository) {
  const listing = execFileSync('git', [
    '-C', repository, 'ls-files', '-co', '--exclude-standard', '-z',
  ], { encoding: null })
  const names = listing.toString('utf8').split('\0').filter(Boolean).sort()
  const digest = crypto.createHash('sha256')
  for (const name of names) {
    const absolute = path.join(repository, ...name.split('/'))
    digest.update(Buffer.from(`${name}\0`, 'utf8'))
    if (!fs.existsSync(absolute)) {
      digest.update(Buffer.from('missing\0'))
      continue
    }
    const stat = fs.lstatSync(absolute)
    digest.update(Buffer.from(`${stat.mode & 0o777}\0${stat.size}\0`, 'utf8'))
    digest.update(fs.readFileSync(absolute))
    digest.update(Buffer.from('\0'))
  }
  return digest.digest('hex')
}

function append(config, event) {
  fs.appendFileSync(config.logFile, `${event}\n`)
}

function managerFor(config) {
  const manager = new WorkerWorkspaceManager({
    targetRoot: config.targetPath,
    privateRoot: config.privateRoot,
    environment: process.env,
    runId: config.runId,
    activationId: config.activationId,
  })
  const promote = manager.promote.bind(manager)
  manager.promote = (...args) => {
    const result = promote(...args)
    append(config, 'CAS')
    return result
  }
  const finalize = manager.finalize.bind(manager)
  manager.finalize = (...args) => {
    const result = finalize(...args)
    append(config, 'FINALIZE')
    return result
  }
  return manager
}

function runtimeFor(config, manager) {
  const runtime = Object.create(CodexSupervisorRuntime.prototype)
  runtime.deferredPromotions = new Map()
  runtime.options = {
    targetPath: config.targetPath,
    gitEnvironment: () => process.env,
    writeDeferredPromotionState(state) {
      fs.writeFileSync(config.stateFile, `${JSON.stringify(state, null, 2)}\n`)
    },
    readDeferredPromotionState() { return readJson(config.stateFile) },
    workerWorkspaceRecoveryFactory({ assignment, workItemId, recordPath }) {
      return manager.reopen({ assignment, workItemId, recordPath })
    },
    mutationEnforcer: {
      begin(input) {
        append(config, 'STATE_BEGIN')
        return { id: crypto.randomUUID(), isolationBindingHash: input.isolation.bindingHash }
      },
      commit() { append(config, 'STATE_COMMIT') },
      recoverCommit() { append(config, 'STATE_RECOVER_COMMIT') },
      abort() { append(config, 'STATE_ABORT') },
    },
  }
  return runtime
}

function acceptedJoin(candidateHash) {
  return {
    candidateHash,
    acceptanceJoinHash: 'a'.repeat(64),
    domainEvaluationHash: 'b'.repeat(64),
    checkHashes: ['c'.repeat(64)],
  }
}

async function main() {
  const config = readJson(process.argv[2])
  const phase = process.argv[3]
  const manager = managerFor(config)
  const runtime = runtimeFor(config, manager)
  if (phase === 'prepare') {
    const assignment = {
      schemaVersion: 1,
      assignmentId: 'work-1',
      resources: [{
        kind: 'file', identity: 'src/example.js', access: 'write',
        expectedPreimageHash: crypto.createHash('sha256')
          .update(fs.readFileSync(path.join(config.targetPath, 'src', 'example.js'))).digest('hex'),
      }],
    }
    const workspace = manager.prepare({ assignment, workItemId: 'work-1' })
    fs.writeFileSync(path.join(workspace.workspacePath, 'src', 'example.js'), "module.exports = 'candidate'\n")
    const admission = manager.inspect(workspace, { filesChanged: ['src/example.js'] })
    const handle = runtime._registerDeferredPromotion({
      candidateHash: hashCandidate(workspace.workspacePath),
      workspacePath: workspace.workspacePath,
      workerWorkspace: workspace,
      mutationAdmission: admission,
      mutationPermit: { id: 'prior-generation-permit', isolationBindingHash: workspace.binding.bindingHash },
      canonicalAssignment: assignment,
      workItemId: 'work-1',
    })
    append(config, 'PREPARED')
    process.stdout.write(`${handle.candidateHash}\n`)
    return
  }
  if (phase === 'physical-cas') {
    const state = readJson(config.stateFile)
    const workspace = manager.reopen({
      assignment: state.canonicalAssignment,
      workItemId: state.workItemId,
      recordPath: state.workspace.recordPath,
    })
    manager.promote(workspace, state.mutationAdmission)
    return
  }
  const handle = await runtime._restoreDeferredPromotion('work-1')
  if (phase === 'crash-after-state') {
    manager.finalize = () => {
      append(config, 'CRASH_BEFORE_FINALIZE')
      process.exit(86)
    }
  }
  await handle.commit(acceptedJoin(handle.candidateHash))
  append(config, phase === 'resume-promoted' ? 'PROMOTED_REPLAY' : 'COMMIT_RETURNED')
}

main().catch(error => {
  process.stderr.write(`${error.code || error.name}: ${error.message}\n${error.stack || ''}\n`)
  process.exitCode = 1
})
