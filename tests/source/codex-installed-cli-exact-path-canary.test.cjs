#!/usr/bin/env node
'use strict'

const assert = require('node:assert/strict')
const crypto = require('node:crypto')
const childProcess = require('node:child_process')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const test = require('node:test')

const ROOT = path.resolve(__dirname, '..', '..')
const CLI = path.join(ROOT, 'bin', 'autoprompt.cjs')
const FIXTURE = path.join(ROOT, 'tests', 'fixtures', 'codex-installed-cli')
const RELEASE = require('../../packages/codex/release.json')
const artifact = require('../../scripts/codex-artifact.cjs')
const DIRECT_TASK_FIXTURE = path.join(ROOT, 'tests', 'fixtures', 'codex-low-compute-v1', 'task')
const DIRECT_PROVIDER_FIXTURE = path.join(
  ROOT, 'tests', 'fixtures', 'codex-installed-cli', 'direct-normalize-tags-provider.cjs',
)
const INSTALL_CACHE = path.join(
  os.homedir(), '.autoprompt-installed-cli-cache', 'manifest-relative-v6',
  `${RELEASE.payloadGeneration}-${RELEASE.payloadDigest}`,
  'codex-home',
)
const activation = require('../../scripts/codex-configure.cjs')
const localSafety = require('../../scripts/local-only-safety.cjs')

function digest(file) {
  return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex')
}

function directCanaryHash(value) {
  return crypto.createHash('sha256').update(value).digest('hex')
}

function directCanaryRun(command, args, options = {}) {
  const env = { ...process.env, ...(options.env || {}) }
  delete env.NODE_TEST_CONTEXT
  const result = childProcess.spawnSync(command, args, {
    encoding: 'utf8',
    shell: false,
    timeout: 120_000,
    windowsHide: true,
    ...options,
    env,
  })
  assert.equal(result.signal, null,
    `${command} ${args.join(' ')} terminated by ${result.signal}: ${result.stderr || result.stdout}`)
  return result
}

function directCanaryProfile() {
  return [
    'sandbox_mode = "workspace-write"',
    'web_search = "disabled"',
    '',
    '[sandbox_workspace_write]',
    'network_access = false',
    '',
    '[features]',
    'apps = false',
    'enable_mcp_apps = false',
    'plugins = false',
    'remote_plugin = false',
    'browser_use = false',
    'browser_use_external = false',
    'in_app_browser = false',
    'computer_use = false',
    'image_generation = false',
    'multi_agent = false',
    'multi_agent_v2 = false',
    '',
  ].join('\n')
}

