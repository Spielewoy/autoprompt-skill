'use strict'
const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const p = require('./portable.cjs')
const c = require('./producer-context.cjs')

function fixture() {
  const env = { GITHUB_ACTIONS: 'true', GITHUB_API_URL: 'https://api.github.com',
    GITHUB_SERVER_URL: 'https://github.com', GITHUB_JOB: 'platform-primitives',
    RUNNER_OS: 'Windows', RUNNER_ARCH: 'X64',
    GITHUB_REF: 'refs/heads/codex/issue-27-native-platform-support', GITHUB_EVENT_NAME: 'push',
    GITHUB_REPOSITORY: 'owner/repository', GITHUB_SHA: 'a'.repeat(40),
    GITHUB_RUN_ID: '123', GITHUB_RUN_ATTEMPT: '2' }
  const expected = c.environment(env)
  const run = { id: 123, run_attempt: 2, head_sha: expected.headSha,
    repository: { full_name: expected.repository }, path: '.github/workflows/native-platform.yml',
    status: 'in_progress', conclusion: null }
  const job = { id: 456, run_id: 123, head_sha: expected.headSha, name: c.JOB_NAME,
    run_url: 'https://api.github.com/repos/owner/repository/actions/runs/123',
    status: 'in_progress', conclusion: null }
  return { env, expected, run, job }
}

test('producer identity requires the exact trusted branch, runner and workflow role', () => {
  const { env, expected } = fixture()
  assert.equal(expected.runAttempt, 2)
  assert.equal(Object.isFrozen(expected), true)
  for (const [key, value] of [ ['GITHUB_API_URL', 'https://attacker.invalid'],
    ['GITHUB_SERVER_URL', 'http://github.com'], ['GITHUB_ACTIONS', 'false'],
    ['GITHUB_JOB', 'other-job'], ['RUNNER_ARCH', 'ARM64'], ['RUNNER_OS', 'Linux'],
    ['GITHUB_REF', 'refs/heads/main'], ['GITHUB_EVENT_NAME', 'pull_request'],
    ['GITHUB_RUN_ID', '123/attempts/1'], ['GITHUB_RUN_ATTEMPT', '0'],
    ['GITHUB_REPOSITORY', 'owner/repo/other'], ['GITHUB_SHA', 'latest'],
  ]) assert.throws(() => c.environment({ ...env, [key]: value }), key)
})

test('API token and path validation never permits another origin or arbitrary resource', async () => {
  for (const token of [undefined, '', 'secret\r\nInjected', 'x'.repeat(4097)]) assert.throws(() => c.apiReader(token))
  const reader = c.apiReader('test-only-token-not-used-on-network')
  for (const request of ['https://attacker.invalid', '/repos/o/r/actions/runs/123?token=x',
    '/repos/o/r/actions/runs/123/attempts/2/jobs?per_page=100&page=3', '/repos/../r/actions/runs/123']) {
    assert.throws(() => reader(request))
  }
})

test('current-run API responses supply exact numeric job ID and are checked before and after pagination', async () => {
  const { expected, run, job } = fixture()
  const calls = []
  const producer = await c.currentProducer(expected, async url => {
    calls.push(url)
    return url.includes('/jobs?') ? { total_count: 1, jobs: [job] } : run
  })
  assert.equal(producer.jobId, '456')
  assert.equal(producer.runAttempt, 2)
  assert.deepEqual(calls, [ '/repos/owner/repository/actions/runs/123',
    '/repos/owner/repository/actions/runs/123/attempts/2/jobs?per_page=100&page=1',
    '/repos/owner/repository/actions/runs/123' ])
})

