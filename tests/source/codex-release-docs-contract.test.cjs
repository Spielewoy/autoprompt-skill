'use strict'

const assert = require('node:assert/strict')
const crypto = require('node:crypto')
const fs = require('node:fs')
const path = require('node:path')
const test = require('node:test')
const {
  plainLanguageViolations,
  renderFullCompiledGates,
  validateCanonicalAndSharedPlainLanguage,
  validateGeneratedPlainLanguage,
} = require('../../scripts/generate-provider-contracts.cjs')

const ROOT = path.resolve(__dirname, '..', '..')
const LOCAL_BUILD_VERSION = fs.readFileSync(path.join(ROOT, 'agents/codex/VERSION'), 'utf8').trim()
const LOCAL_BUILD_PATTERN = LOCAL_BUILD_VERSION.replaceAll('.', '\\.')
const PRIVACY_GUIDE = 'docs/guides/codex-v2-local-records.md'
const PUBLIC_ROUTE_DOCS = [
  'README.md',
  'docs/faq/tokensaver-vs-wide-vs-custom.md',
  PRIVACY_GUIDE,
  'docs/translations/ar.md',
  'docs/translations/es.md',
  'docs/translations/ko.md',
  'docs/translations/zh.md',
  'assets/anatomy.svg',
  'assets/i18n/ar/anatomy.svg',
  'assets/i18n/es/anatomy.svg',
  'assets/i18n/ko/anatomy.svg',
  'assets/i18n/zh/anatomy.svg',
]
const LOCAL_BUILD_MARKER = `codex-v2-release-status: local-v${LOCAL_BUILD_VERSION}-build-not-published`
const SVG_LOCAL_BUILD_MARKER = `data-release-status="local-v${LOCAL_BUILD_VERSION}-build-not-published"`
const ANATOMY_DIAGRAMS = PUBLIC_ROUTE_DOCS.filter(file => file.endsWith('anatomy.svg'))
const HOW_IT_WORKS_DIAGRAMS = [
  'assets/how-it-works-loop.svg',
  'assets/how-it-works-hierarchy.svg',
]

function read(relative) {
  return fs.readFileSync(path.join(ROOT, relative), 'utf8')
}

function readJson(relative) {
  return JSON.parse(read(relative))
}

function phaseStatus(roadmap, phase) {
  const row = roadmap.split(/\r?\n/).find(line => line.startsWith(`| ${phase} `))
  assert.ok(row, `${phase}: durable progress-board row is required`)
  return row.split('|')[3].trim()
}