function directCanaryRouteArtifacts(routeDecision, router, requestEnvelopeHash) {
  const routeFacts = {
    schemaVersion: '2.0.0',
    requestedEffect: 'mutate',
    successCriteria: 'ready',
    dependency: {
      shape: 'bounded', dependentWorkGroupCount: 0,
      integrationOwnerRequired: false, separateDependentBodies: 0,
    },
    uncertainty: 'none',
    reversibility: 'fully-reversible',
    mutableResources: [{
      kind: 'file', identity: 'index.cjs', shared: false, ownershipMode: 'single-owner',
    }],
    sideEffects: ['deliverable-write'],
    externality: 'local-only',
    confidentiality: 'internal',
    thirdPartyImpact: 'none',
    targetAuthorization: {
      targetIdentities: [], authorizedTargetIdentities: [], authorizationEvidenceHash: null,
    },
    costAuthority: {
      mayIncurCost: false, estimatedCostMicrounits: 0, limitMicrounits: 0,
      approvalRequired: false, approvalGranted: false, approvalEvidenceHash: null,
    },
    riskAndIndependentCheckFloor: {
      level: 'ordinary', minimumCheckerCount: 2,
      namedDistinctResponsibilities: [
        'Independently run the preregistered normalizeTags focused behavior check.',
        'Independently verify that the frozen diff is restricted to index.cjs.',
      ],
    },
    checkAndBaseline: {
      checkQuality: 'authoritative', availableCheckKinds: ['focused-test'],
      baselineStatus: 'recorded', hiddenExternalCheck: false,
    },
    capturedIncidentDomains: [],
    deadlineBudget: {
      remainingSeconds: 600, admissionSeconds: 180, executionReserveSeconds: 180,
      verificationReserveSeconds: 120, recoveryAndFinalizationReserveSeconds: 60,
    },
    operatorMinimumRoute: null,
    transportCapability: { mode: 'sequential-isolated', taskCapabilityPreserved: true },
    candidateFreeze: { required: true, available: true, environmentCanBeBound: true },
    missingUserInput: [],
    architectureImpact: 'local',
    fitsLightPlan: true,
    approachNeedsShortPlanning: false,
    shortOrderUnclear: false,
  }
  const classified = router.classifyRoute(routeFacts)
  assert.equal(classified.status, 'DECIDED', JSON.stringify(classified))
  assert.equal(classified.route, 'DIRECT', JSON.stringify(classified))
  assert.equal(classified.precedence_order, 8, JSON.stringify(classified))
  assert.deepEqual(classified.reason_codes, ['PRECEDENCE_8', 'EFFECT_MUTATE'])
  assert.equal(classified.acceptance.effect, 'mutate')
  assert.equal(classified.acceptance.terminalResult, 'CHANGE_VERIFIED')
  assert.deepEqual(classified.acceptance.requiredAcceptance,
    ['the exact changed version passes its real checks'])

  const recommendation = routeDecision.createRouteRecommendation({
    preWorkResult: 'CONTINUE',
    recommendedRoute: classified.route,
    confidence: 'high',
    whatTheUserWants: ['Fix normalizeTags so the preregistered focused behavior check passes.'],
    likelyAreas: ['index.cjs'],
    howSuccessCanBeChecked: ['Run node --test test.cjs from the task root.'],
    unknowns: [],
    risks: ['Keep the diff restricted to the one owned implementation file.'],
    independentWorkItems: ['One worker owns the bounded normalizeTags fix.'],
    dependencies: [],
    reasonsForDirect: ['The baseline, one-file ownership, fix, and authoritative check are known.'],
    reasonsForLight: ['No reversible technical choice needs a short plan.'],
    reasonsForRoadmap: ['No dependent work groups or integration owner are required.'],
    userInputNeeded: [],
    evidenceIndex: [],
  })
  const recommendationValidation = routeDecision.validateRouteRecommendation(recommendation)
  assert.equal(recommendationValidation.valid, true, recommendationValidation.errors.join('\n'))
  const recommendationHash = directCanaryHash(JSON.stringify(recommendation))
  const decision = routeDecision.createRouteDecision({
    route: classified.route,
    routeFacts,
    mutableResourceOwnership: [{
      kind: 'file', identity: 'index.cjs', owner: 'worker-1', ownershipMode: 'single-owner',
    }],
    requestedResult: ['Fix normalizeTags without changing its public API or any other file.'],
    successChecklist: [
      'The focused check is recorded RED before the edit and GREEN after the edit.',
      'normalizeTags trims values, removes empty values and exact duplicates, and preserves first-seen order.',
      'The production diff contains only index.cjs.',
    ],
    checks: ['node --test test.cjs'],
    likelyAreas: ['index.cjs'],
    risksAndMissingInformation: ['Do not broaden the one-file mutation boundary.'],
    workers: {
      count: 1,
      responsibilities: ['Own the real RED/edit/GREEN normalizeTags repair.'],
      nonOverlapReason: 'One worker has exclusive ownership of the one mutable file.',
    },
    chosenRouteReasons: [
      'The installed classifier selected DIRECT for one bounded, reversible, locally checked mutation.',
    ],
    rejectedRouteReasons: {
      LIGHT: ['The recorded facts contain no unresolved reversible technical uncertainty.'],
      ROADMAP: ['No dependent work groups require an integration owner.'],
    },
    analystComparison: {
      recommendedRoute: classified.route,
      agrees: true,
      reason: 'The analyst and installed L0 classifier use the same recorded facts.',
      analystFactsFingerprint: classified.facts_fingerprint,
      analystClassifierFingerprint: classified.classifier_fingerprint,
    },
    routeChangeTrigger: {
      event: 'SPEC_MISUNDERSTOOD',
      factRequired: 'A new fact proves that the bounded behavior or one-file ownership was misunderstood.',
    },
    gateSelection: {
      baseWorkType: 'debug-fix',
      resultFormat: 'changed-files',
      artifactOverlays: ['executable-code'],
      acceptanceOverlays: ['failing-to-passing-behavior'],
      riskOverlays: [],
      riskEvidence: {},
    },
    requestEnvelopeHash,
    recommendationHash,
  })
  const decisionValidation = routeDecision.validateRouteDecision(decision)
  assert.equal(decisionValidation.valid, true, decisionValidation.errors.join('\n'))
  assert.equal(decision.routeSource, 'automatic')
  assert.equal(decision.topology.counts.routeAnalysts, 1)
  assert.equal(decision.topology.counts.workers, 1)
  assert.equal(decision.topology.counts.finalCheckers, 2)
  assert.equal(decision.independentCheckingPlan.checkerCount, 2)
  return { classified, decision, recommendation }
}

function isRegularFile(file) {
  if (!fs.existsSync(file)) return false
  const stat = fs.lstatSync(file)
  return stat.isFile() && !stat.isSymbolicLink()
}

function assertRegularDirectory(directory, label) {
  const stat = fs.lstatSync(directory)
  assert.equal(stat.isDirectory() && !stat.isSymbolicLink(), true,
    `${label} must be a regular directory, not a link or reparse target`)
}

function manifestHashIdentities(root, hashes) {
  const identities = new Map()
  for (const [key, hash] of Object.entries(hashes)) {
    if (!key || key.includes('\\') || key.includes(':') || /[\x00-\x1f]/.test(key) ||
        path.posix.isAbsolute(key) || path.win32.isAbsolute(key) ||
        !/^[a-f0-9]{64}$/.test(hash)) return null
    const segments = key.split('/')
    if (segments.some(segment => !segment || segment === '.' || segment === '..')) return null
    const target = path.resolve(root, ...segments)
    const relative = path.relative(root, target)
    if (!relative || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative) ||
        relative.split(path.sep).join('/') !== key) return null
    const identity = process.platform === 'win32' ? target.toLowerCase() : target
    if (identities.has(identity)) return null
    identities.set(identity, hash)
  }
  return identities
}

function isCurrentInstalledTemplate(root) {
  try {
    const rootStat = fs.lstatSync(root)
    if (!rootStat.isDirectory() || rootStat.isSymbolicLink()) return false
    const receiptPath = path.join(root, '.autoprompt-install-receipt.json')
    const hashesPath = path.join(root, '.autoprompt-install-hashes.json')
    const manifestPath = path.join(root, 'skills', 'autoprompt', '.autoprompt-runtime-manifest.json')
    const installedPath = path.join(root, 'skills', 'autoprompt', 'workflow', 'phase-budget.js')
    if (![receiptPath, hashesPath, manifestPath, installedPath].every(isRegularFile)) return false
    const receipt = JSON.parse(fs.readFileSync(receiptPath, 'utf8'))
    const hashes = JSON.parse(fs.readFileSync(hashesPath, 'utf8'))
    const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'))
    const hashIdentities = manifestHashIdentities(root, hashes)
    if (!hashIdentities) return false
    if (!Array.isArray(receipt.files) || typeof receipt.nonce !== 'string' || !receipt.nonce) return false
    const owned = new Set(receipt.files.map(file => path.resolve(file)))
    if (![hashesPath, manifestPath, installedPath].every(file => owned.has(path.resolve(file)))) return false
    if (manifest.payloadGeneration !== RELEASE.payloadGeneration ||
        manifest.payloadDigest !== RELEASE.payloadDigest) return false
    const identity = file => process.platform === 'win32' ? path.resolve(file).toLowerCase() : path.resolve(file)
    return hashIdentities.get(identity(manifestPath)) === digest(manifestPath) &&
      hashIdentities.get(identity(installedPath)) === digest(installedPath)
  } catch {
    return false
  }
}

