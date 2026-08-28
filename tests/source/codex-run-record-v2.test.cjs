'use strict'

const assert = require('node:assert/strict')
const crypto = require('node:crypto')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const test = require('node:test')
const { spawn, spawnSync } = require('node:child_process')

const root = path.resolve(__dirname, '..', '..')
const workflow = path.join(root, 'agents', 'codex', 'workflow')
const safeRoot = require(path.join(workflow, 'safe-run-root.js'))
const requestEnvelope = require(path.join(workflow, 'request-envelope.js'))
const routeTranscript = require(path.join(workflow, 'route-transcript.js'))
const runRecord = require(path.join(workflow, 'run-record.js'))
const { EventLog } = require(path.join(workflow, 'event-log.js'))
const { RuntimeStateStore } = require(path.join(workflow, 'runtime-state.js'))

function fixture(t, name) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), `autoprompt-${name}-`))
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }))
  return directory
}

function gitProject(directory) {
  const project = path.join(directory, 'project')
  fs.mkdirSync(path.join(project, '.git', 'info'), { recursive: true })
  fs.writeFileSync(path.join(project, '.git', 'info', 'exclude'), '# local excludes\n')
  fs.writeFileSync(path.join(project, 'source.txt'), 'unchanged\n')
  return project
}

function treeDigest(directory) {
  const hash = crypto.createHash('sha256')
  function visit(current, relative) {
    for (const entry of fs.readdirSync(current, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      const rel = relative ? `${relative}/${entry.name}` : entry.name
      hash.update(`${entry.isDirectory() ? 'd' : entry.isSymbolicLink() ? 'l' : 'f'} ${rel}\n`)
      const filename = path.join(current, entry.name)
      if (entry.isDirectory()) visit(filename, rel)
      else if (entry.isSymbolicLink()) hash.update(fs.readlinkSync(filename))
      else hash.update(fs.readFileSync(filename))
    }
  }
  visit(directory, '')
  return hash.digest('hex')
}

function assertDraft202012Valid(schemaPath, records) {
  const script = [
    'import json, sys',
    'from jsonschema import Draft202012Validator, FormatChecker',
    "schema = json.load(open(sys.argv[1], encoding='utf-8'))",
    'records = json.load(sys.stdin)',
    'validator = Draft202012Validator(schema, format_checker=FormatChecker())',
    "errors = [error.message for record in records for error in validator.iter_errors(record)]",
    "print(json.dumps(errors)) if errors else None",
    'raise SystemExit(1 if errors else 0)',
  ].join('\n')
  const result = spawnSync('python', ['-c', script, schemaPath], {
    input: JSON.stringify(records), encoding: 'utf8', windowsHide: true,
  })
  assert.equal(result.status, 0, result.stdout || result.stderr)
}

function assertDraft202012SchemaValid(schema, records) {
  const script = [
    'import json, sys',
    'from jsonschema import Draft202012Validator, FormatChecker',
    'payload = json.load(sys.stdin)',
    "validator = Draft202012Validator(payload['schema'], format_checker=FormatChecker())",
    "errors = [error.message for record in payload['records'] for error in validator.iter_errors(record)]",
    "print(json.dumps(errors)) if errors else None",
    'raise SystemExit(1 if errors else 0)',
  ].join('\n')
  const result = spawnSync('python', ['-c', script], {
    input: JSON.stringify({ schema, records }), encoding: 'utf8', windowsHide: true,
  })
  assert.equal(result.status, 0, result.stdout || result.stderr)
}

test('sidecar selection leaves read-only and exact-tree targets completely unchanged', t => {
  const directory = fixture(t, 'sidecar-exact-tree')
  const project = gitProject(directory)
  const before = treeDigest(project)
  const record = runRecord.createRunRecord({
    targetPath: project,
    canonicalProviderPrivateRoot: path.join(directory, 'provider-private'),
    allowProjectMutation: true,
    readOnly: true,
    exactTree: true,
    runId: 'read-only-run',
  })

  assert.equal(record.rootKind, 'sidecar')
  assert.equal(treeDigest(project), before)
  assert.equal(fs.existsSync(path.join(project, '.autoprompt')), false)
  assert.ok(record.runPath.startsWith(path.join(directory, 'provider-private')))
  assert.equal(fs.existsSync(path.join(record.rootPath, safeRoot.OWNER_FILE)), true)
})

test('a hostile project symlink or junction is rejected without touching its target', t => {
  const directory = fixture(t, 'hostile-link')
  const project = gitProject(directory)
  const outside = path.join(directory, 'outside')
  fs.mkdirSync(outside)
  fs.writeFileSync(path.join(outside, 'sentinel.txt'), 'safe')
  try {
    fs.symlinkSync(outside, path.join(project, '.autoprompt'), process.platform === 'win32' ? 'junction' : 'dir')
  } catch (error) {
    if (['EPERM', 'EACCES', 'ENOSYS'].includes(error.code)) return t.skip(`links unavailable: ${error.code}`)
    throw error
  }

  const record = runRecord.createRunRecord({
    targetPath: project,
    canonicalProviderPrivateRoot: path.join(directory, 'private'),
    allowProjectMutation: true,
    runId: 'safe-fallback',
  })
  assert.equal(record.rootKind, 'sidecar')
  assert.match(record.projectRejection, /linked|junction|redirect/i)
  assert.deepEqual(fs.readdirSync(outside), ['sentinel.txt'])
  assert.equal(fs.readFileSync(path.join(outside, 'sentinel.txt'), 'utf8'), 'safe')
})

test('foreign ownership forces the one canonical sidecar and rejects caller-selected roots before target mutation', t => {
  const directory = fixture(t, 'foreign-owner')
  const project = gitProject(directory)
  const local = path.join(project, '.autoprompt')
  fs.mkdirSync(local)
  fs.writeFileSync(path.join(local, 'foreign.txt'), 'foreign bytes')
  const before = treeDigest(project)

  assert.throws(() => runRecord.createRunRecord({
    targetPath: project,
    allowProjectMutation: true,
    canonicalProviderPrivateRoot: path.join(directory, 'canonical-private'),
    providerPrivateRoot: path.join(directory, 'caller-selected-private'),
    runId: 'must-not-exist',
  }), error => error.code === 'SIDECAR_ROOT_NONCANONICAL')
  assert.equal(treeDigest(project), before)

  const record = runRecord.createRunRecord({
    targetPath: project,
    canonicalProviderPrivateRoot: path.join(directory, 'private'),
    allowProjectMutation: true,
    runId: 'foreign-fallback',
  })
  assert.equal(record.rootKind, 'sidecar')
  assert.equal(fs.readFileSync(path.join(local, 'foreign.txt'), 'utf8'), 'foreign bytes')
})

test('safe project history is owned, private, excluded locally, and atomically allocated', t => {
  const directory = fixture(t, 'project-root')
  const project = gitProject(directory)
  const options = {
    targetPath: project,
    canonicalProviderPrivateRoot: path.join(directory, 'private'),
    allowProjectMutation: true,
    providerId: 'codex',
  }
  const selection = safeRoot.selectSafeRunRoot(options)
  assert.equal(selection.kind, 'project')
  assert.match(fs.readFileSync(path.join(project, '.git', 'info', 'exclude'), 'utf8'), /^\.autoprompt\/$/m)

  const first = safeRoot.allocateRunDirectory(selection, { runId: 'collision' })
  assert.equal(fs.existsSync(first.runPath), true)
  assert.throws(() => safeRoot.allocateRunDirectory(selection, { runId: 'collision' }), error => error.code === 'RUN_ID_COLLISION')
  const second = safeRoot.allocateRunDirectory(selection, { runId: 'separate-history' })
  assert.equal(fs.existsSync(first.runPath), true)
  assert.equal(fs.existsSync(second.runPath), true)
  if (process.platform !== 'win32') {
    assert.equal(fs.statSync(selection.rootPath).mode & 0o777, 0o700)
    assert.equal(fs.statSync(selection.ownerFile).mode & 0o777, 0o600)
  } else {
    assert.equal(selection.binding.privacy.mechanism, 'windows-dacl')
  }
})

test('request envelope preserves exact ordered turns, structured blocks, objects, and replace edges', t => {
  const directory = fixture(t, 'request-envelope')
  const requestDir = path.join(directory, 'request')
  const firstText = '  Fix teh thing.\r\n\r\n```js\n x( ) ;\n```  '
  const attachment = Buffer.from([0, 1, 2, 3, 255, 10])
  requestEnvelope.createRequestEnvelope(requestDir, [{
    id: 'original',
    content: [
      { type: 'text', text: firstText, mime_type: 'text/plain; charset=utf-8' },
      { type: 'attachment', filename: 'raw.bin', mime_type: 'application/octet-stream', data: attachment },
      { type: 'application_reference', application: 'issue-tracker', uri: 'app://ticket/17', reference: { title: 'Keep  two spaces' } },
    ],
  }])
  const original = requestEnvelope.loadRequestEnvelope(requestDir)
  const originalHead = original.headEntryHash
  assert.equal(original.records[0].orderedContentBlocks[0].readableText, firstText)
  assert.ok(original.records[0].orderedContentBlocks[1].objectRef)
  const storedAttachmentBlock = JSON.parse(fs.readFileSync(path.join(requestDir, original.records[0].orderedContentBlocks[1].objectRef.storagePath.replace('request/', '')), 'utf8'))
  assert.equal(storedAttachmentBlock.data.$binary_base64, attachment.toString('base64'))

  requestEnvelope.appendRequestTurn(requestDir, {
    id: 'steering',
    operation: 'replace',
    replaces: ['original'],
    blocks: [{ type: 'text', text: 'Do NOT normalize\tthis.\n' }],
  })
  const loaded = requestEnvelope.loadRequestEnvelope(requestDir)
  assert.equal(loaded.records.length, 2)
  assert.equal(loaded.records[0].entryHash, originalHead)
  assert.equal(loaded.records[1].previousEntryHash, originalHead)
  assert.equal(loaded.records[1].operation, 'REPLACE')
  assert.deepEqual(loaded.records[1].targetMessageIds, ['original'])
  assert.equal(loaded.records[1].orderedContentBlocks[0].readableText, 'Do NOT normalize\tthis.\n')
  assert.equal(requestEnvelope.verifyRequestEnvelope(requestDir).valid, true)
  assert.equal(requestEnvelope.renderOriginalRequest(requestDir), null, 'multi-block/multi-turn request has no misleading plain-text authority')
})

test('request integrity detects altered JSONL and never treats a readable rendering as authority', t => {
  const directory = fixture(t, 'request-tamper')
  const requestDir = path.join(directory, 'request')
  requestEnvelope.createRequestEnvelope(requestDir, [{ content: 'exact request' }])
  assert.equal(requestEnvelope.renderOriginalRequest(requestDir), 'exact request')
  assert.equal(fs.readFileSync(path.join(requestDir, 'original-request.txt'), 'utf8'), 'exact request')
  fs.appendFileSync(path.join(requestDir, 'envelope.jsonl'), '{}\n')
  const verification = requestEnvelope.verifyRequestEnvelope(requestDir)
  assert.equal(verification.valid, false)
  assert.match(verification.reason, /hash chain|digest/i)
  assert.throws(() => requestEnvelope.loadRequestEnvelope(requestDir), /verification failed/i)
})

test('large route output remains complete while the evidence index and rendering truncate explicitly', t => {
  const directory = fixture(t, 'route-large')
  const routeDir = path.join(directory, 'route')
  const output = `start\n${'0123456789'.repeat(30000)}\nend`
  routeTranscript.createRouteTranscript(routeDir, { maxBytes: 650, maxTokens: 60, maxSummaryBytes: 40 })
  routeTranscript.appendRouteEvent(routeDir, { id: 'analyst-1', type: 'message', role: 'assistant', message: 'short recommendation' })
  routeTranscript.appendRouteEvent(routeDir, { id: 'tool-1', type: 'tool_result', tool: 'search', output }, { rawObjectThresholdBytes: 1024 })
  routeTranscript.appendRouteEvent(routeDir, { id: 'tool-2', type: 'tool_result', output: 'another event that exceeds the remaining evidence budget' })

  const loaded = routeTranscript.loadRouteTranscript(routeDir)
  const large = loaded.records.find(record => record.event_id === 'tool-1')
  assert.equal(large.raw_event.storage, 'object')
  const raw = routeTranscript.readRawEvent(routeDir, 'tool-1').toString('utf8')
  assert.equal(JSON.parse(raw).output, output)
  assert.equal(loaded.evidenceIndex.total_event_count, 3)
  assert.equal(loaded.evidenceIndex.included_event_count + loaded.evidenceIndex.truncation.omitted_event_count, 3)
  assert.equal(loaded.evidenceIndex.truncation.truncated, true)
  assert.match(loaded.evidenceIndex.truncation.reason, /fetch named raw events/i)
  const readable = fs.readFileSync(path.join(routeDir, 'transcript.md'), 'utf8')
  assert.match(readable, /authoritative/i)
  assert.match(readable, /not reproduced|omitted/i)
  assert.equal(routeTranscript.verifyRouteTranscript(routeDir).valid, true)
})

test('transcript integrity reports partial crashes and missing raw objects instead of silent truncation', t => {
  const directory = fixture(t, 'route-integrity')
  const routeDir = path.join(directory, 'route')
  routeTranscript.createRouteTranscript(routeDir)
  routeTranscript.appendRouteEvent(routeDir, { id: 'large', type: 'tool_result', output: 'x'.repeat(10000) }, { rawObjectThresholdBytes: 10 })
  const loaded = routeTranscript.loadRouteTranscript(routeDir)
  fs.unlinkSync(path.join(routeDir, loaded.records[0].raw_event.path))
  assert.equal(routeTranscript.verifyRouteTranscript(routeDir).valid, false)

  const other = path.join(directory, 'partial')
  routeTranscript.createRouteTranscript(other)
  fs.appendFileSync(path.join(other, 'transcript.jsonl'), '{"partial":')
  const partial = routeTranscript.verifyRouteTranscript(other)
  assert.equal(partial.valid, false)
  assert.match(partial.reason, /incomplete trailing event/i)
})

test('run record exposes only canonical registered paths and the uppercase ROADMAP authority', t => {
  const directory = fixture(t, 'schema-paths')
  const project = gitProject(directory)
  const record = runRecord.createRunRecord({
    targetPath: project,
    canonicalProviderPrivateRoot: path.join(directory, 'private'),
    exactTree: true,
    runId: 'schema-run',
    request: { content: 'make it work' },
    initializeTranscript: true,
  })
  assert.equal(record.paths.roadmap, path.join(record.runPath, 'plan', 'ROADMAP.md'))
  assert.equal(runRecord.canonicalPlanPath(record.runPath, 'roadmap'), record.paths.roadmap)
  assert.throws(() => record.resolve('plan/roadmap.md'), /only ROADMAP planning path/i)
  assert.throws(() => record.resolve('../outside.txt'), /escapes/i)
  assert.throws(() => record.write('unregistered.txt', 'no'), /not registered/i)
  assert.throws(() => record.write('metadata.json', '{}\n'), /Immutable run metadata/i)
  record.write(runRecord.PLAN_PATHS.ROADMAP, '# Canonical roadmap\n')
  record.write(runRecord.CAPTURED_DOMAIN_ADMISSION_PATH,
    '{"schemaVersion":1,"admittedBeforeWork":true}\n')
  assert.deepEqual(JSON.parse(fs.readFileSync(
    record.resolve(runRecord.CAPTURED_DOMAIN_ADMISSION_PATH), 'utf8')),
    { schemaVersion: 1, admittedBeforeWork: true })
  record.write(runRecord.CAPTURED_DOMAIN_ADMISSION_RECEIPT_PATH,
    '{"schemaVersion":1,"kind":"captured-domain-receipt"}\n')
  assert.deepEqual(JSON.parse(fs.readFileSync(
    record.resolve(runRecord.CAPTURED_DOMAIN_ADMISSION_RECEIPT_PATH), 'utf8')),
    { schemaVersion: 1, kind: 'captured-domain-receipt' })
  record.write('work/deferred-promotion.json', '{"schemaVersion":1,"status":"PREPARED"}\n')
  assert.deepEqual(JSON.parse(fs.readFileSync(record.resolve('work/deferred-promotion.json'), 'utf8')),
    { schemaVersion: 1, status: 'PREPARED' })
  record.write('checks/captured-domain-outcomes.json', '{"schemaVersion":1,"evaluation":{"valid":true}}\n')
  assert.deepEqual(JSON.parse(fs.readFileSync(record.resolve('checks/captured-domain-outcomes.json'), 'utf8')),
    { schemaVersion: 1, evaluation: { valid: true } })
  record.write(runRecord.CODEX_PHYSICAL_EXECUTION_PATH,
    '{"schemaVersion":1,"kind":"codex-physical-execution"}\n')
  assert.deepEqual(JSON.parse(fs.readFileSync(record.resolve(runRecord.CODEX_PHYSICAL_EXECUTION_PATH), 'utf8')),
    { schemaVersion: 1, kind: 'codex-physical-execution' })
  const projectionHash = 'a'.repeat(64)
  record.write(`plan/projections/${projectionHash}.json`, '{"schemaVersion":1}\n')
  assert.deepEqual(JSON.parse(fs.readFileSync(record.resolve(`plan/projections/${projectionHash}.json`), 'utf8')),
    { schemaVersion: 1 })
  assert.throws(() => record.resolve('plan/projections/not-content-addressed.json'), /not registered/i)
  assert.throws(() => record.resolve(`plan/projections/nested/${projectionHash}.json`), /not registered/i)
  assert.deepEqual(fs.readdirSync(path.join(record.runPath, 'plan')), ['ROADMAP.md', 'projections'])
  assert.equal(runRecord.openRunRecord(record.runPath).runId, 'schema-run')
})

test('a post-validation directory swap fails closed and does not write through a hostile link', t => {
  const directory = fixture(t, 'path-swap')
  const project = gitProject(directory)
  const record = runRecord.createRunRecord({
    targetPath: project,
    canonicalProviderPrivateRoot: path.join(directory, 'private'),
    exactTree: true,
    runId: 'swap-run',
  })
  const preserved = `${record.runPath}-preserved`
  const outside = path.join(directory, 'outside')
  fs.mkdirSync(outside)
  fs.renameSync(record.runPath, preserved)
  try {
    fs.symlinkSync(outside, record.runPath, process.platform === 'win32' ? 'junction' : 'dir')
  } catch (error) {
    if (['EPERM', 'EACCES', 'ENOSYS'].includes(error.code)) return t.skip(`links unavailable: ${error.code}`)
    throw error
  }
  assert.throws(() => record.write('state.json', '{}\n'), error => error.code === 'RUN_RECORD_UNSAFE')
  assert.deepEqual(fs.readdirSync(outside), [])
  fs.unlinkSync(record.runPath)
  fs.renameSync(preserved, record.runPath)
})

test('binary raw event bytes are content-addressed exactly when supplied by a provider', t => {
  const directory = fixture(t, 'raw-provider-bytes')
  const routeDir = path.join(directory, 'route')
  routeTranscript.createRouteTranscript(routeDir)
  const rawBytes = Buffer.from([0, 255, 10, 34, 92, 1])
  routeTranscript.appendRouteEvent(routeDir, { id: 'provider-event', type: 'tool_result' }, { rawBytes, mimeType: 'application/octet-stream' })
  assert.deepEqual(routeTranscript.readRawEvent(routeDir, 'provider-event'), rawBytes)
  assert.equal(routeTranscript.verifyRouteTranscript(routeDir).valid, true)
})

test('complete authoritative JSONL recovers derived digests and indexes after an interrupted update', t => {
  const directory = fixture(t, 'crash-recovery')
  const requestDir = path.join(directory, 'request')
  requestEnvelope.createRequestEnvelope(requestDir, [{ id: 'one', content: 'first' }])
  fs.writeFileSync(path.join(requestDir, 'envelope.sha256'), `${'0'.repeat(64)}\n`)
  assert.equal(requestEnvelope.verifyRequestEnvelope(requestDir).valid, false)
  assert.equal(requestEnvelope.recoverRequestEnvelope(requestDir).records[0].orderedContentBlocks[0].readableText, 'first')

  const routeDir = path.join(directory, 'route')
  routeTranscript.createRouteTranscript(routeDir, { maxBytes: 1000, maxTokens: 100, maxSummaryBytes: 50 })
  routeTranscript.appendRouteEvent(routeDir, { id: 'one', type: 'message', message: 'complete event' })
  const indexPath = path.join(routeDir, 'evidence-index.json')
  const index = JSON.parse(fs.readFileSync(indexPath, 'utf8'))
  index.total_event_count = 0
  fs.writeFileSync(indexPath, `${JSON.stringify(index)}\n`)
  fs.writeFileSync(path.join(routeDir, 'transcript.sha256'), `${'f'.repeat(64)}\n`)
  assert.equal(routeTranscript.verifyRouteTranscript(routeDir).valid, false)
  const recovered = routeTranscript.recoverRouteTranscript(routeDir)
  assert.equal(recovered.records.length, 1)
  assert.equal(recovered.evidenceIndex.total_event_count, 1)
  assert.equal(routeTranscript.verifyRouteTranscript(routeDir).valid, true)
  assert.throws(() => routeTranscript.appendRouteEvent(routeDir, { id: 'one', message: 'duplicate' }), /already present/i)
})

test('hard-linked envelope, transcript, object, and metadata files fail before outside bytes are read or mutated', t => {
  const directory = fixture(t, 'hardlinks')
  const requestDir = path.join(directory, 'request')
  requestEnvelope.createRequestEnvelope(requestDir, [{ content: 'private request' }])
  const envelopePath = path.join(requestDir, 'envelope.jsonl')
  const envelopeOutside = path.join(directory, 'outside-envelope')
  fs.linkSync(envelopePath, envelopeOutside)
  const envelopeBefore = fs.readFileSync(envelopeOutside)
  assert.throws(() => requestEnvelope.appendRequestTurn(requestDir, { content: 'must fail' }), error => error.code === 'RUN_RECORD_UNSAFE')
  assert.deepEqual(fs.readFileSync(envelopeOutside), envelopeBefore)

  const routeDir = path.join(directory, 'route')
  routeTranscript.createRouteTranscript(routeDir)
  routeTranscript.appendRouteEvent(routeDir, { id: 'first', message: 'private route event' })
  const transcriptPath = path.join(routeDir, 'transcript.jsonl')
  const transcriptOutside = path.join(directory, 'outside-transcript')
  fs.linkSync(transcriptPath, transcriptOutside)
  const transcriptBefore = fs.readFileSync(transcriptOutside)
  assert.throws(() => routeTranscript.appendRouteEvent(routeDir, { id: 'second', message: 'must fail' }), error => error.code === 'RUN_RECORD_UNSAFE')
  assert.deepEqual(fs.readFileSync(transcriptOutside), transcriptBefore)

  const objectRequestDir = path.join(directory, 'object-request')
  requestEnvelope.createRequestEnvelope(objectRequestDir, [{ content: { type: 'structured', payload: 'x'.repeat(2000) } }], { objectThresholdBytes: 1 })
  const objectLoaded = requestEnvelope.loadRequestEnvelope(objectRequestDir)
  const objectPath = path.join(objectRequestDir, objectLoaded.records[0].orderedContentBlocks[0].objectRef.storagePath.replace('request/', ''))
  const objectOutside = path.join(directory, 'outside-object')
  fs.linkSync(objectPath, objectOutside)
  const objectBefore = fs.readFileSync(objectOutside)
  assert.throws(() => requestEnvelope.loadRequestEnvelope(objectRequestDir), error => error.code === 'RUN_RECORD_UNSAFE' || error.code === 'RUN_RECORD_FAILURE')
  assert.deepEqual(fs.readFileSync(objectOutside), objectBefore)

  const project = gitProject(path.join(directory, 'record-fixture'))
  const record = runRecord.createRunRecord({
    targetPath: project,
    canonicalProviderPrivateRoot: path.join(directory, 'private'),
    exactTree: true,
    runId: 'hardlink-run',
  })
  const metadataOutside = path.join(directory, 'outside-metadata')
  fs.linkSync(record.paths.metadataPath, metadataOutside)
  assert.throws(() => runRecord.openRunRecord(record.runPath), error => error.code === 'RUN_RECORD_UNSAFE' || error.code === 'RUN_RECORD_FAILURE')
})

test('canonical sidecar is a target singleton, outside the target, and caller-selected alternatives are rejected', t => {
  const directory = fixture(t, 'canonical-sidecar')
  const project = gitProject(directory)
  const canonical = path.join(directory, 'provider-owned')
  const first = runRecord.createRunRecord({ targetPath: project, canonicalProviderPrivateRoot: canonical, exactTree: true, runId: 'singleton-one' })
  const second = runRecord.createRunRecord({ targetPath: project, canonicalProviderPrivateRoot: canonical, exactTree: true, runId: 'singleton-two' })
  assert.equal(first.rootPath, second.rootPath)
  assert.equal(path.relative(project, first.rootPath).startsWith('..'), true)
  assert.throws(() => runRecord.createRunRecord({
    targetPath: project,
    canonicalProviderPrivateRoot: canonical,
    providerPrivateRoot: path.join(directory, 'alternative'),
    exactTree: true,
    runId: 'singleton-three',
  }), error => error.code === 'SIDECAR_ROOT_NONCANONICAL')
  assert.throws(() => runRecord.createRunRecord({
    targetPath: project,
    canonicalProviderPrivateRoot: path.join(project, '.provider-private'),
    exactTree: true,
    runId: 'inside-target',
  }), error => error.code === 'RUN_RECORD_UNSAFE' && /outside the target/i.test(error.message))
})

test('npm pack and explicit package/archive boundaries contain zero private run files', t => {
  const directory = fixture(t, 'package-boundary')
  const project = gitProject(directory)
  fs.writeFileSync(path.join(project, 'package.json'), JSON.stringify({ name: 'run-record-pack-fixture', version: '1.0.0', files: ['**/*'] }))
  fs.writeFileSync(path.join(project, 'index.js'), 'module.exports = 1\n')
  const before = treeDigest(project)
  const record = runRecord.createRunRecord({
    targetPath: project,
    canonicalProviderPrivateRoot: path.join(directory, 'private'),
    allowProjectMutation: true,
    runId: 'package-run',
  })
  assert.equal(record.rootKind, 'sidecar')
  const result = record.assertBoundary({ phase: 'completion', runNpmPack: true, npmCache: path.join(directory, 'npm-cache') })
  assert.equal(result.pack.checked, true)
  assert.equal(result.pack.files.some(file => file.path.includes('.autoprompt')), false)
  assert.equal(treeDigest(project), before)
  assert.throws(() => record.assertBoundary({ packageFiles: [{ path: '.autoprompt/runs/private/request/envelope.jsonl' }], runNpmPack: false }), error => error.code === 'RUN_RECORD_UNSAFE')
})

test('stale append locks have owned evidence and only one bounded safe recovery', t => {
  const directory = fixture(t, 'stale-lock')
  const requestDir = path.join(directory, 'request')
  requestEnvelope.createRequestEnvelope(requestDir, [{ id: 'initial-message', content: 'first' }])
  fs.writeFileSync(path.join(requestDir, '.envelope.lock'), `${JSON.stringify({
    schema: 'autoprompt.private-lock.v2', pid: 2147483647, hostname: os.hostname(),
    createdAt: '2000-01-01T00:00:00.000Z', processStartedAt: '2000-01-01T00:00:00.000Z', ownerToken: 'stale-owner',
  })}\n`)
  requestEnvelope.appendRequestTurn(requestDir, { id: 'after-stale', content: 'second' }, { staleLockMs: 0 })
  assert.equal(fs.existsSync(path.join(requestDir, '.envelope.lock')), false)
  const evidence = fs.readdirSync(path.join(requestDir, 'recovered-locks'))
  assert.equal(evidence.length, 1)
  assert.match(evidence[0], /^[a-f0-9]{64}\.json$/)

  fs.writeFileSync(path.join(requestDir, '.envelope.lock'), '{not-json')
  assert.throws(() => requestEnvelope.appendRequestTurn(requestDir, { id: 'blocked', content: 'third' }, { staleLockMs: 0 }), error => error.code === 'RUN_RECORD_RECOVERY_REQUIRED')
})

test('directory writer lock is mutually exclusive and crash-recoverable at every publication boundary', async t => {
  const directory = fixture(t, 'lock-publication')
  const recoveryDirectory = path.join(directory, 'recovered-locks')
  const lockPath = path.join(directory, '.writer.lock')
  const modulePath = path.join(workflow, 'safe-run-root.js')
  const crashScript = [
    "const { withOwnedLock } = require(process.argv[1])",
    'const hook = process.argv[3]',
    'withOwnedLock(process.argv[2], () => process.exit(97), { [hook]: () => process.exit(73) })',
  ].join(';')
  const recoveredAt = new Date(Date.now() + 60000)

  for (const hook of ['afterLockDirectoryCreate', 'beforeLockPublish', 'afterLockPublish']) {
    const crashed = spawnSync(process.execPath, ['-e', crashScript, modulePath, lockPath, hook], {
      windowsHide: true,
      encoding: 'utf8',
    })
    assert.equal(crashed.status, 73, `${hook}: ${crashed.stderr}`)
    assert.equal(fs.lstatSync(lockPath).isDirectory(), true)
    const acquired = safeRoot.withOwnedLock(lockPath, ({ recovered }) => recovered, {
      staleAfterMs: 0,
      now: recoveredAt,
      recoveryDirectory,
    })
    assert.equal(acquired, true)
    assert.equal(fs.existsSync(lockPath), false)
  }
  assert.equal(fs.readdirSync(recoveryDirectory).length, 3)

  const readyPath = path.join(directory, 'publication-ready')
  const barrierScript = [
    "const fs = require('node:fs')",
    "const { withOwnedLock } = require(process.argv[1])",
    "withOwnedLock(process.argv[2], () => {}, { afterLockDirectoryCreate: () => { fs.writeFileSync(process.argv[3], 'ready'); Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 750) } })",
  ].join(';')
  const publisher = spawn(process.execPath, ['-e', barrierScript, modulePath, lockPath, readyPath], {
    windowsHide: true,
    stdio: ['ignore', 'ignore', 'pipe'],
  })
  let publisherError = ''
  publisher.stderr.on('data', chunk => { publisherError += chunk })
  for (let attempt = 0; attempt < 100 && !fs.existsSync(readyPath); attempt += 1) {
    await new Promise(resolve => setTimeout(resolve, 10))
  }
  assert.equal(fs.existsSync(readyPath), true)
  assert.throws(
    () => safeRoot.withOwnedLock(lockPath, () => {}, { staleAfterMs: 60000, recoveryDirectory }),
    (error) => error.code === 'RUN_RECORD_BUSY',
  )
  const publisherExit = await new Promise((resolve, reject) => {
    publisher.once('error', reject)
    publisher.once('exit', code => resolve(code))
  })
  assert.equal(publisherExit, 0, publisherError)
  assert.equal(fs.existsSync(lockPath), false)

  fs.mkdirSync(lockPath)
  fs.writeFileSync(path.join(lockPath, `.owner.999.${'a'.repeat(32)}.tmp`), '{partial-owner')
  assert.throws(
    () => safeRoot.withOwnedLock(lockPath, () => {}, { staleAfterMs: 60000, recoveryDirectory }),
    (error) => error.code === 'RUN_RECORD_BUSY',
  )
  assert.equal(safeRoot.withOwnedLock(lockPath, ({ recovered }) => recovered, {
    staleAfterMs: 0,
    now: recoveredAt,
    recoveryDirectory,
  }), true)

  fs.mkdirSync(lockPath)
  assert.throws(
    () => safeRoot.withOwnedLock(lockPath, () => {}, { staleAfterMs: 60000, recoveryDirectory }),
    (error) => error.code === 'RUN_RECORD_BUSY',
  )
  fs.rmdirSync(lockPath)

  fs.mkdirSync(lockPath)
  fs.writeFileSync(path.join(lockPath, 'owner.json'), '{not-json')
  assert.throws(
    () => safeRoot.withOwnedLock(lockPath, () => {}, { staleAfterMs: 0, now: recoveredAt, recoveryDirectory }),
    (error) => error.code === 'RUN_RECORD_RECOVERY_REQUIRED',
  )
  fs.rmSync(lockPath, { recursive: true })

  fs.mkdirSync(lockPath)
  const hostile = path.join(directory, 'hostile-owner.json')
  fs.writeFileSync(hostile, '{}')
  fs.linkSync(hostile, path.join(lockPath, 'owner.json'))
  assert.throws(
    () => safeRoot.withOwnedLock(lockPath, () => {}, { staleAfterMs: 0, now: recoveredAt, recoveryDirectory }),
    (error) => error.code === 'RUN_RECORD_UNSAFE',
  )
})

test('deleted Windows lock realpath race is disappearance-only and retries once without residue', t => {
  const directory = fixture(t, 'deleted-lock-realpath')
  const candidate = path.join(directory, '.writer.lock')
  fs.mkdirSync(candidate)
  const actualStats = fs.lstatSync(candidate)
  let candidateLstats = 0
  const deletedObjectFs = Object.create(fs)
  deletedObjectFs.lstatSync = (filename) => {
    if (path.resolve(filename) !== path.resolve(candidate)) return fs.lstatSync(filename)
    candidateLstats += 1
    if (candidateLstats === 1) return actualStats
    const error = new Error('winner removed lock')
    error.code = 'ENOENT'
    throw error
  }
  deletedObjectFs.realpathSync = Object.assign(
    filename => fs.realpathSync(filename),
    { native: () => 'C:\\$Extend\\$Deleted\\0000000000000001' },
  )
  assert.deepEqual(
    safeRoot.inspectPathNoFollow(candidate, { fsImpl: deletedObjectFs }),
    { exists: false, path: path.resolve(candidate), nearestExisting: path.dirname(candidate), nearestIdentity: safeRoot.inspectPathNoFollow(path.dirname(candidate)).identity },
  )
  assert.equal(candidateLstats, 2, 'a mismatched realpath is accepted only after the name is rechecked as absent')

  const redirectedFs = Object.create(fs)
  redirectedFs.realpathSync = Object.assign(
    filename => fs.realpathSync(filename),
    { native: () => path.join(directory, 'foreign-redirect') },
  )
  assert.throws(
    () => safeRoot.inspectPathNoFollow(candidate, { fsImpl: redirectedFs }),
    error => error.code === 'RUN_RECORD_UNSAFE' && /redirect/i.test(error.message),
  )

  let contentionChecks = 0
  assert.equal(safeRoot.withOwnedLock(candidate, () => 'acquired', {
    afterContendedLockLstat: () => {
      contentionChecks += 1
      fs.rmdirSync(candidate)
    },
  }), 'acquired')
  assert.equal(contentionChecks, 1)
  assert.equal(fs.existsSync(candidate), false)
})

test('partial JSONL tails require explicit recovery, retain exact evidence, and preserve every complete prefix', t => {
  const directory = fixture(t, 'partial-tail')
  const requestDir = path.join(directory, 'request')
  requestEnvelope.createRequestEnvelope(requestDir, [{ content: 'complete request' }])
  const requestCount = requestEnvelope.loadRequestEnvelope(requestDir).entries.length
  fs.appendFileSync(path.join(requestDir, 'envelope.jsonl'), '{"provably":"incomplete"')
  assert.throws(() => requestEnvelope.recoverRequestEnvelope(requestDir), error => error.code === 'RUN_RECORD_RECOVERY_REQUIRED')
  const recoveredRequest = requestEnvelope.recoverRequestEnvelope(requestDir, { truncateIncompleteTail: true })
  assert.equal(recoveredRequest.entries.length, requestCount)
  assert.equal(fs.readdirSync(path.join(requestDir, 'recovery', 'incomplete-envelope-tail')).length, 1)

  const routeDir = path.join(directory, 'route')
  routeTranscript.createRouteTranscript(routeDir)
  routeTranscript.appendRouteEvent(routeDir, { id: 'complete-event', message: 'complete' })
  fs.appendFileSync(path.join(routeDir, 'transcript.jsonl'), '{"provably":"incomplete"')
  assert.throws(() => routeTranscript.recoverRouteTranscript(routeDir), error => error.code === 'RUN_RECORD_RECOVERY_REQUIRED')
  const recoveredRoute = routeTranscript.recoverRouteTranscript(routeDir, { truncateIncompleteTail: true })
  assert.equal(recoveredRoute.records.length, 1)
  assert.equal(fs.readdirSync(path.join(routeDir, 'recovery', 'incomplete-transcript-tail')).length, 1)

  const completeNoNewline = path.join(directory, 'complete-no-newline')
  requestEnvelope.createRequestEnvelope(completeNoNewline, [{ content: 'complete but missing final newline after crash' }])
  const completeBytes = fs.readFileSync(path.join(completeNoNewline, 'envelope.jsonl'))
  fs.writeFileSync(path.join(completeNoNewline, 'envelope.jsonl'), completeBytes.subarray(0, completeBytes.length - 1))
  const completed = requestEnvelope.recoverRequestEnvelope(completeNoNewline)
  assert.equal(completed.records[0].orderedContentBlocks[0].readableText, 'complete but missing final newline after crash')
  assert.equal(fs.readFileSync(path.join(completeNoNewline, 'envelope.jsonl')).at(-1), 0x0a)
})

test('open audits the exact tree, runtime integration paths, aliases, hard links, and unsafe residue', t => {
  const directory = fixture(t, 'tree-audit')
  const project = gitProject(directory)
  const make = runId => runRecord.createRunRecord({
    targetPath: project, canonicalProviderPrivateRoot: path.join(directory, 'private'), exactTree: true,
    runId, request: { content: 'request' },
  })
  const aligned = make('audit-aligned')
  assert.equal(fs.existsSync(aligned.paths.stateStore.paths.statePath), false, 'run-record metadata must not preempt RuntimeStateStore')
  const binding = {
    runId: aligned.runId,
    requestEnvelopeHash: aligned.loadRequest().digest,
    targetIdentity: aligned.targetIdentity,
    openedDirectoryIdentity: JSON.stringify(aligned.runBinding.identity),
    digests: { contract: 'contract-v2', prompt: 'prompt-v2', provider: 'codex-v2', tool: 'tools-v2' },
  }
  const runtimeCapability = Object.freeze({ type: 'run-record-integration-test' })
  const eventLog = new EventLog({ ...aligned.paths.eventLog, binding })
  const capabilityBinding = {
    runId: aligned.runId,
    activationId: 'activation-audit',
    missionHash: 'a'.repeat(64),
    nonce: 'nonce_1234567890123456',
    generation: 1,
    targetIdentity: aligned.targetIdentity,
  }
  const stateStore = new RuntimeStateStore({
    ...aligned.paths.stateStore,
    eventLog,
    capabilityVerifier: candidate => candidate === runtimeCapability ? capabilityBinding : null,
  })
  stateStore.create({
    ...binding,
    capability: runtimeCapability,
    activation: {
      id: 'activation-audit', nonce: 'nonce_1234567890123456', missionHash: 'a'.repeat(64),
      sessionToken: 'session-audit', generation: 1,
    },
  })
  assert.equal(aligned.paths.processRegistry, path.join(aligned.runPath, 'runtime', 'processes.json'))
  assert.equal(aligned.paths.processControl, path.join(aligned.runPath, 'runtime', 'process-control'))
  assert.deepEqual(aligned.paths.accounting, {
    runRecordRoot: aligned.runPath,
    logPath: path.join(aligned.runPath, 'runtime', 'accounting.jsonl'),
    snapshotPath: path.join(aligned.runPath, 'runtime', 'budget.json'),
  })
  assert.deepEqual(aligned.paths.recoveryCheckpoints, {
    runRecordRoot: aligned.runPath,
    logPath: path.join(aligned.runPath, 'runtime', 'recovery-checkpoints.jsonl'),
    snapshotPath: path.join(aligned.runPath, 'runtime', 'recovery-checkpoint.json'),
  })
  fs.writeFileSync(aligned.paths.processRegistry, '{}\n', { mode: 0o600 })
  fs.writeFileSync(aligned.paths.accounting.logPath, '', { mode: 0o600 })
  fs.writeFileSync(aligned.paths.accounting.snapshotPath, '{}\n', { mode: 0o600 })
  fs.writeFileSync(aligned.paths.recoveryCheckpoints.logPath, '', { mode: 0o600 })
  fs.writeFileSync(aligned.paths.recoveryCheckpoints.snapshotPath, '{}\n', { mode: 0o600 })
  const processReservation = path.join(aligned.paths.processControl, 'reservation-1')
  fs.mkdirSync(processReservation, { mode: 0o700 })
  fs.writeFileSync(path.join(processReservation, 'status.json'), '{}\n', { mode: 0o600 })
  fs.writeFileSync(aligned.paths.terminalPath, '{}\n', { mode: 0o600 })
  fs.writeFileSync(aligned.paths.cleanupRegistry.registryPath, '{}\n', { mode: 0o600 })
  assert.equal(runRecord.openRunRecord(aligned.runPath).auditTree().valid, true)

  const foreign = make('audit-foreign')
  fs.writeFileSync(path.join(foreign.runPath, 'foreign.txt'), 'no', { mode: 0o600 })
  assert.throws(() => runRecord.openRunRecord(foreign.runPath), /Unregistered run-record file/i)

  const alias = make('audit-alias')
  fs.writeFileSync(path.join(alias.runPath, 'plan', 'roadmap.md'), 'wrong case', { mode: 0o600 })
  assert.throws(() => runRecord.openRunRecord(alias.runPath), /only ROADMAP|Unregistered/i)

  const residue = make('audit-residue')
  fs.writeFileSync(path.join(residue.runPath, 'runtime', '.state.json.123.tmp'), 'partial', { mode: 0o600 })
  assert.throws(() => runRecord.openRunRecord(residue.runPath), error => error.code === 'RUN_RECORD_RECOVERY_REQUIRED' || error.code === 'RUN_RECORD_UNSAFE')
})

test('canonical alias telemetry is registered, append-only, mapping-bound, and monotonic per activation generation', t => {
  const directory = fixture(t, 'alias-telemetry')
  const project = gitProject(directory)
  const record = runRecord.createRunRecord({
    targetPath: project,
    canonicalProviderPrivateRoot: path.join(directory, 'private'),
    exactTree: true,
    runId: 'alias-telemetry-run',
  })
  const roles = require(path.join(root, 'agents', 'contracts', 'roles.json'))
  const alias = roles.compatibilityAliases.find((entry) => entry.legacyId === 'ap-verifier')
  const canonicalRole = roles.roles.find((entry) => entry.id === alias.logicalId)
  const input = {
    activationId: 'activation-alias-001',
    generation: 1,
    legacyId: alias.legacyId,
    logicalId: alias.logicalId,
    physicalId: canonicalRole.physicalId,
  }
  assert.equal(record.paths.aliasTelemetry, path.join(record.runPath, 'compatibility', 'alias-telemetry.jsonl'))
  const first = record.appendAliasTelemetry(input, { clock: () => '2026-08-22T00:00:00.000Z' })
  const second = record.appendAliasTelemetry(input, { clock: () => '2026-08-22T00:00:01.000Z' })
  const resumed = record.appendAliasTelemetry({ ...input, generation: 2 }, { clock: () => '2026-08-22T00:00:02.000Z' })
  assert.equal(first.aliasUseCount, 1)
  assert.equal(second.aliasUseCount, 2)
  assert.equal(resumed.aliasUseCount, 1)
  assert.equal(first.runId, record.runId)
  assert.equal(first.legacyReadVersion, roles.aliasTelemetrySchema.legacyReadVersion)
  assert.equal(first.canonicalWriteVersion, roles.aliasTelemetrySchema.canonicalWriteVersion)
  assert.equal(first.previousHash, null)
  assert.equal(second.previousHash, first.entryHash)
  assert.equal(resumed.previousHash, second.entryHash)
  assert.equal(first.entryHash, runRecord.aliasEntryHash(first))
  const rows = record.readAliasTelemetry()
  assert.equal(rows.length, 3)
  assertDraft202012SchemaValid(roles.aliasTelemetrySchema.recordSchema, rows)
  assert.deepEqual(runRecord.openRunRecord(record.runPath).readAliasTelemetry(), rows)
  assert.equal(record.auditTree().valid, true)
  assert.throws(() => record.write(runRecord.RUNTIME_PATHS.aliasTelemetry, 'overwrite\n'), error => error.code === 'RUN_RECORD_UNSAFE')
  assert.throws(() => record.appendAliasTelemetry({ ...input, physicalId: 'autoprompt.v2.worker' }), error => error.code === 'RUN_RECORD_FAILURE')
  assert.throws(() => record.appendAliasTelemetry({ ...input, aliasUseCount: 99 }), error => error.code === 'RUN_RECORD_FAILURE')
  assert.throws(() => record.appendAliasTelemetry({ ...input, runId: 'foreign-run' }), error => error.code === 'RUN_RECORD_UNSAFE')

  const telemetryBytes = fs.readFileSync(record.paths.aliasTelemetry)
  const parsedRows = rows.map((row) => ({ ...row }))
  for (const mutate of [
    (items) => { items[0].occurredAt = '2027-01-01T00:00:00.000Z' },
    (items) => { items[0].legacyId = 'ap-worker' },
    (items) => { items[1].aliasUseCount = 99 },
    (items) => { items[1].previousHash = '0'.repeat(64) },
    (items) => { items[0].entryHash = 'f'.repeat(64) },
  ]) {
    const changed = parsedRows.map((row) => ({ ...row }))
    mutate(changed)
    fs.writeFileSync(record.paths.aliasTelemetry, `${changed.map((row) => JSON.stringify(row)).join('\n')}\n`)
    assert.throws(() => record.readAliasTelemetry(), error => error.code === 'RUN_RECORD_FAILURE')
  }
  fs.writeFileSync(record.paths.aliasTelemetry, telemetryBytes)
  fs.appendFileSync(record.paths.aliasTelemetry, `${JSON.stringify(parsedRows[0])}\n`)
  assert.throws(() => record.readAliasTelemetry(), error => error.code === 'RUN_RECORD_FAILURE')
  fs.writeFileSync(record.paths.aliasTelemetry, telemetryBytes)

  fs.appendFileSync(record.paths.aliasTelemetry, '{"unterminated":')
  assert.throws(() => record.readAliasTelemetry(), error => error.code === 'RUN_RECORD_RECOVERY_REQUIRED')
  assert.throws(() => record.recoverAliasTelemetry(), error =>
    error.code === 'RUN_RECORD_RECOVERY_REQUIRED' && fs.existsSync(error.details.evidencePath))
  const recovered = record.recoverAliasTelemetry({ truncateIncompleteTail: true })
  assert.deepEqual(recovered, rows)
  assert.equal(record.auditTree().valid, true)
})

test('request entries conform to v2 names, preserve structured metadata, and verify historical pointers', t => {
  const directory = fixture(t, 'schema-history')
  const requestDir = path.join(directory, 'request')
  const structured = { type: 'structured', content: { z: 1, nested: ['  exact  ', false] }, metadata: { custom: 'kept', count: 2 } }
  requestEnvelope.createRequestEnvelope(requestDir, [{ id: 'initial-message', blocks: [structured] }], { runId: 'schema-history' })
  const first = requestEnvelope.loadRequestEnvelope(requestDir)
  const firstPointer = first.versionPointer
  const decoded = JSON.parse(Buffer.from(first.records[0].orderedContentBlocks[0].exactBytesBase64, 'base64').toString('utf8'))
  assert.deepEqual(decoded, structured)
  const header = first.entries[0]
  assert.equal(header.exactInvocationObject.purpose, 'exact-invocation')
  assert.equal(header.exactInvocationObject.derivedFromSha256, null)
  assert.equal(header.exactInvocationObject.bindingRef, `exact-invocation:${header.exactInvocationObject.sha256}`)
  assert.deepEqual(header.exactInvocationObject.derivation, {
    method: 'captured-exact-bytes', sourceRole: null, sourceSha256: null,
  })
  assert.equal(header.parsedControlsObject.purpose, 'parsed-controls')
  assert.equal(header.parsedControlsObject.derivedFromSha256, header.exactInvocationObject.sha256)
  assert.equal(header.parsedControlsObject.bindingRef, `parsed-controls:${header.parsedControlsObject.sha256}`)
  assert.equal(header.canonicalRequestObject.purpose, 'canonical-request')
  assert.equal(header.canonicalRequestObject.derivedFromSha256, header.exactInvocationObject.sha256)
  assert.equal(header.canonicalRequestObject.bindingRef, `canonical-request:${header.canonicalRequestObject.sha256}`)
  assert.equal(new Set([
    header.exactInvocationObject.objectId,
    header.parsedControlsObject.objectId,
    header.canonicalRequestObject.objectId,
  ]).size, 3)
  assertDraft202012Valid(
    path.join(root, 'agents', 'contracts', 'schemas', 'request-envelope-entry.schema.json'),
    first.entries,
  )
  for (const entry of first.entries) {
    assert.equal(entry.schemaVersion, '2.0.0')
    assert.equal(typeof entry.entryHash, 'string')
    assert.equal('record_sha256' in entry, false)
  }
  requestEnvelope.appendRequestTurn(requestDir, { id: 'later-steering', content: 'later' })
  const current = requestEnvelope.loadRequestEnvelope(requestDir)
  assert.notEqual(current.versionPointer.envelopeHash, firstPointer.envelopeHash)
  const historical = requestEnvelope.loadRequestEnvelope(requestDir, { expectedPointer: firstPointer })
  assert.equal(historical.versionPointer.envelopeHash, firstPointer.envelopeHash)
  assert.equal(historical.versionPointer.headEntryHash, firstPointer.headEntryHash)
  assert.equal(historical.versionPointer.blockSetHash, firstPointer.blockSetHash)
  assert.throws(() => requestEnvelope.loadRequestEnvelope(requestDir, { expectedHash: '0'.repeat(64) }), error => error.code === 'REQUEST_VERSION_MISMATCH')
})

test('role APIs distinguish exact request access from bounded route evidence and index maxBytes includes framing', t => {
  const directory = fixture(t, 'role-access')
  const project = gitProject(directory)
  const record = runRecord.createRunRecord({
    targetPath: project, canonicalProviderPrivateRoot: path.join(directory, 'private'), exactTree: true,
    runId: 'role-access', request: { content: 'exact request' },
  })
  record.initializeRouteTranscript({ maxBytes: 900, maxTokens: 100, maxSummaryBytes: 30 })
  record.appendRouteEvent({ id: 'large-evidence', type: 'tool_result', output: 'x'.repeat(5000) }, { rawObjectThresholdBytes: 10 })
  assert.equal(record.loadRequestFor('L1').access, 'full-raw')
  assert.equal(record.loadRequestFor('L4').records[0].orderedContentBlocks[0].readableText, 'exact request')
  assert.equal(record.loadRouteFor('L0').access, 'index-only')
  assert.equal('records' in record.loadRouteFor('L0'), false)
  assert.equal(record.loadRouteFor('L1').access, 'full-raw')
  assert.ok(fs.statSync(path.join(record.paths.route, 'evidence-index.json')).size <= 900)

  const tooSmall = path.join(directory, 'too-small-route')
  assert.throws(() => routeTranscript.createRouteTranscript(tooSmall, { maxBytes: 1 }), error => error.code === 'EVIDENCE_INDEX_LIMIT_TOO_SMALL')
})

test('request privacy metadata flags text, structured, binary, late, and chunk-boundary secrets without altering or printing bytes', t => {
  const directory = fixture(t, 'request-privacy')
  const requestDir = path.join(directory, 'request')
  const chunk = requestEnvelope.SECRET_SCAN_CHUNK_BYTES
  const lateBoundarySecret = `${'x'.repeat((chunk * 2) - 5)}\napi_key=lateBoundaryToken_123456789`
  const structured = { type: 'structured', metadata: { client_secret: 'structuredToken_123456789', purpose: 'test' }, content: { exact: true } }
  const binary = Buffer.from(`\u0000\u0001password=binaryToken_123456789\u0000`, 'utf8')
  requestEnvelope.createRequestEnvelope(requestDir, [{
    id: 'api_key=messageMarkerLeakToken_123456789',
    blocks: [lateBoundarySecret, {
      ...structured,
      blockId: 'client_secret=blockMarkerLeakToken_123456789',
    }, {
      type: 'attachment',
      blockId: 'api_key=attachmentMarkerLeakToken_123456789',
      filename: 'password=filenameMarkerLeakToken_123456789.bin',
      mediaType: 'application/octet-stream',
      exactBytes: binary,
    }],
  }])
  const loaded = requestEnvelope.loadRequestEnvelope(requestDir)
  assert.equal(loaded.privacy.sensitive, true)
  assert.ok(loaded.privacy.scannedBytes > 128 * 1024)
  assert.ok(loaded.privacy.findings.some(item => item.id === 'entry-1-block-1'))
  assert.ok(loaded.privacy.findings.some(item => item.id === 'entry-1-block-2'))
  assert.ok(loaded.privacy.findings.some(item => item.id === 'entry-1-block-3'))
  assert.equal(Buffer.from(loaded.records[0].orderedContentBlocks[0].exactBytesBase64, 'base64').toString('utf8'), lateBoundarySecret)
  assert.deepEqual(
    JSON.parse(Buffer.from(loaded.records[0].orderedContentBlocks[1].exactBytesBase64, 'base64').toString('utf8')),
    { ...structured, blockId: 'client_secret=blockMarkerLeakToken_123456789' },
  )
  assert.deepEqual(Buffer.from(loaded.records[0].orderedContentBlocks[2].exactBytesBase64, 'base64'), binary)
  const markerText = fs.readFileSync(path.join(requestDir, 'privacy.json'), 'utf8')
  for (const secret of [
    'lateBoundaryToken_123456789', 'structuredToken_123456789', 'binaryToken_123456789',
    'messageMarkerLeakToken_123456789', 'blockMarkerLeakToken_123456789',
    'attachmentMarkerLeakToken_123456789', 'filenameMarkerLeakToken_123456789',
  ]) {
    assert.equal(markerText.includes(secret), false)
  }

  const routeDir = path.join(directory, 'route')
  routeTranscript.createRouteTranscript(routeDir)
  routeTranscript.appendRouteEvent(routeDir, { id: 'late-route-secret', output: lateBoundarySecret }, { rawObjectThresholdBytes: 10 })
  const route = routeTranscript.loadRouteTranscript(routeDir)
  assert.equal(route.records[0].sensitive, true)
  assert.ok(route.records[0].sensitivity_categories.includes('credential-field'))
})

test('secret scanning is false-positive-safe for descriptive structured metadata', t => {
  const directory = fixture(t, 'privacy-false-positive')
  const requestDir = path.join(directory, 'request')
  const descriptive = {
    type: 'structured',
    metadata: {
      title: 'Secret Garden documentation',
      api_key_description: 'where an operator would configure a credential',
      passwordPolicy: 'use the organization policy',
      authorizationGuide: 'documentation only',
    },
  }
  requestEnvelope.createRequestEnvelope(requestDir, [{ id: 'descriptive-message', blocks: [descriptive] }])
  const loaded = requestEnvelope.loadRequestEnvelope(requestDir)
  assert.equal(loaded.privacy.sensitive, false)
  assert.deepEqual(loaded.privacy.findings, [])
})

test('permission audit rejects widened POSIX modes and mocked or real widened Windows ACLs', t => {
  assert.throws(() => safeRoot.validateWindowsAclSnapshot({
    currentName: 'EXAMPLE\\user', currentSid: 'S-1-5-21-1000',
    items: [{ path: 'C:\\private', owner: 'EXAMPLE\\user', ownerSid: 'S-1-5-21-1000', protected: true, rules: [
      { identity: 'EXAMPLE\\user', sid: 'S-1-5-21-1000', type: 'Allow', inherited: false },
      { identity: 'Everyone', sid: 'S-1-1-0', type: 'Allow', inherited: false },
    ] }],
  }), error => error.code === 'PRIVACY_VIOLATION' && !JSON.stringify(error.details).includes('private request'))
  assert.throws(() => safeRoot.validateWindowsAclSnapshot({
    currentName: 'EXAMPLE\\user', currentSid: 'S-1-5-21-1000',
    items: [{ path: 'C:\\private', owner: 'EXAMPLE\\user', ownerSid: 'S-1-5-21-1000', protected: false, rules: [
      { identity: 'EXAMPLE\\user', sid: 'S-1-5-21-1000', type: 'Allow', inherited: false },
    ] }],
  }), error => error.code === 'PRIVACY_VIOLATION' && /unprotected/i.test(error.message))

  const directory = fixture(t, 'permission-widening')
  const project = gitProject(directory)
  const record = runRecord.createRunRecord({
    targetPath: project, canonicalProviderPrivateRoot: path.join(directory, 'private'), exactTree: true,
    runId: 'privacy-widen', request: { content: 'private request bytes' },
  })
  if (process.platform === 'win32') {
    const widened = spawnSync('icacls.exe', [record.paths.metadataPath, '/grant', '*S-1-1-0:R'], { encoding: 'utf8', windowsHide: true })
    assert.equal(widened.status, 0, widened.stderr)
    assert.throws(() => runRecord.openRunRecord(record.runPath), error => error.code === 'PRIVACY_VIOLATION')
  } else {
    fs.chmodSync(record.paths.metadataPath, 0o644)
    assert.throws(() => runRecord.openRunRecord(record.runPath), error => error.code === 'PRIVACY_VIOLATION')
    fs.chmodSync(record.paths.metadataPath, 0o600)
    fs.chmodSync(record.runPath, 0o755)
    assert.throws(() => runRecord.openRunRecord(record.runPath), error => error.code === 'PRIVACY_VIOLATION')
  }
})