test('Codex local-record user docs define fail-closed retention and export authority', () => {
  const readme = read('README.md')
  const guide = read(PRIVACY_GUIDE)

  assert.match(readme, new RegExp(`local v${LOCAL_BUILD_PATTERN} build`, 'i'))
  assert.match(readme, /not (?:been )?published/i)
  assert.match(readme, /codex-v2-local-records\.md/)
  assert.match(guide, new RegExp(`local Codex v${LOCAL_BUILD_PATTERN} build`, 'i'))
  assert.match(guide, /not been published as a package or release/i)
  assert.match(guide, /automatic deletion is disabled/i)
  assert.match(guide, /expiry is not deletion authority/i)
  assert.match(guide, /no over-limit child\s+result is accepted/i)
  assert.match(guide, /lifecycle events can arrive after a\s+tool starts/i)
  assert.match(guide, /automatic route analysis[\s\S]*?8,000-token[\s\S]*?60-second absolute watchdog/i)
  assert.match(guide, /required workers and independent checkers have no hidden default[\s\S]*?tool-call ceiling/i)
  assert.match(guide, /eight worker calls and four checker calls[\s\S]*?never as permission to abandon/i)
  assert.match(guide, /explicit aggregate token budget or physical[\s\S]*?tool-call ceiling[\s\S]*?enforced exactly/i)
  assert.match(guide, /controller-owned loopback relay applies a preventive per-response token envelope/i)
  assert.match(guide, /272,000-token model context/i)
  assert.match(guide, /128,000-token response maximum/i)
  assert.match(guide, /API-key authentication, it injects `max_output_tokens`/i)
  assert.match(guide, /ChatGPT subscription backend rejects that parameter[\s\S]*?omits it[\s\S]*?full 128,000-token response maximum plus the input upper bound/i)
  assert.match(guide, /Default required work has no cumulative token cap/i)
  assert.match(guide, /concurrent children under an explicit budget wait/i)
  assert.match(readme, /full Codex runtime validation is Linux-only/i)
  assert.match(guide, /native Windows has no implemented\s+descriptor-anchored filesystem adapter/i)
  assert.match(guide, /macOS has not been validated/i)
  assert.match(guide, /request that cannot fit an explicit allowance is refused before\s+it reaches the upstream provider/i)
  assert.match(guide, /total\s+input including cached input/i)
  assert.match(guide, /disconnected child\s+cancels its upstream request/i)
  assert.match(guide, /compaction is not a cumulative token or billing cap/i)
  assert.match(guide, /private controlled model catalog forces Codex 0\.148 into direct-tool mode/i)
  assert.match(guide, /request and\s+stream retries to zero/i)
  assert.match(guide, /charges only that request's finite admitted maximum\s+unaccounted allowance/i)
  assert.match(guide, /configure codex --agents gpt-5\.6-sol --effort xhigh/i)
  assert.match(guide, /without `--effort` restores the existing per-role defaults/i)
  assert.match(guide, /cannot be combined with `--agents off`/i)
  assert.match(guide, /does not change the outer session or synthetic run-owner effort policy[\s\S]*?PRE_ROUTE model turns still run at low effort/i)
  assert.match(guide, /exactly one fresh transport successor/i)
  assert.match(guide, /second unknown provider response is not looped[\s\S]*?candidate is preserved/i)
  assert.match(guide, /no hidden second budget for verification/i)
  assert.match(guide, /no hidden default budget that\s+can prevent a required checker from starting/i)
  assert.match(guide, /preserves\s+the usable candidate as\s+`DONE_WITH_VERIFICATION_LIMITATIONS`/i)
  assert.match(guide, /autoprompt\.independent-check-quota-envelope/i)
  assert.match(guide, /before the relay can send the first upstream byte[\s\S]*?durably records/i)
  assert.match(guide, /exact request-bound usage is reconciled\s+without double charging/i)
  assert.match(guide, /crash-adopted continuation[\s\S]*?explicit tool ceiling[\s\S]*?receives no\s+renewed allowance/i)
  assert.match(guide, /model_auto_compact_token_limit=32768/i)
  assert.match(guide, /no built-in export command/i)
  assert.match(guide, /exact run id and exact files/i)
  assert.match(guide, /destination and recipient/i)
  assert.match(guide, /one transfer only/i)
  assert.match(guide, /must refuse the export/i)
  assert.match(guide, /secret markers are advisory/i)
  assert.match(guide, /do not redact or remove the\s+saved bytes/i)
})

test('Codex install docs separate the unpublished provider package and bind final size metrics', () => {
  const readme = read('README.md')
  const packageMetadata = readJson('packages/codex/package.json')

  assert.match(readme, /`autoprompt-skill`[^\n]*multi-provider aggregate/i)
  assert.match(readme, /`@autoprompt-skill\/codex-runtime`[^\n]*(?:Codex-only|only Codex)/i)
  assert.match(readme, /not published/i)
  assert.match(readme, /codex-artifact\.cjs --stage <absolute-directory>/)
  assert.match(readme, /authoritative measurements[\s\S]{0,80}packages\/codex\/release\.json/i)
  for (const field of ['packedBytes', 'fileCount', 'externalDependencyCount']) {
    assert.match(readme, new RegExp(`\\b${field}\\b`), field)
  }
  assert.match(readme, /final\s+frozen repack/i)
  assert.equal(Object.keys(packageMetadata.dependencies || {}).length, 0)
  assert.equal(Object.keys(packageMetadata.optionalDependencies || {}).length, 0)
  assert.match(readme, /0 npm dependencies[^\n]*0 optional dependencies/i)
})

test(`Codex target route docs consistently identify the local v${LOCAL_BUILD_VERSION} build as not published`, () => {
  const roadmap = read('AUTOPROMPT-TOTAL-FIX-MAP.md')
  const p11Status = phaseStatus(roadmap, 'P11 Canary and paired evaluation')
  const p12Status = phaseStatus(roadmap, 'P12 Legacy removal and documentation')

  assert.notEqual(p11Status, '', 'P11 must have a durable status')
  assert.notEqual(p12Status, '', 'P12 must have a durable status')
  for (const relative of PUBLIC_ROUTE_DOCS) {
    const source = read(relative)
    assert.match(source, /path=auto/i, `${relative}: documents automatic route selection`)
    for (const route of ['direct', 'light', 'roadmap']) {
      assert.match(source, new RegExp(`\\b${route}\\b`, 'i'), `${relative}: documents ${route}`)
    }
    if (p12Status !== 'DONE') {
      const expected = relative.endsWith('.svg') ? SVG_LOCAL_BUILD_MARKER : LOCAL_BUILD_MARKER
      assert.ok(source.includes(expected), `${relative}: identifies the local v${LOCAL_BUILD_VERSION} build as not published`)
      assert.doesNotMatch(source, /development-only|development only|not released before P12|until P12/i,
        `${relative}: removes the obsolete phase-based release wording`)
    }
  }
})

test('Codex path examples keep provider syntax separate and put path first in the quoted request', () => {
  const readme = read('README.md')

  assert.match(
    readme,
    /autoprompt activate codex -- "path=direct fix the registration race and run the focused test"/u,
  )
  assert.match(readme, /slash-command[\s\S]{0,100}does not support `path=`/iu)
  assert.doesNotMatch(readme, /autoprompt activate codex -- path=/u)
  assert.doesNotMatch(readme, /\/autoprompt[^\r\n`]*path=/u)

  for (const relative of ANATOMY_DIAGRAMS) {
    const source = read(relative)
    const slashCommand = source.match(/<text\b[^>]*>\/autoprompt[\s\S]*?<\/text>/iu)?.[0]
    const codexCommand = source.match(/<text\b[^>]*>autoprompt activate codex --[\s\S]*?<\/text>/iu)?.[0]

    assert.ok(slashCommand, `${relative}: has a copyable slash-command-provider row`)
    assert.doesNotMatch(slashCommand, /path=/iu, `${relative}: slash-command row does not advertise path`)
    assert.ok(codexCommand, `${relative}: has a copyable Codex v2 launcher row`)
    assert.match(
      codexCommand,
      /autoprompt activate codex -- "path=auto mode=wide max_subs=100 agents=auto /u,
      `${relative}: Codex v2 row starts the quoted request with path`,
    )
    assert.match(source, /CODEX V2/iu, `${relative}: labels the provider boundary`)
    assert.ok(source.includes(SVG_LOCAL_BUILD_MARKER), `${relative}: keeps the local-build disclaimer`)
  }
})

test('Codex how-it-works diagrams show route-specific planning, hierarchy, and assurance', () => {
  for (const relative of HOW_IT_WORKS_DIAGRAMS) {
    const source = read(relative)
    assert.ok(source.includes(SVG_LOCAL_BUILD_MARKER), `${relative}: keeps the local-build disclaimer`)
    assert.match(source, /NOT PUBLISHED/iu, `${relative}: shows the unpublished status`)
    for (const route of ['DIRECT', 'LIGHT', 'ROADMAP']) {
      assert.match(source, new RegExp(`>${route}<`, 'u'), `${relative}: shows ${route}`)
    }
  }

  const loop = read('assets/how-it-works-loop.svg')
  assert.match(loop, />Success card</u)
  assert.match(loop, />No short plan or roadmap</u)
  assert.match(loop, />Success card \+ short plan</u)
  assert.match(loop, />Scope \+ executable roadmap</u)
  assert.match(loop, />Independent plan check</u)
  assert.match(loop, />Risk-aware independent review \+ testing</u)
  assert.match(loop, />A second checker requires a named, distinct risk responsibility</u)

  const hierarchy = read('assets/how-it-works-hierarchy.svg')
  assert.equal((hierarchy.match(/>Shallow topology · no L1 or L2</gu) || []).length, 1)
  assert.match(hierarchy, />Short planning · no L1 or L2</u)
  assert.match(hierarchy, />Admitted only on ROADMAP</u)
  assert.match(hierarchy, />Manager, if admitted</u)
  assert.match(hierarchy, />Extra checker only for a named risk</u)
})

test('Codex target-design prose, generated check docs, and anatomy diagrams pass whole-surface lint', () => {
  const contracts = {
    product: readJson('agents/contracts/product.json'),
    routes: readJson('agents/contracts/routes.json'),
    stateMachine: readJson('agents/contracts/state-machine.json'),
    roles: readJson('agents/contracts/roles.json'),
    gates: readJson('agents/contracts/gates.json'),
    providers: readJson('agents/contracts/providers.json'),
    plainLanguage: readJson('agents/contracts/plain-language.json'),
  }
  assert.equal(validateCanonicalAndSharedPlainLanguage(contracts, ROOT), true)

  const hiddenProse = structuredClone(contracts)
  hiddenProse.gates.definitions['behavior-test'].execution.negativePaths[1].condition =
    'The command returns but the oracle rejects the result.'
  assert.throws(
    () => validateCanonicalAndSharedPlainLanguage(hiddenProse, ROOT),
    /agents\/contracts\/gates[^:]*:.*forbidden prompt term oracle/,
  )

  const gatesSource = read('agents/contracts/gates.json').replace(/\r\n/g, '\n')
  const generatedChecks = renderFullCompiledGates(
    contracts.gates,
    crypto.createHash('sha256').update(gatesSource).digest('hex'),
  )
  assert.equal(validateGeneratedPlainLanguage(
    new Map([['agents/codex/GATES.md', generatedChecks]]),
    contracts.plainLanguage,
  ), true)
  assert.match(
    generatedChecks,
    /`oracle-rejected`.*observable check.*`mission-coordinator`.*run coordinator.*`candidateVersionHash`.*exact version being checked/is,
  )

  for (const relative of [...ANATOMY_DIAGRAMS, ...HOW_IT_WORKS_DIAGRAMS]) {
    const visibleText = [...read(relative).matchAll(
      /<(?:title|desc|text)\b[^>]*>([\s\S]*?)<\/(?:title|desc|text)>/giu,
    )].map(match => match[1].replace(/<[^>]+>/g, ' ')).join('\n')
    assert.deepEqual(plainLanguageViolations(visibleText, contracts.plainLanguage, relative), [], relative)
  }
})