function validatedInstalledTemplate() {
  assert.match(RELEASE.payloadGeneration, /^codex-v2\.0\.0-[a-f0-9]{16}$/)
  assert.match(RELEASE.payloadDigest, /^[a-f0-9]{64}$/)
  assert.equal(RELEASE.payloadGeneration.endsWith(RELEASE.payloadDigest.slice(0, 16)), true)
  assert.equal(isCurrentInstalledTemplate(INSTALL_CACHE), true,
    `the immutable v5 cache must be a current installer-owned Codex template: ${INSTALL_CACHE}`)
  return INSTALL_CACHE
}

function receiptOwnedSnapshot(root) {
  const receiptPath = path.join(root, '.autoprompt-install-receipt.json')
  const receipt = JSON.parse(fs.readFileSync(receiptPath, 'utf8'))
  assert.equal(Array.isArray(receipt.files), true)
  const files = receipt.files.map(file => path.resolve(file)).sort()
  assert.equal(new Set(files.map(file => process.platform === 'win32' ? file.toLowerCase() : file)).size,
    files.length, 'receipt ownership must not contain duplicate identities')
  return {
    receipt: digest(receiptPath),
    files: Object.fromEntries(files.map(file => [file, digest(file)])),
  }
}

function outsideReceiptSnapshot(root) {
  const receipt = JSON.parse(fs.readFileSync(
    path.join(root, '.autoprompt-install-receipt.json'), 'utf8',
  ))
  const identity = file => process.platform === 'win32'
    ? path.resolve(file).toLowerCase()
    : path.resolve(file)
  const owned = new Set(receipt.files.map(identity))
  const snapshot = {}
  const visit = directory => {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })
      .sort((left, right) => left.name.localeCompare(right.name))) {
      const file = path.join(directory, entry.name)
      const relative = path.relative(root, file).split(path.sep).join('/')
      const stat = fs.lstatSync(file)
      if (stat.isSymbolicLink()) snapshot[relative] = { target: fs.readlinkSync(file), type: 'link' }
      else if (stat.isDirectory()) {
        snapshot[relative] = { type: 'directory' }
        visit(file)
      } else if (stat.isFile() && !owned.has(identity(file))) {
        snapshot[relative] = { sha256: digest(file), size: stat.size, type: 'file' }
      } else if (!stat.isFile()) snapshot[relative] = { type: 'special' }
    }
  }
  visit(root)
  return snapshot
}

function recursiveRelativePaths(root) {
  const paths = []
  const visit = directory => {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      const file = path.join(directory, entry.name)
      paths.push(path.relative(root, file).split(path.sep).join('/'))
      if (entry.isDirectory() && !entry.isSymbolicLink()) visit(file)
    }
  }
  visit(root)
  return paths
}

function auditInstalledTemplate(root) {
  assert.equal(isCurrentInstalledTemplate(root), true,
    `the sandbox install must be current and receipt-owned: ${root}`)
  const receiptPath = path.join(root, '.autoprompt-install-receipt.json')
  const hashesPath = path.join(root, '.autoprompt-install-hashes.json')
  const markerPath = path.join(root, 'skills', 'autoprompt', '.autoprompt-runtime-manifest.json')
  const installedPath = path.join(root, 'skills', 'autoprompt', 'workflow', 'phase-budget.js')
  const receipt = JSON.parse(fs.readFileSync(receiptPath, 'utf8'))
  const hashes = JSON.parse(fs.readFileSync(hashesPath, 'utf8'))
  const marker = JSON.parse(fs.readFileSync(markerPath, 'utf8'))
  const identities = manifestHashIdentities(root, hashes)
  assert.ok(identities)
  assert.equal(Object.keys(hashes).length, 145)
  const owned = new Set(receipt.files.map(file => path.resolve(file)))
  assert.equal(receipt.files.length, 146)
  assert.equal(owned.has(path.resolve(hashesPath)), true)
  for (const [identity, expected] of identities) {
    const file = receipt.files.find(candidate => {
      const resolved = path.resolve(candidate)
      return (process.platform === 'win32' ? resolved.toLowerCase() : resolved) === identity
    })
    assert.ok(file, `hash identity must be receipt-owned: ${identity}`)
    assert.equal(digest(file), expected, `receipt-owned raw bytes must match: ${file}`)
  }
  assert.equal(marker.provider, 'codex')
  assert.equal(marker.payloadGeneration, RELEASE.payloadGeneration)
  assert.equal(marker.payloadDigest, RELEASE.payloadDigest)
  const phaseKey = 'skills/autoprompt/workflow/phase-budget.js'
  const source = path.join(ROOT, 'agents', 'codex', 'workflow', 'phase-budget.js')
  const sourceManifest = require('../../agents/manifests/codex-runtime.json')
  const rawSha256 = digest(source)
  assert.equal(sourceManifest.sha256['workflow/phase-budget.js'], rawSha256)
  assert.equal(hashes[phaseKey], rawSha256)
  assert.equal(digest(installedPath), rawSha256)
  return { installedPath, markerPath, rawSha256 }
}