for (const [name, mutate] of [
  ['different repository', x => { x.run.repository.full_name = 'other/repository' }],
  ['different head', x => { x.run.head_sha = 'b'.repeat(40) }],
  ['another attempt', x => { x.run.run_attempt = 1 }],
  ['another workflow', x => { x.run.path = '.github/workflows/other.yml' }],
  ['completed run', x => { x.run.status = 'completed' }],
  ['wrong matching job run', x => { x.job.run_id = 124 }],
  ['wrong matching job head', x => { x.job.head_sha = 'b'.repeat(40) }],
  ['wrong matching job attempt', x => { x.job.run_attempt = 1 }],
  ['wrong matching job URL', x => { x.job.run_url = 'https://attacker.invalid' }],
  ['wrong exact job name', x => { x.job.name += ' duplicate' }],
  ['completed job', x => { x.job.status = 'completed' }],
]) test('current producer refuses ' + name, async () => {
  const x = fixture()
  mutate(x)
  await assert.rejects(c.currentProducer(x.expected,
    async url => url.includes('/jobs?') ? { total_count: 1, jobs: [x.job] } : x.run))
})

test('bounded pagination resolves second page and refuses duplicate names or IDs', async () => {
  const { expected, run, job } = fixture()
  const first = Array.from({ length: 100 }, (_, i) => ({ ...job, id: i + 1000, name: 'other ' + i }))
  const getter = async url => !url.includes('/jobs?') ? run : {
    total_count: 101, jobs: url.endsWith('page=1') ? first : [job] }
  assert.equal((await c.currentProducer(expected, getter)).jobId, '456')
  first[0].name = c.JOB_NAME
  await assert.rejects(c.currentProducer(expected, getter), /exactly once/)
  first[0].name = 'other 0'
  first[0].id = job.id
  await assert.rejects(c.currentProducer(expected, getter), /Duplicate workflow job ID/)
})

test('truncated, oversized or changed pagination inventories fail closed', async () => {
  const { expected, run, job } = fixture()
  for (const result of [ { total_count: 201, jobs: [job] }, { total_count: 0, jobs: [] },
    { total_count: 2, jobs: [job] }, { total_count: 1, jobs: [job, { ...job, id: 457 }] } ]) {
    await assert.rejects(c.currentProducer(expected, async url => url.includes('/jobs?') ? result : run))
  }
  let reads = 0
  await assert.rejects(c.currentProducer(expected, async url => url.includes('/jobs?')
    ? { total_count: 1, jobs: [job] } : { ...run, run_attempt: ++reads === 1 ? 2 : 3 }), /attempt differs/)
})

test('owned build receipts bind exact current compiler, linker and bootstrap bytes', t => {
  const root = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'producer-tools-')))
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  const payload = path.join(root, 'sdk/issue27-build')
  fs.mkdirSync(payload, { recursive: true })
  fs.mkdirSync(path.join(root, 'sdk/usr/bin'), { recursive: true })
  const digests = new Map()
  for (const file of ['gcc.exe', 'ld.exe', 'msys-2.0.dll']) {
    const bytes = Buffer.from('owned synthetic tool: ' + file)
    fs.writeFileSync(path.join(root, 'sdk/usr/bin', file), bytes)
    digests.set(file, p.hash(bytes))
  }
  const receipt = ['gcc.exe', 'ld.exe'].map(file => `${digests.get(file)}  /usr/bin/${file}\n`).join('')
  fs.writeFileSync(path.join(payload, 'toolchain-inputs.sha256'), receipt)
  fs.writeFileSync(path.join(payload, 'toolchain-outputs.sha256'), receipt)
  fs.writeFileSync(path.join(payload, 'bootstrap-runtime.sha256'), `${digests.get('msys-2.0.dll')}  /usr/bin/msys-2.0.dll\n`)
  assert.deepEqual(c.observedTools(root), { linkerSha256: digests.get('ld.exe'), bootstrapRuntimeSha256: digests.get('msys-2.0.dll') })
  fs.appendFileSync(path.join(root, 'sdk/usr/bin/ld.exe'), 'changed')
  assert.throws(() => c.observedTools(root), /differs from its compiler receipt/)
  fs.appendFileSync(path.join(payload, 'toolchain-outputs.sha256'), 'changed')
  assert.throws(() => c.observedTools(root), /before and after receipts differ/)
})
