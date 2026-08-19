#!/usr/bin/env node
'use strict'

const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const test = require('node:test')

const ROOT = path.resolve(__dirname, '..', '..')
const PROVIDERS = ['claude', 'codex', 'opencode', 'kilo', 'grok', 'vscode', 'prime']
const SKILLS = new Map(PROVIDERS.map(provider => [
  provider,
  provider === 'prime'
    ? 'agents/prime/skills/autoprompt/SKILL.md'
    : `agents/${provider}/SKILL.md`,
]))

function read(relativePath) {
  return fs.readFileSync(path.join(ROOT, relativePath), 'utf8').replace(/\r\n/g, '\n')
}

function chooserBlock(source) {
  const match = /(?:Before spawning, resolve only undefined operator knobs:|## Useful-first start)([\s\S]*?)(?:After the chooser|## Adaptive roadmap)/.exec(source)
  assert.ok(match, 'skill must expose a bounded startup chooser block')
  return match[1]
}

test('all seven public skills are explicit-only and a bare invocation always stops', () => {
  for (const [provider, relativePath] of SKILLS) {
    const source = read(relativePath)
    assert.match(source, /explicit(?:-only| invocation|ly invokes)|Use only when the user explicitly/i, `${provider} explicit trigger`)
    assert.match(source, /bare invocation[^.]*stops?(?:[;.]|\s)/i, `${provider} bare stop`)
    assert.match(source, /frontier/i, `${provider} bare frontier report`)
    assert.doesNotMatch(source, /bare invocation may resume/i, `${provider} must not resume implicitly`)
  }
})

test('Claude top-level skill is user-only and cannot be selected by the model', () => {
  const source = read(SKILLS.get('claude'))
  assert.match(source, /^user-invocable: true$/m)
  assert.match(source, /^disable-model-invocation: true$/m)
})

test('every attended provider resolves missing knobs once before repository work', () => {
  for (const provider of PROVIDERS) {
    const relativePath = SKILLS.get(provider)
    const source = read(relativePath)
    const occurrences = source.match(/In an attended session, ask all undefined knobs in one (?:`AskUserQuestion` call|question) before (?:any )?repository(?:\/tool)? work\./g) || []
    assert.equal(occurrences.length, 1, `${provider} must have one pre-work chooser`)
  }
})

test('chooser model options match each provider capability', () => {
  for (const provider of ['claude', 'codex']) {
    const block = chooserBlock(read(SKILLS.get(provider)))
    assert.match(block, /Agent selection:[^\n]*`off`\/inherit[^\n]*`auto`[^\n]*explicit model list/i, provider)
  }

  for (const provider of ['opencode', 'kilo', 'vscode']) {
    const block = chooserBlock(read(SKILLS.get(provider)))
    assert.match(block, /Agent selection:[^\n]*`off`\/inherit/i, `${provider} inherit choice`)
    assert.match(block, /inherited-only/i, `${provider} truthful capability`)
    assert.doesNotMatch(block, /Auto-tier|Custom (?:model )?(?:set|models)/i, `${provider} false chooser choices`)
  }

  const prime = chooserBlock(read(SKILLS.get('prime')))
  assert.match(prime, /Agent selection:[^\n]*`off`\/inherit only/i)
  assert.match(prime, /inherits the already-selected parent model/i)
  assert.match(prime, /no per-child model routing selector is available/i)
  assert.doesNotMatch(prime, /`agents=auto`|Auto-tier|Custom (?:model )?(?:set|models)/i)

  for (const provider of ['opencode', 'kilo', 'vscode']) {
    const modes = read(`agents/${provider}/MODES.md`)
    const chooser = /### Chooser and attendance([\s\S]*?)### [^\n]+ agent selection and effort/.exec(modes)
    assert.ok(chooser, `${provider} modes chooser`)
    assert.match(chooser[1], /agent selection: Inherit only/i, `${provider} modes inherit choice`)
    assert.match(chooser[1], /effort capability: report exactly `inherited-only`/i, `${provider} modes truthful effort`)
    assert.doesNotMatch(chooser[1], /Auto-tier|Custom (?:model )?set/i, `${provider} modes false choices are absent`)
  }
})

test('provider routing statements match the real adapters', () => {
  assert.match(read(SKILLS.get('claude')), /Claude Code routing uses `opus`, `sonnet`, and `haiku`/)
  assert.match(read(SKILLS.get('codex')), /actual custom-agent TOML `model` and `model_reasoning_effort` capabilities/)
  for (const provider of ['opencode', 'kilo', 'vscode']) {
    const source = read(SKILLS.get(provider))
    assert.match(source, /inherit(?:s|ed)[^\n]*model/i, provider)
    assert.match(source, /inherited-only/i, provider)
    assert.match(source, /explicit model list is not routable|agent selection changes nothing|never claim a selectable effort/i, provider)
  }
  const prime = read(SKILLS.get('prime'))
  assert.match(prime, /never passes `model`[^.]*inherits the selected parent model/i)
})

test('an attended conductor cannot dispatch Agent or Task before the chooser', () => {
  const { startupHandshakeFindings } = require('../../agents/claude/workflow/autoprompt-ledger-check.js')
  const transcript = firstToolUseName => ({
    path: '00-conductor-root.jsonl',
    firstToolUseName,
    hasUserInterrupt: false,
  })

  for (const tool of ['Agent', 'Task']) {
    const findings = startupHandshakeFindings({ attended: true, transcripts: [transcript(tool)] })
    assert.equal(findings.length, 1, `${tool} must not bypass the attended chooser`)
    assert.equal(findings[0].rule, 'startupHandshakeFindings')
  }

  assert.deepEqual(startupHandshakeFindings({
    attended: true,
    transcripts: [{ ...transcript('AskUserQuestion'), hasUserInterrupt: true }],
  }), [])
  assert.deepEqual(startupHandshakeFindings({ attended: false, transcripts: [transcript('Agent')] }), [])
})