function assertInstalledAuthority(root, cacheRoot) {
  if (process.platform !== 'win32') return null
  const authority = path.join(root, 'cap_sid')
  assert.equal(isRegularFile(authority), true,
    `production installer gap: supported Codex install did not author root-B authority ${authority}`)
  const cachedAuthority = path.join(cacheRoot, 'cap_sid')
  if (fs.existsSync(cachedAuthority)) {
    const installedStat = fs.statSync(authority, { bigint: true })
    const cachedStat = fs.statSync(cachedAuthority, { bigint: true })
    assert.equal(
      String(installedStat.dev) !== String(cachedStat.dev) ||
        String(installedStat.ino) !== String(cachedStat.ino),
      true,
      'root-B authority must be physically independent from cache A',
    )
  }
  const receipt = JSON.parse(fs.readFileSync(
    path.join(root, '.autoprompt-install-receipt.json'), 'utf8',
  ))
  const hashes = JSON.parse(fs.readFileSync(
    path.join(root, '.autoprompt-install-hashes.json'), 'utf8',
  ))
  const identities = manifestHashIdentities(root, hashes)
  assert.ok(identities)
  const authorityIdentity = process.platform === 'win32'
    ? path.resolve(authority).toLowerCase()
    : path.resolve(authority)
  const receiptOwned = receipt.files.some(file =>
    (process.platform === 'win32' ? path.resolve(file).toLowerCase() : path.resolve(file)) ===
      authorityIdentity)
  const expected = identities.get(authorityIdentity)
  assert.equal(receiptOwned, Boolean(expected),
    'root-B authority contract must declare receipt ownership and hash binding together')
  if (expected) assert.equal(digest(authority), expected)
  return authority
}

function closeChildStdio(child) {
  for (const stream of [child.stdin, child.stdout, child.stderr]) stream?.destroy()
}

function waitForChildClose(child, timeoutMs) {
  if (child.exitCode !== null || child.signalCode !== null) return Promise.resolve()
  return new Promise(resolve => {
    let timer
    const finish = () => {
      clearTimeout(timer)
      child.off('close', finish)
      child.off('error', finish)
      resolve()
    }
    child.once('close', finish)
    child.once('error', finish)
    timer = setTimeout(finish, timeoutMs)
  })
}

async function terminateChildTree(child) {
  if (!child.pid || child.exitCode !== null || child.signalCode !== null) {
    closeChildStdio(child)
    return
  }
  if (process.platform !== 'win32') {
    try { process.kill(-child.pid, 'SIGKILL') } catch { try { child.kill('SIGKILL') } catch {} }
  } else {
    await new Promise(resolve => {
      let settled = false
      let timer
      const killer = childProcess.spawn('taskkill.exe', [
        '/PID', String(child.pid), '/T', '/F',
      ], { shell: false, stdio: 'ignore', windowsHide: true })
      const finish = () => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        resolve()
      }
      killer.once('error', finish)
      killer.once('close', finish)
      timer = setTimeout(() => {
        try { killer.kill('SIGKILL') } catch {}
        finish()
      }, 1_500)
    })
    if (child.exitCode === null && child.signalCode === null) {
      try { child.kill('SIGKILL') } catch {}
    }
  }
  await waitForChildClose(child, 1_500)
  closeChildStdio(child)
  assert.equal(child.exitCode !== null || child.signalCode !== null, true,
    `exact spawned child tree must be stopped after timeout: pid=${child.pid}`)
}

function run(command, args, options = {}) {
  const timeoutMs = options.timeoutMs || 10_000
  const spawnOptions = { ...options }
  delete spawnOptions.timeoutMs
  return new Promise((resolve, reject) => {
    let stdout = ''
    let stderr = ''
    let timedOut = false
    const child = childProcess.spawn(command, args, {
      shell: false,
      windowsHide: true,
      detached: process.platform !== 'win32',
      stdio: ['ignore', 'pipe', 'pipe'],
      ...spawnOptions,
    })
    child.stdout.setEncoding('utf8')
    child.stderr.setEncoding('utf8')
    child.stdout.on('data', chunk => { stdout += chunk })
    child.stderr.on('data', chunk => { stderr += chunk })
    const timer = setTimeout(async () => {
      timedOut = true
      await terminateChildTree(child)
      reject(new Error(`${command} ${args.join(' ')} timed out after ${timeoutMs}ms\n${stdout}\n${stderr}`))
    }, timeoutMs)
    child.once('error', error => {
      clearTimeout(timer)
      if (timedOut) return
      closeChildStdio(child)
      reject(error)
    })
    child.once('close', (status, signal) => {
      clearTimeout(timer)
      if (timedOut) return
      closeChildStdio(child)
      try {
        assert.equal(status, 0,
          `${command} ${args.join(' ')} (${signal || 'no-signal'})\n${stdout}\n${stderr}`)
        resolve({ status, stdout, stderr })
      } catch (error) {
        reject(error)
      }
    })
  })
}

async function compileOfflineCodex(bin) {
  const executable = path.join(bin, process.platform === 'win32' ? 'codex.exe' : 'codex')
  if (process.platform !== 'win32') {
    fs.copyFileSync(process.execPath, executable)
    fs.chmodSync(executable, 0o755)
    return executable
  }
  const source = path.join(FIXTURE, 'codex-shim.cs')
  const command = [
    '$ErrorActionPreference="Stop"',
    `Add-Type -Path '${source.replace(/'/g, "''")}' -OutputAssembly '${executable.replace(/'/g, "''")}' -OutputType ConsoleApplication`,
  ].join(';')
  await run('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', command])
  return executable
}

test('installed Codex CLI rejects a transplanted cache-A receipt at root B before activation', {
  timeout: 15_000,
}, t => {
  const template = validatedInstalledTemplate()
  const cacheSnapshot = receiptOwnedSnapshot(template)
  const sandbox = fs.mkdtempSync(path.join(os.homedir(), '.autoprompt-installed-cli-transplant-'))
  t.after(() => {
    fs.rmSync(sandbox, { recursive: true, force: true })
    assert.equal(fs.existsSync(sandbox), false, 'negative transplant sandbox must leave zero residue')
  })
  const root = path.join(sandbox, 'root-b')
  const target = path.join(sandbox, 'target')
  fs.mkdirSync(root)
  fs.mkdirSync(target)
  assertRegularDirectory(root, 'negative transplant root B')
  fs.cpSync(template, root, { recursive: true, force: true })
  let childCalls = 0
  let captured = null
  try {
    activation.prepareActivation({
      env: {
        ...process.env,
        AUTOPROMPT_INSTALL_ROOT: root,
        CODEX_HOME: root,
        HOME: sandbox,
        USERPROFILE: sandbox,
      },
      missionArgs: ['transplanted receipt must fail closed'],
      spawnSync: () => { childCalls += 1; throw new Error('child boundary reached') },
      target,
      ttlSeconds: 60,
    })
  } catch (error) {
    captured = error
  }
  assert.equal(captured instanceof activation.ProviderUnsupportedError, true)
  assert.equal(captured.reason, 'managed-payload-receipt-root-mismatch')
  assert.equal(childCalls, 0, 'no child, route, model, or production boundary may run')
  assert.equal(fs.existsSync(path.join(root, '.a')), false,
    'no activation payload or private copy may be created')
  assert.deepEqual(receiptOwnedSnapshot(template), cacheSnapshot,
    'negative receipt transplant must not mutate cache A')
})

test('installed Codex live-host canary is blocked without provider-owned cap_sid before execution', {
  skip: process.platform !== 'win32',
  timeout: 15_000,
}, t => {
  const root = validatedInstalledTemplate()
  const cacheSnapshot = receiptOwnedSnapshot(root)
  const outsideSnapshot = outsideReceiptSnapshot(root)
  const audited = auditInstalledTemplate(root)
  const source = path.join(ROOT, 'agents', 'codex', 'workflow', 'phase-budget.js')
  const installed = path.join(root, 'skills', 'autoprompt', 'workflow', 'phase-budget.js')
  const manifest = require('../../agents/manifests/codex-runtime.json')
  assert.equal(digest(source), manifest.sha256['workflow/phase-budget.js'])
  assert.equal(digest(installed), digest(source))
  assert.equal(audited.rawSha256, digest(source))
  assert.equal(fs.existsSync(path.join(root, 'cap_sid')), false,
    'validated cache A must expose the provider-owned authority blocker')
  const activationTree = path.join(root, '.a')
  assert.equal(fs.existsSync(activationTree), false, 'cache A must start without activation residue')
  const sandbox = fs.mkdtempSync(path.join(os.homedir(), '.autoprompt-installed-cli-blocker-'))
  const target = path.join(sandbox, 'target')
  fs.mkdirSync(target)
  t.after(() => {
    if (fs.existsSync(activationTree)) {
      assert.equal(path.dirname(activationTree), root)
      const stat = fs.lstatSync(activationTree)
      assert.equal(stat.isDirectory() && !stat.isSymbolicLink(), true)
      fs.rmSync(activationTree, { recursive: true, force: true })
    }
    fs.rmSync(sandbox, { recursive: true, force: true })
    assert.equal(fs.existsSync(sandbox), false, 'blocker target sandbox must leave zero residue')
  })
  let spawnSyncCalls = 0
  let captured = null
  try {
    activation.launchActivation({
      env: {
        ...process.env,
        AUTOPROMPT_INSTALL_ROOT: root,
        CODEX_HOME: root,
        HOME: sandbox,
        USERPROFILE: sandbox,
      },
      missionArgs: ['path=direct', 'Review the contained local source files.'],
      spawnSync: () => {
        spawnSyncCalls += 1
        throw new Error('provider child boundary reached')
      },
      target,
      ttlSeconds: 60,
    })
  } catch (error) {
    captured = error
  }
  assert.equal(captured instanceof activation.ProviderUnsupportedError, true)
  assert.equal(captured.code, 'PROVIDER_UNSUPPORTED')
  assert.equal(captured.reason, 'codex-windows-sandbox-identity-unavailable')
  assert.equal(spawnSyncCalls, 0,
    'no route, model, L0, production, provider, or other child process may start')
  assert.equal(fs.existsSync(activationTree), false,
    'production rollback must leave no activation, payload, config, profile, enforcement, model-registry, cap_sid, runtime binding, or pointer residue')
  const remainingPaths = recursiveRelativePaths(root)
  assert.deepEqual(remainingPaths.filter(relative =>
    /(?:^|\/)runtime\/processes\.json$|(?:^|\/)request\/(?:envelope\.jsonl|objects?(?:\/|\.json))$|(?:^|\/)exact[-_.]?invocation(?:[-_.]?object)?\.json$/iu.test(relative)), [],
  'no run registry, request envelope/object, or exactInvocation artifact may exist')
  assert.deepEqual(remainingPaths.filter(relative =>
    /\.tmp-|\.autoprompt-configure-|\.autoprompt\.tmp/iu.test(relative)), [],
  'no copy or configure temporary may remain')
  assert.deepEqual(receiptOwnedSnapshot(root), cacheSnapshot,
    'live blocker must leave all cache-A receipt-owned bytes unchanged')
  assert.deepEqual(outsideReceiptSnapshot(root), outsideSnapshot,
    'live blocker must leave the complete cache-A tree outside receipt ownership unchanged')
  t.diagnostic('BLOCKER_ONLY: provider-owned cap_sid is absent; route/model/L0/production rows remain PARTIAL')
})

test('packed installed DIRECT normalizeTags RED-to-GREEN canary', {
  timeout: 180_000,
}, async t => {
  const startedAt = Date.now()
  const sandbox = fs.mkdtempSync(path.join(os.homedir(), '.autoprompt-installed-direct-canary-'))
  const packRoot = path.join(sandbox, 'pack')
  const extractRoot = path.join(sandbox, 'extracted')
  const codexRoot = path.join(sandbox, 'codex-home')
  const activationRoot = path.join(sandbox, 'activation')
  const target = path.join(sandbox, 'target')
  const scenarioPath = path.join(activationRoot, 'direct-scenario.json')
  const tracePath = path.join(activationRoot, 'provider-trace.jsonl')
  const priorEnvironment = new Map([
    'AUTOPROMPT_CANARY_SCENARIO', 'AUTOPROMPT_CANARY_TRACE', 'npm_config_offline',
  ].map(key => [key, {
    present: Object.prototype.hasOwnProperty.call(process.env, key),
    value: process.env[key],
  }]))
  let packagedCli = null
  let installed = false
  let installedGenerationRoot = null
  t.after(() => {
    fs.rmSync(sandbox, { recursive: true, force: true })
    assert.equal(fs.existsSync(sandbox), false,
      'installed DIRECT canary must remove package, install, run-record, target, and provider residue')
  })

  process.env.npm_config_offline = 'true'
  try {
    fs.mkdirSync(packRoot)
    fs.mkdirSync(extractRoot)
    fs.mkdirSync(codexRoot)
    fs.mkdirSync(activationRoot)

    // This is deliberately the first gate. A stale release record may not be
    // bypassed with source modules or a previously installed cache.
    const packed = artifact.packArtifact(packRoot, ROOT)
    assert.equal(packed.name, '@autoprompt-skill/codex-runtime')
    assert.ok(packed.packedBytes > 0)
    assert.ok(packed.packedBytes < 4 * 1024 * 1024,
      `low-compute canary package unexpectedly exceeds 4 MiB: ${packed.packedBytes}`)

    const extracted = directCanaryRun('tar', ['-xf', packed.tarball, '-C', extractRoot])
    assert.equal(extracted.status, 0, extracted.stderr || extracted.stdout)
    const packageRoot = path.join(extractRoot, 'package')
    const packageJson = JSON.parse(fs.readFileSync(path.join(packageRoot, 'package.json'), 'utf8'))
    assert.equal(packageJson.dependencies, undefined, 'packed canary must not install dependencies')
    assert.equal(packageJson.optionalDependencies, undefined, 'packed canary must not install optional dependencies')
    assert.equal(packageJson.autoprompt.provider, 'codex')
    packagedCli = path.join(packageRoot, 'bin', 'autoprompt-codex.cjs')

    const installResult = directCanaryRun(process.execPath, [packagedCli, 'install', '--root', codexRoot], {
      cwd: packageRoot,
    })
    assert.equal(installResult.status, 0, installResult.stderr || installResult.stdout)
    assert.equal(JSON.parse(installResult.stdout).action, 'install')
    installed = true
    const verifyResult = directCanaryRun(process.execPath, [packagedCli, 'verify', '--root', codexRoot], {
      cwd: packageRoot,
    })
    assert.equal(verifyResult.status, 0, verifyResult.stderr || verifyResult.stdout)
    assert.equal(JSON.parse(verifyResult.stdout).action, 'verify')

    installedGenerationRoot = path.join(
      codexRoot, '.autoprompt-private', 'bundles', packageJson.autoprompt.payloadGeneration,
    )
    const installedSkillRoot = path.join(installedGenerationRoot, 'skills', 'autoprompt')
    const installedPhasePath = path.join(installedSkillRoot, 'workflow', 'phase-budget.js')
    const installedDecisionPath = path.join(installedSkillRoot, 'workflow', 'route-decision.js')
    const installedRouterPath = path.join(installedSkillRoot, 'workflow', 'router.js')
    const installedRunRecordPath = path.join(installedSkillRoot, 'workflow', 'run-record.js')
    const installedSafeRunPath = path.join(installedSkillRoot, 'workflow', 'safe-run-root.js')
    for (const installedPath of [
      installedPhasePath, installedDecisionPath, installedRouterPath,
      installedRunRecordPath, installedSafeRunPath,
    ]) {
      assert.equal(isRegularFile(installedPath), true, `private installed runtime is missing: ${installedPath}`)
      assert.equal(path.relative(installedGenerationRoot, installedPath).startsWith('..'), false,
        `runtime escaped the generation-qualified installed bundle: ${installedPath}`)
    }
    assert.equal(
      digest(installedPhasePath),
      digest(path.join(packageRoot, 'agents', 'codex', 'workflow', 'phase-budget.js')),
      'runtime execution must use the exact packed bytes installed under the private generation',
    )

    const installedPhase = require(installedPhasePath)
    const installedDecision = require(installedDecisionPath)
    const installedRouter = require(installedRouterPath)
    const installedRunRecord = require(installedRunRecordPath)
    const installedSafeRun = require(installedSafeRunPath)
    const installedLocalSafetyPath = path.join(installedGenerationRoot, 'scripts', 'local-only-safety.cjs')
    const installedLocalSafety = require(installedLocalSafetyPath)
    if (process.platform === 'win32') installedSafeRun.ensureWindowsPrivateAcl(sandbox)

    fs.cpSync(DIRECT_TASK_FIXTURE, target, { recursive: true, force: true })
    for (const argv of [
      ['init', '-b', 'main', target],
      ['-C', target, 'config', 'user.email', 'autoprompt@example.invalid'],
      ['-C', target, 'config', 'user.name', 'Autoprompt Installed Canary'],
      ['-C', target, 'add', '--', 'index.cjs', 'test.cjs'],
      ['-C', target, 'commit', '-m', 'broken normalizeTags fixture'],
    ]) {
      const git = directCanaryRun('git', argv)
      assert.equal(git.status, 0, git.stderr || git.stdout)
    }
    const controllerBaseline = directCanaryRun(process.execPath, ['--test', 'test.cjs'], { cwd: target })
    assert.notEqual(controllerBaseline.status, 0,
      'the preregistered focused check must be genuinely RED before the installed runtime starts')

    const runId = 'apv2-installed-direct-normalize-tags'
    const record = installedRunRecord.createRunRecord({
      targetPath: target,
      canonicalProviderPrivateRoot: path.join(activationRoot, 'supervisor-runtime'),
      allowProjectMutation: true,
      readOnly: true,
      exactTree: true,
      runId,
      assertStartBoundary: false,
    })
    const profilePath = path.join(activationRoot, 'autoprompt.config.toml')
    const profile = directCanaryProfile()
    fs.writeFileSync(profilePath, profile)
    const configIsolationPath = path.join(activationRoot, 'empty.gitconfig')
    const ghConfigDir = path.join(activationRoot, 'gh-config')
    fs.writeFileSync(configIsolationPath, '')
    fs.mkdirSync(ghConfigDir)
    const enforcementProof = {
      schemaVersion: 1,
      provider: 'codex',
      profilePath,
      profileSha256: directCanaryHash(profile),
      selectedProfile: 'autoprompt',
      strictConfig: true,
    }
    const enforcementProofPath = path.join(activationRoot, 'enforcement-proof.json')
    fs.writeFileSync(enforcementProofPath, `${JSON.stringify(enforcementProof, null, 2)}\n`)
    const repaired = directCanaryRun(process.execPath, [
      installedLocalSafetyPath,
      '--repo', target,
      '--expected-branch', 'main',
      '--repair',
      '--enforcement-proof', enforcementProofPath,
      '--json',
    ])
    assert.ok([0, 3].includes(repaired.status), repaired.stderr || repaired.stdout)
    const safeChild = installedLocalSafety.createSafeChildGitEnvironment(target, process.env, {
      configIsolationPath, ghConfigDir,
    })
    const safety = installedLocalSafety.inspect(
      installedLocalSafety.discoverRepository(target), 'main', safeChild, { enforcementProof },
    )
    assert.equal(safety.mechanicallyEnforced, true, JSON.stringify(safety))

    const requestArgv = [
      'Fix normalizeTags so node --test test.cjs passes; change only index.cjs and verify the result.',
    ]
    const requestCanonicalJson = JSON.stringify({ schemaVersion: 1, argv: requestArgv })
    const requestEnvelopeHash = directCanaryHash(requestCanonicalJson)
    const routeArtifacts = directCanaryRouteArtifacts(
      installedDecision, installedRouter, requestEnvelopeHash,
    )
    fs.writeFileSync(scenarioPath, `${JSON.stringify({
      recommendation: routeArtifacts.recommendation,
      decision: routeArtifacts.decision,
    }, null, 2)}\n`)
    process.env.AUTOPROMPT_CANARY_SCENARIO = scenarioPath
    process.env.AUTOPROMPT_CANARY_TRACE = tracePath

    const metadataBytes = fs.readFileSync(record.paths.metadataPath)
    const supervisorRuntime = {
      runPath: record.runPath,
      runId,
      metadataSha256: directCanaryHash(metadataBytes),
      targetIdentity: record.targetIdentity,
    }
    const runtimeReceiptPath = path.join(activationRoot, 'supervisor-runtime-binding.json')
    fs.writeFileSync(runtimeReceiptPath, `${JSON.stringify({
      schemaVersion: 1,
      activationId: runId,
      requestSha256: requestEnvelopeHash,
      targetRealpath: target,
      capabilityGeneration: 1,
      bindingSha256: directCanaryHash(JSON.stringify(supervisorRuntime)),
      binding: supervisorRuntime,
    }, null, 2)}\n`)
    const modelSelection = {
      schemaVersion: 1,
      mode: 'provider-default',
      selector: 'provider-default',
      models: [],
      effort: null,
      castingHash: 'a'.repeat(64),
      agentDefinitionsHash: 'a'.repeat(64),
      registry: null,
      probeAcceptance: {
        strictConfig: true,
        profileAcceptedAt: new Date().toISOString(),
        explicitModelAndEffortAssignments: false,
      },
    }
    const activationReceipt = {
      activationAttestation: { hash: '1'.repeat(64) },
      activationRoot,
      enforcementProof,
      entryPrompt: `$autoprompt\nAUTOPROMPT_REQUEST_ENVELOPE_V2\nrequest_sha256=${requestEnvelopeHash}`,
      modelRegistry: null,
      modelSelection,
      profilePath,
      requestArgv,
      runId,
      supervisorRuntime,
      record: {
        target: { realpath: target },
        request: { canonicalJson: requestCanonicalJson },
        capability: {
          generation: 1,
          expiresAt: new Date(Date.now() + 10 * 60 * 1000).toISOString(),
          parentSession: 'installed-direct-canary-parent',
        },
        contractVersions: {
          settings: '2.0.0',
          requestEnvelopeEntry: '2.0.0',
          outcome: '2.0.0',
          providerCapabilities: '2.0.0',
          activationRequest: '1.0.0',
        },
        supervisorEntry: { promptSha256: '2'.repeat(64) },
        providerAttestation: {
          attestation: { activationNonce: '_Nun56FgLGR7mAQLNyqoNUrtGc7NNbCR' },
        },
        activationBoundary: {
          gitConfig: configIsolationPath,
          ghConfigDir,
          enforcementProof: { path: enforcementProofPath },
          supervisorAdapterSha256: '3'.repeat(64),
          payloadManifestSha256: digest(path.join(installedSkillRoot, '.autoprompt-runtime-manifest.json')),
        },
        supervisorRuntimeReceipt: {
          path: runtimeReceiptPath,
          sha256: digest(runtimeReceiptPath),
          capabilityGeneration: 1,
        },
        modelSelection,
      },
    }
    let monotonic = 0
    const options = installedPhase.createDefaultRuntimeOptions({
      activation: activationReceipt,
      probe: {
        supported: true,
        executable: process.execPath,
        cliVersion: 'deterministic-installed-canary 1.0.0',
        evidenceHashes: ['5'.repeat(64)],
      },
      context: {
        environment: { ...process.env },
        executableArgs: [DIRECT_PROVIDER_FIXTURE],
        expectedBranch: 'main',
        providerMaximum: 2,
        tokenLimit: 1_000,
        sessionLimit: 16,
        launchLimit: 16,
        monotonicNow: () => ++monotonic,
      },
    })
    const result = await new installedPhase.CodexSupervisorRuntime(options).start()
    assert.equal(result.outcome, 'DONE', JSON.stringify(result))
    assert.equal(result.route, 'DIRECT')
    assert.equal(result.scheduler.counters.totalLaunches, 5,
      'one analyst, one diagnostic probe, one real worker, and two independent checkers must be launched')
    assert.equal(result.scheduler.rootAccounting.status, 'completed')
    await options.processOwner.assertDrained()
    assert.equal(options.processOwner.listRecords().some(item => item.status === 'RUNNING'), false,
      'DONE must leave no provider helper process registered as running')

    const finalCheck = directCanaryRun(process.execPath, ['--test', 'test.cjs'], { cwd: target })
    assert.equal(finalCheck.status, 0, finalCheck.stderr || finalCheck.stdout)
    const changed = directCanaryRun('git', ['-C', target, 'diff', '--name-only'])
    assert.equal(changed.status, 0, changed.stderr || changed.stdout)
    assert.deepEqual(changed.stdout.trim().split(/\r?\n/u).filter(Boolean), ['index.cjs'])
    const fixedSource = fs.readFileSync(path.join(target, 'index.cjs'), 'utf8')
    assert.match(fixedSource, /new Set\(\)/u)
    assert.match(fixedSource, /seen\.has\(normalized\)/u)

    const persistedDecision = JSON.parse(fs.readFileSync(record.resolve('route/decision.json'), 'utf8'))
    assert.equal(persistedDecision.route, 'DIRECT')
    assert.equal(persistedDecision.routeSource, 'automatic')
    assert.equal(persistedDecision.routeFactsFingerprint, routeArtifacts.classified.facts_fingerprint)
    assert.equal(persistedDecision.classifierFingerprint, routeArtifacts.classified.classifier_fingerprint)
    assert.equal(persistedDecision.acceptance.terminalResult, 'CHANGE_VERIFIED')
    const joined = installedRunRecord.readAllWorkJoinedReceipt(record)
    assert.equal(joined.eventId, 'ALL_WORK_JOINED')
    assert.deepEqual(joined.verdicts.map(item => item.status), ['PASS', 'PASS'])
    assert.equal(new Set(joined.verdicts.flatMap(item => item.evidenceIds)).size, 2,
      'the two independent seats must consume distinct evidence identities')
    const terminal = JSON.parse(fs.readFileSync(record.paths.terminalPath, 'utf8'))
    assert.equal(terminal.outcome, 'DONE')
    assert.equal(terminal.terminalEnvelope.code, 'DONE')
    const stateEvents = fs.readFileSync(record.paths.eventLog.logPath, 'utf8')
    for (const eventId of ['ALL_WORK_JOINED', 'ACCEPTANCE_GREEN']) assert.match(stateEvents, new RegExp(eventId))

    const trace = fs.readFileSync(tracePath, 'utf8').trim().split(/\r?\n/u).map(JSON.parse)
    assert.equal(trace.filter(item => item.phase === 'automatic-route-analysis').length, 1)
    assert.equal(trace.filter(item => item.phase === 'automatic-route-decision').length, 1)
    const redGreen = trace.filter(item => item.phase === 'red-edit-green')
    assert.equal(redGreen.length, 1)
    assert.notEqual(redGreen[0].beforeExitCode, 0)
    assert.equal(redGreen[0].afterExitCode, 0)
    const independent = trace.filter(item => item.phase === 'independent-focused-check')
    assert.equal(independent.length, 2)
    assert.equal(independent.every(item => item.exitCode === 0), true)
    assert.equal(new Set(independent.map(item => item.logicalRole)).size, 2)
    assert.equal(new Set(independent.map(item => item.evidenceId)).size, 2)
    assert.equal(trace.every(item => item.providerArgv[0] === 'exec'), true,
      'all route/work/check calls must traverse the installed runtime Codex exec adapter')

    t.diagnostic(JSON.stringify({
      route: 'DIRECT',
      paidModelCalls: 0,
      paidTokens: 0,
      packedBytes: packed.packedBytes,
      providerProcessLaunches: trace.length,
      focusedCheckExecutions: 5,
      elapsedMs: Date.now() - startedAt,
    }))
  } finally {
    if (installed && packagedCli && fs.existsSync(codexRoot)) {
      const uninstallResult = directCanaryRun(
        process.execPath, [packagedCli, 'uninstall', '--root', codexRoot], { cwd: path.dirname(packagedCli) },
      )
      assert.equal(uninstallResult.status, 0, uninstallResult.stderr || uninstallResult.stdout)
      const removed = JSON.parse(uninstallResult.stdout)
      assert.equal(removed.action, 'uninstall')
      assert.deepEqual(removed.retained, [])
      assert.equal(fs.existsSync(path.join(codexRoot, '.autoprompt-install-receipt.json')), false)
      if (installedGenerationRoot) assert.equal(fs.existsSync(installedGenerationRoot), false)
    }
    for (const [key, prior] of priorEnvironment) {
      if (prior.present) process.env[key] = prior.value
      else delete process.env[key]
    }
  }
})
