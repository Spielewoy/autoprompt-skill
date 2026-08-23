#!/usr/bin/env node
'use strict'

const fs = require('node:fs')
const path = require('node:path')

const ROOT = path.resolve(__dirname, '..')

function read(relativePath, root = ROOT) {
  return fs.readFileSync(path.join(root, relativePath), 'utf8').replace(/\r\n/g, '\n')
}

function writeAtomic(relativePath, content, root = ROOT) {
  const target = path.join(root, relativePath)
  const temporary = `${target}.tmp-${process.pid}`
  fs.mkdirSync(path.dirname(target), { recursive: true })
  fs.writeFileSync(temporary, content, 'utf8')
  fs.renameSync(temporary, target)
}

function stripFrontmatter(text) {
  return text.replace(/^---\n[\s\S]*?\n---\n/, '')
}

function yamlDoubleQuoted(value) {
  return `"${value.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`
}

function asciiDashes(value) {
  return value.replace(/[\u2013\u2014]/g, '-')
}

function tomlBasicString(value) {
  return JSON.stringify(value)
}

function tomlStringArray(values) {
  return `[${values.map(tomlBasicString).join(', ')}]`
}

function codexSandbox(capabilities) {
  return capabilities.some(capability => ['Write', 'Edit', 'Bash'].includes(capability))
    ? 'workspace-write'
    : 'read-only'
}

function renderCodexAgent(persona, source) {
  const body = stripFrontmatter(source).replace(/\n+$/, '')
  if (body.includes('"""')) {
    throw new Error(`Codex persona ${persona.id} contains an unsupported TOML multiline delimiter`)
  }
  return [
    `sandbox_mode = ${tomlBasicString(codexSandbox(persona.capabilities))}`,
    `name = ${tomlBasicString(persona.id)}`,
    `description = ${tomlBasicString(persona.description)}`,
    '',
    'developer_instructions = """',
    body,
    '"""',
    '',
  ].join('\n')
}

function opencodePermissionLines(capabilities) {
  const lines = [
    `  read: ${capabilities.includes('Read') ? 'allow' : 'deny'}`,
    `  edit: ${capabilities.some(capability => capability === 'Write' || capability === 'Edit') ? 'allow' : 'deny'}`,
    `  glob: ${capabilities.includes('Glob') ? 'allow' : 'deny'}`,
    `  grep: ${capabilities.includes('Grep') ? 'allow' : 'deny'}`,
    `  bash: ${capabilities.includes('Bash') ? 'allow' : 'deny'}`,
  ]
  if (capabilities.includes('Agent')) {
    lines.push('  task:', '    "*": deny', '    "ap-*": allow')
  } else {
    lines.push('  task: deny')
  }
  lines.push(
    `  webfetch: ${capabilities.includes('WebFetch') ? 'allow' : 'deny'}`,
    `  websearch: ${capabilities.includes('WebSearch') ? 'allow' : 'deny'}`,
    '  skill: deny',
  )
  return lines
}

function renderOpencodeAgent(persona, source) {
  return [
    '---',
    `description: ${yamlDoubleQuoted(persona.description)}`,
    'mode: subagent',
    'permission:',
    ...opencodePermissionLines(persona.capabilities),
    '---',
    stripFrontmatter(source),
  ].join('\n')
}

const VSCODE_TOOL_ALIASES = [
  ['execute', ['Bash']],
  ['read', ['Read']],
  ['edit', ['Write', 'Edit']],
  ['search', ['Glob', 'Grep']],
  ['agent', ['Agent']],
  ['web', ['WebSearch', 'WebFetch']],
]

function vscodeTools(capabilities) {
  return VSCODE_TOOL_ALIASES
    .filter(([, sources]) => sources.some(source => capabilities.includes(source)))
    .map(([alias]) => alias)
}

function validateVsCodePersona(persona, personaIds) {
  if (!Array.isArray(persona.allowedChildren)) {
    throw new Error(`VS Code persona ${persona.id} must define allowedChildren`)
  }
  if (new Set(persona.allowedChildren).size !== persona.allowedChildren.length) {
    throw new Error(`VS Code persona ${persona.id} repeats an allowed child`)
  }
  for (const child of persona.allowedChildren) {
    if (!personaIds.has(child)) throw new Error(`VS Code persona ${persona.id} has unknown child ${child}`)
  }
  if (persona.capabilities.includes('Agent') !== (persona.allowedChildren.length > 0)) {
    throw new Error(`VS Code persona ${persona.id} has inconsistent Agent capability`)
  }
}

function renderVsCodeAgent(persona, source, personaIds) {
  validateVsCodePersona(persona, personaIds)
  return asciiDashes([
    '---',
    `name: ${yamlDoubleQuoted(persona.id)}`,
    `description: ${yamlDoubleQuoted(persona.description)}`,
    `tools: ${JSON.stringify(vscodeTools(persona.capabilities))}`,
    `agents: ${JSON.stringify(persona.allowedChildren)}`,
    'user-invocable: false',
    'disable-model-invocation: false',
    '---',
    stripFrontmatter(source),
  ].join('\n'))
}

function replaceSection(source, start, end, replacement) {
  const pattern = new RegExp(`${start}\\n[\\s\\S]*?\\n(?=${end})`)
  if (!pattern.test(source)) throw new Error(`Provider source is missing section ${start}`)
  return source.replace(pattern, `${replacement}\n\n`)
}

function renderVsCodeSettingsDisclosure(provider) {
  const prerequisites = Object.entries(provider.runtimePrerequisites || {})
  const lifecycle = provider.settingsLifecycle || {}
  const supportedLifecycle = lifecycle.edit === 'transactional' &&
    lifecycle.backup === 'byte-exact' &&
    JSON.stringify(lifecycle.restore) === JSON.stringify(['rollback', 'uninstall']) &&
    lifecycle.unsafeJsonc === 'refuse' &&
    lifecycle.conflicts === 'refuse'
  if (prerequisites.length !== 1 || prerequisites[0][1] !== true || !supportedLifecycle) {
    throw new Error('VS Code provider contract has an unsupported settings lifecycle')
  }
  const setting = `${prerequisites[0][0]}=${prerequisites[0][1]}`
  return `The installer transactionally sets \`${setting}\` in the VS Code user \`settings.json\`. When it changes an existing file, it stores a byte-exact backup and restores the prior bytes on rollback or uninstall. It refuses unsafe JSONC and conflicting state instead of overwriting user configuration.`
}

function renderVsCodeSkill(source, provider) {
  const settingsDisclosure = renderVsCodeSettingsDisclosure(provider)
  let output = asciiDashes(source).replaceAll('OpenCode', 'VS Code')
  output = replaceSection(output, '## 8\\. VS Code model and effort', '## 9\\.', [
    '## 8. VS Code model and effort',
    '',
    'VS Code `ap-*` subagents are native `.agent.md` definitions with no `model` field. Every role inherits the currently selected model, so casting and effort are `inherited-only`.',
    '',
    'The definitions map canonical capabilities to the pinned built-in aliases `execute`, `read`, `edit`, `search`, `agent`, and `web`. Dispatcher roles alone receive `agent` and an explicit canonical child allowlist. Non-dispatch roles omit `agent` and carry `agents: []`. Every internal role sets `user-invocable: false` and `disable-model-invocation: false`.',
    '',
    settingsDisclosure,
  ].join('\n'))
  return replaceSection(output, '## 11\\. Run', '$', [
    '## 11. Run',
    '',
    'Use VS Code 1.133 or later, install the skill and `.agent.md` definitions in their supported locations, and explicitly invoke:',
    '',
    '```text',
    '/autoprompt <mission>',
    '```',
    '',
    'A successful VS Code install leaves the recursive-subagent setting enabled, and doctor verifies it before recursive subagent use.',
  ].join('\n')).replace(/\n+$/, '\n')
}

function renderVsCodeModes(source, provider) {
  const output = asciiDashes(source).replaceAll('OpenCode', 'VS Code')
  return replaceSection(output, '### VS Code agent selection and effort', '## Steering', [
    '### VS Code agent selection and effort',
    '',
    'VS Code casting is `inherited-only`: installed `ap-*` custom agents omit `model` and inherit the currently selected model. Agent selection does not change gates or concurrency.',
    '',
    '- `agents=off` or omitted: the routable mode; every role inherits the selected model.',
    '- any explicit model selector: not routable through these `.agent.md` definitions; record `inherited-only` and do not claim that a selection applied.',
    '',
    'The recursion brakes are native. Canonical capabilities map to VS Code built-in tool aliases. Dispatcher roles include `agent` plus an explicit `agents` allowlist; non-dispatch roles omit `agent` and use `agents: []`. Internal roles are hidden from users and remain callable by an allowed parent.',
    '',
    renderVsCodeSettingsDisclosure(provider),
  ].join('\n'))
}

function renderVsCodeGates(source, provider) {
  let output = asciiDashes(source).replaceAll('OpenCode', 'VS Code')
  output = output.replace(
    /VS Code agent selection is `inherited-only`:[\s\S]*?Model and effort never change gates or concurrency\./,
    'VS Code agent selection is `inherited-only`: installed `ap-*` `.agent.md` definitions omit `model` and inherit the currently selected model. Model and effort never change gates or concurrency.',
  )
  output = output.replace(
    /The activation profile pins `subagent_depth = 4`[\s\S]*?These are ceilings, never spawn targets\./,
    `Each dispatcher uses the \`agent\` tool alias and an explicit canonical child allowlist. ${renderVsCodeSettingsDisclosure(provider)} Runtime nesting limits are ceilings, never spawn targets.`,
  )
  return output
}

function renderVsCodeProviderText(file, source, provider) {
  if (file === 'SKILL.md') return renderVsCodeSkill(source, provider)
  if (file === 'MODES.md') return renderVsCodeModes(source, provider)
  if (file === 'GATES.md') return renderVsCodeGates(source, provider)
  return asciiDashes(source)
}

function renderVsCodeReadme(provider) {
  return [
    '# VS Code package',
    '',
    'This deterministic adapter targets VS Code 1.133 custom agents with the bundled GitHub Copilot 0.61 contract.',
    '',
    '- [`SKILL.md`](SKILL.md): L0 conductor prompt',
    '- [`agents`](agents/): 25 native `.agent.md` internal roles',
    '- [`frameworks`](frameworks/): 18 task and gate workflows',
    '- [`GATES.md`](GATES.md), [`MODES.md`](MODES.md), and [`PLAYBOOKS.md`](PLAYBOOKS.md): execution contracts',
    '',
    renderVsCodeSettingsDisclosure(provider),
    '',
    'The agent files omit `model`, so every role inherits the currently selected model. All roles are internal, hidden from direct user invocation, and restricted by explicit canonical child allowlists.',
    '',
  ].join('\n')
}

function renderKiloProviderText(source) {
  return source
    .replaceAll('OPENCODE_CONFIG', 'KILO_CONFIG')
    .replaceAll('OpenCode', 'Kilo')
    .replaceAll('opencode', 'kilo')
    .replaceAll('1.18.7', '7.4.22')
}

function renderKiloProfile() {
  return `${JSON.stringify({
    $schema: 'https://app.kilo.ai/config.json',
    subagent_depth: 4,
    share: 'disabled',
    permission: { task: { '*': 'deny', 'ap-*': 'allow' } },
  }, null, 2)}\n`
}

// Grok Build reads Claude-style tool names in an agent definition's `tools`
// allowlist, so the canonical capability names map across unchanged.
const GROK_TOOL_ORDER = ['Read', 'Write', 'Edit', 'Bash', 'Glob', 'Grep', 'WebSearch', 'WebFetch']
const GROK_DISPATCH_TOOL = 'mcp__autoprompt__dispatch'
const GROK_RUNTIME_ID = 'grok-build-adapter-v1'
const GROK_MAX_DEPTH = 4

function grokTools(persona) {
  const tools = GROK_TOOL_ORDER.filter(tool => persona.capabilities.includes(tool))
  // Dispatchers reach children only through the sealed MCP dispatch tool. A
  // non-empty allowlist is load-bearing: an empty one would inherit every tool.
  if (persona.allowedChildren.length > 0) tools.push(GROK_DISPATCH_TOOL)
  return tools
}

function grokDisallowedTools(persona) {
  // `Agent` strips the native task tool: Grok Build caps native nesting at one
  // level, so every Autoprompt edge goes through the sealed dispatcher instead.
  // Non-dispatch roles also lose MCP discovery, which is how they reach it.
  return persona.allowedChildren.length > 0
    ? ['Agent']
    : ['Agent', 'search_tool', 'use_tool']
}

function grokCapabilityMode(capabilities) {
  const writes = capabilities.some(capability => capability === 'Write' || capability === 'Edit')
  const executes = capabilities.includes('Bash')
  if (writes && executes) return 'all'
  if (writes) return 'read-write'
  if (executes) return 'execute'
  return 'read-only'
}

function validateGrokPersona(persona, personaIds) {
  if (!Array.isArray(persona.allowedChildren)) {
    throw new Error(`Grok persona ${persona.id} must define allowedChildren`)
  }
  if (new Set(persona.allowedChildren).size !== persona.allowedChildren.length) {
    throw new Error(`Grok persona ${persona.id} repeats an allowed child`)
  }
  for (const child of persona.allowedChildren) {
    if (!personaIds.has(child)) throw new Error(`Grok persona ${persona.id} has unknown child ${child}`)
  }
  if (persona.capabilities.includes('Agent') !== (persona.allowedChildren.length > 0)) {
    throw new Error(`Grok persona ${persona.id} has inconsistent Agent capability`)
  }
}

function renderGrokAgent(persona, source, personaIds) {
  validateGrokPersona(persona, personaIds)
  return asciiDashes([
    '---',
    `name: ${yamlDoubleQuoted(persona.id)}`,
    `description: ${yamlDoubleQuoted(persona.description)}`,
    `tools: ${yamlDoubleQuoted(grokTools(persona).join(', '))}`,
    `disallowedTools: ${yamlDoubleQuoted(grokDisallowedTools(persona).join(', '))}`,
    `capabilityMode: ${grokCapabilityMode(persona.capabilities)}`,
    'permissionMode: default',
    'model: inherit',
    'promptMode: extend',
    'mcpInheritance: none',
    'discoverSkills: false',
    'inheritSkills: false',
    'agentsMd: true',
    '---',
    stripFrontmatter(source),
  ].join('\n'))
}

const OMP_TOOL_ALIASES = [
  ['read', ['Read']],
  ['write', ['Write']],
  ['edit', ['Edit']],
  ['glob', ['Glob']],
  ['grep', ['Grep']],
  ['bash', ['Bash']],
  ['task', ['Agent']],
  ['web_search', ['WebSearch']],
  ['browser', ['WebFetch']],
]

function ompTools(capabilities) {
  return OMP_TOOL_ALIASES
    .filter(([, sources]) => sources.some(source => capabilities.includes(source)))
    .map(([name]) => name)
}

function renderOmpAgent(persona, source) {
  const lines = [
    '---',
    `name: ${persona.id}`,
    `description: ${yamlDoubleQuoted(persona.description)}`,
    'tools:',
    ...ompTools(persona.capabilities).map(tool => `  - ${tool}`),
  ]
  if (persona.allowedChildren.length > 0) {
    lines.push('spawns:', ...persona.allowedChildren.map(child => `  - ${child}`))
  }
  lines.push('---', stripFrontmatter(source))
  return asciiDashes(lines.join('\n'))
}

function renderDeepSeekAgent(persona, source) {
  return asciiDashes([
    '---',
    `name: ${persona.id}`,
    `description: ${yamlDoubleQuoted(persona.description)}`,
    '---',
    stripFrontmatter(source),
  ].join('\n'))
}

function renderGrokTopology(personas, frameworks) {
  return `${JSON.stringify({
    schemaVersion: 1,
    runtime: GROK_RUNTIME_ID,
    maxDepth: GROK_MAX_DEPTH,
    rootAllowedChildren: PRIME_ROOT_ALLOWED_CHILDREN,
    frameworks: frameworks.map(framework => framework.id),
    personas: Object.fromEntries(personas.map(persona => [persona.id, persona.allowedChildren])),
  }, null, 2)}\n`
}

function renderGrokProfile(personas, frameworks) {
  return [
    '# Autoprompt activation profile for Grok Build.',
    '# The launcher and the sealed dispatcher read this file. Grok Build does not:',
    '# its own configuration stays in config.toml and is never rewritten wholesale.',
    '[autoprompt]',
    `runtime = "${GROK_RUNTIME_ID}"`,
    `max_depth = ${GROK_MAX_DEPTH}`,
    'dispatch = "sealed-headless-reentry"',
    'mcp_server = "autoprompt"',
    'native_subagent_spawn = "denied"',
    `personas = ${personas.length}`,
    `frameworks = ${frameworks.length}`,
    '',
  ].join('\n')
}

function grokDispatchDisclosure() {
  return [
    'Grok Build caps native subagent nesting at one level, so `spawn_subagent` can never',
    'carry the L0-L4 topology. Every `ap-*` definition therefore denies the native task',
    'tool, and every edge runs through the sealed dispatcher: it validates the launch',
    'activation, the caller persona, the canonical child allowlist, the depth ceiling of',
    '4, the framework registry, and the exact bytes of the prompt ledger before it starts',
    'the child as its own `grok --prompt-file <envelope> --agent <definition>` process.',
    'Dispatch roles reach it through the `autoprompt` MCP server (`autoprompt__dispatch`);',
    'non-dispatch roles have MCP discovery removed, and the dispatcher refuses terminal',
    'callers regardless. Because Grok Build offers user-scoped MCP servers to every',
    'session, an activation token minted by the launcher is required before any dispatch:',
    'a session Autoprompt did not start has none and is refused, never treated as the',
    'conductor.',
  ].join(' ')
}

function grokConcurrencyDisclosure() {
  return [
    'Dispatch a ready group in one call by passing `jobs`: every job is admitted before',
    'any child starts, the group then runs concurrently, and all reports are collected',
    'together. That is the spawn-all-then-collect shape, so reviewers, verifiers, and',
    'disjoint lanes really do run in parallel. The live-child ceiling is run-global, not',
    'per group: because every hop is its own process, the dispatchers of a run share',
    'file-backed slots keyed to the run activation, so the conductor, each coordinator,',
    'and each manager all draw from the same set. A dispatcher waiting on its own',
    'children yields its slot for that wait, which is what keeps a full run from',
    'deadlocking. The ceiling is `AUTOPROMPT_GROK_MAX_SUBS`, defaulting to the six live',
    'children `tokensaver` allows; raise it for `wide` or `custom max_subs=N`. A denied',
    'job cancels its whole group rather than leaving half a fleet running. Each slot is',
    'held by a lease id rather than by its path: claiming hard-links a fully written file',
    'into place, and releasing or reclaiming happens only while the lease on disk still',
    'matches, so a stale holder cannot evict its successor and one dead holder is',
    'reclaimed exactly once. The slot root therefore has to be a local filesystem that',
    'supports hard links and exclusive creation - a POSIX temp directory or NTFS does,',
    'FAT and network shares do not - and `AUTOPROMPT_GROK_SLOT_ROOT` moves it when the',
    'default temp directory is not one. A root that cannot hold exclusive claims fails',
    'the dispatch loudly instead of quietly oversubscribing the run.',
  ].join(' ')
}

// The identity a dispatcher trusts is process environment, so the boundary is worth
// stating plainly rather than implying more than it enforces.
function grokThreatModelDisclosure() {
  return [
    'Scope of the seal: the activation token, persona, and depth travel in the child',
    'process environment. That stops an ordinary Grok Build session from entering a run',
    'and keeps a cooperating cast inside the canonical topology, and it is not a sandbox',
    'against a worker that goes out of contract: a role holding `Bash` can read its own',
    'environment and re-run the dispatcher with different values. Treat the allowlist as',
    'run correctness, and rely on Grok Build permission modes and the persona tool',
    'allowlists for containment.',
  ].join(' ')
}

function renderGrokSkill(source) {
  let output = asciiDashes(source).replaceAll('OpenCode', 'Grok Build')
  output = replaceSection(output, '## 8\\. Grok Build model and effort', '## 9\\.', [
    '## 8. Grok Build model and effort',
    '',
    'Grok Build `ap-*` roles are native agent definitions installed with the skill. Each one pins `model: inherit`, so a child uses the run model the launcher resolved; casting is `inherited-only` and no per-role model selector is available. Because every hop is a fresh top-level process, the dispatcher reapplies the run-wide model and reasoning effort on each child and carries both forward in the sealed environment, so depth 4 runs the same model as depth 1. The launcher resolves them from either `AUTOPROMPT_GROK_MODEL` and `AUTOPROMPT_GROK_EFFORT` or the `--model`, `-m`, `--reasoning-effort`, and `--effort` flags typed on its own command line, whichever the operator used. Record effort as exactly `inherited-only` unless the operator set one run-wide reasoning effort.',
    '',
    grokDispatchDisclosure(),
    '',
    grokConcurrencyDisclosure(),
    '',
    grokThreatModelDisclosure(),
    '',
    'Each definition carries an explicit `tools` allowlist built from the persona\'s canonical capabilities, using the Claude-compatible tool names Grok Build resolves natively. Unattended runs need an explicit permission mode: set `AUTOPROMPT_GROK_PERMISSION_MODE` to a Grok Build mode such as `acceptEdits` or `dontAsk`. The default is `default`, and `bypassPermissions` additionally requires `AUTOPROMPT_GROK_ALLOW_BYPASS=1`.',
  ].join('\n'))
  return replaceSection(output, '## 11\\. Run', '$', [
    '## 11. Run',
    '',
    'Use Grok Build 1.0.0 or later, install the skill, and start through the launcher so the activation profile, the MCP dispatch registration, and the sealed depth-0 identity are checked first:',
    '',
    '```text',
    '~/.grok/skills/autoprompt/workflow/launch-grok.sh',
    '/autoprompt <mission>',
    '```',
    '',
    'For an unattended supervisor run, drive the same launcher headlessly:',
    '',
    '```text',
    'AUTOPROMPT_GROK_PERMISSION_MODE=acceptEdits \\',
    '  ~/.grok/skills/autoprompt/workflow/launch-grok.sh -p "/autoprompt <mission>"',
    '```',
    '',
    'A successful install leaves `autoprompt.grok.toml` beside `config.toml`, the sealed dispatcher under `skills/autoprompt/workflow/`, and one `[mcp_servers.autoprompt]` registration in `config.toml`. Doctor verifies all three before recursive use.',
  ].join('\n')).replace(/\n+$/, '\n')
}

function renderGrokModes(source) {
  const output = asciiDashes(source).replaceAll('OpenCode', 'Grok Build')
  return replaceSection(output, '### Grok Build agent selection and effort', '## Steering', [
    '### Grok Build agent selection and effort',
    '',
    'Grok Build casting is `inherited-only`: every installed `ap-*` definition pins',
    '`model: inherit`, so each child process runs the model the launcher resolved for',
    'the run.',
    '',
    '- `agents=off` or omitted: the routable mode; every role inherits the run model.',
    '- any explicit model selector: not routable through these definitions; record',
    '  `inherited-only` and do not claim that a selection applied.',
    '',
    'Record effort as exactly `inherited-only` unless the operator set one run-wide',
    'reasoning effort, which the dispatcher applies unchanged to every child and carries',
    'forward so deeper hops keep it.',
    '',
    grokDispatchDisclosure(),
    '',
    grokConcurrencyDisclosure(),
    '',
    grokThreatModelDisclosure(),
  ].join('\n'))
}

function renderGrokGates(source) {
  let output = asciiDashes(source).replaceAll('OpenCode', 'Grok Build')
  output = output.replace(
    /Grok Build agent selection is `inherited-only`:[\s\S]*?Model and effort never change gates or concurrency\./,
    'Grok Build agent selection is `inherited-only`: the installed `ap-*` agent definitions pin `model: inherit` and run the model the launcher resolved. It does not use Claude Code model aliases, alias routing, or custom-agent TOML casting. Model and effort never change gates or concurrency.',
  )
  output = output.replace(
    /The activation profile pins `subagent_depth = 4`[\s\S]*?These are ceilings, never spawn targets\./,
    `${grokDispatchDisclosure()} ${grokConcurrencyDisclosure()} ${grokThreatModelDisclosure()} The activation profile pins that contract, and the depth ceiling of 4 is a ceiling, never a spawn target.`,
  )
  return output
}

function renderGrokProviderText(file, source) {
  if (file === 'SKILL.md') return renderGrokSkill(source)
  if (file === 'MODES.md') return renderGrokModes(source)
  if (file === 'GATES.md') return renderGrokGates(source)
  return asciiDashes(source).replaceAll('OpenCode', 'Grok Build')
}

function renderGrokReadme(provider) {
  return [
    '# Grok Build package',
    '',
    `This deterministic adapter targets Grok Build ${provider.target}, checked against the published source at \`${provider.official.commit.slice(0, 12)}\` (upstream source revision \`${provider.official.upstreamSourceRev.slice(0, 12)}\`).`,
    '',
    '- [`SKILL.md`](SKILL.md): L0 conductor prompt',
    '- [`agents`](agents/): 25 native Grok Build agent definitions',
    '- [`frameworks`](frameworks/): 18 task and gate workflows',
    '- [`workflow`](workflow/): the sealed dispatcher, its MCP server, and the launchers',
    '',
    grokConcurrencyDisclosure(),
    '- [`GATES.md`](GATES.md), [`MODES.md`](MODES.md), and [`PLAYBOOKS.md`](PLAYBOOKS.md): execution contracts',
    '',
    grokDispatchDisclosure(),
    '',
    'The definitions pin `model: inherit`, so every role runs the model the launcher resolved. Installation adds one `[mcp_servers.autoprompt]` registration to `config.toml` transactionally, stores a byte-exact backup, and restores the prior bytes on rollback or uninstall.',
    '',
    '## Run slots on Windows',
    '',
    'The slot primitives are available on Windows and behave the same way: `link` maps to `CreateHardLinkW`, which needs no elevation on one NTFS volume; `rename` replaces an existing file; and Node opens files with delete sharing, so a concurrent reader does not block either. What Windows adds is transient contention - a scanner or indexer holding a handle surfaces as `EBUSY`, `EPERM`, or `EACCES` - so slot mutations retry briefly before failing, and a root that cannot do exclusive creation at all is refused with a message naming `AUTOPROMPT_GROK_SLOT_ROOT` rather than silently losing the ceiling.',
    '',
    'The slot race is covered by a test that drives real dispatcher processes through the primitives with no shell stub, so it runs wherever Node does, Windows included; the two stub-driven ceiling tests beside it are POSIX-only and say so where they skip. The installer\'s own Windows port is exercised only by the PowerShell lifecycle tests, which run on a Windows host and skip everywhere else, so nothing here reports an untested pass.',
    '',
  ].join('\n')
}

function renderReasonixAgent(persona, source) {
  return asciiDashes([
    '---',
    `name: ${persona.id}`,
    `description: ${yamlDoubleQuoted(persona.description)}`,
    'invocation: manual',
    'runAs: subagent',
    '---',
    stripFrontmatter(source),
  ].join('\n'))
}

function indentBlock(value, spaces) {
  const prefix = ' '.repeat(spaces)
  return value.split('\n').map(line => line ? `${prefix}${line}` : '').join('\n')
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

function deepSeekRoleTool(persona, source) {
  const toolName = persona.id.replaceAll('-', '_')
  const allowed = new Set(persona.allowedChildren.map(child => child.replaceAll('-', '_')))
  const allRoleNames = deepSeekRoleTool.personaIds
  const deniedRoles = allRoleNames.filter(candidate => !allowed.has(candidate))
  const lines = [
    `- id: autoprompt-${persona.id}`,
    "  name: '@deepseek-ai/dsh-tool-subagent'",
    '  config:',
    '    provider: spawn',
    `    toolName: ${toolName}`,
    '    backgroundMode: continuable',
    '    maxDepth: 4',
    '    persona: |-',
    indentBlock(stripFrontmatter(source).trimEnd(), 6),
    '    toolFilter:',
    '      deny:',
    '        - subagent',
    '        - subagent_fork',
    ...deniedRoles.map(role => `        - ${role}`),
  ]
  return lines.join('\n')
}
deepSeekRoleTool.personaIds = []

function renderDeepSeekPreset(personas, sources) {
  deepSeekRoleTool.personaIds = personas.map(persona => persona.id.replaceAll('-', '_'))
  const base = [
    '# Autoprompt agent preset for DeepSeek Harness 0.1.0-rc.7.',
    '- id: persona',
    "  name: '@deepseek-ai/dsh-persona'",
    '  config:',
    '    text: >-',
    '      You are a coding agent powered by the {{model}} model. Your working directory is {{cwd}}.',
    '- id: agent-instructions',
    "  name: '@deepseek-ai/dsh-agent-instructions'",
    '  config:',
    '    maxBytes: 65536',
    '- id: tool-bash',
    "  name: '@deepseek-ai/dsh-tool-bash'",
    "  disabled: !!js process.platform === 'win32'",
    '- id: tool-pwsh',
    "  name: '@deepseek-ai/dsh-tool-pwsh'",
    "  disabled: !!js process.platform !== 'win32'",
    '- id: tool-fs',
    "  name: '@deepseek-ai/dsh-tool-fs'",
    '- id: tool-fs-search',
    "  name: '@deepseek-ai/dsh-tool-fs-search'",
    '  config:',
    '    sampleOverCapGlobResults: false',
    '- id: tool-jobs',
    "  name: '@deepseek-ai/dsh-tool-jobs'",
    '- id: skill-filesystem',
    "  name: '@deepseek-ai/dsh-skill-filesystem'",
    '- id: tool-skill',
    "  name: '@deepseek-ai/dsh-tool-skill'",
    '- id: tool-goal',
    "  name: '@deepseek-ai/dsh-tool-goal'",
    '- id: tool-subagent-control',
    "  name: '@deepseek-ai/dsh-tool-subagent-control'",
    '- id: tool-subagent-list-agents',
    "  name: '@deepseek-ai/dsh-tool-subagent-control/list-agents'",
    '- id: tool-ask-user',
    "  name: '@deepseek-ai/dsh-tool-ask-user'",
    '- id: tool-todo',
    "  name: '@deepseek-ai/dsh-tool-todo'",
    '  config:',
    '    allowParallelInProgress: true',
    '- id: tool-web',
    "  name: '@deepseek-ai/dsh-tool-web'",
    '  config:',
    '    fetch: false',
    '    searchTimeoutMs: 60000',
  ]
  for (let index = 0; index < personas.length; index += 1) {
    base.push(deepSeekRoleTool(personas[index], sources[index]))
  }
  return `${base.join('\n')}\n`
}

function renderDeepSeekHeadlessPatch(personas, sources) {
  deepSeekRoleTool.personaIds = personas.map(persona => persona.id.replaceAll('-', '_'))
  const entries = personas.map((persona, index) => (
    indentBlock(deepSeekRoleTool(persona, sources[index]), 2)
  ))
  return `# Load with: dsh --profile headless --patch <this-file> <task>\n- insert:\n${entries.join('\n')}\n`
}

const INHERITED_PROVIDER_TEXT = Object.freeze({
  omp: Object.freeze({
    display: 'OMP',
    invocation: '/skill:autoprompt <mission>',
    version: '17.4.0',
    mechanism: 'native markdown subagents with explicit `spawns` allowlists',
    activation: 'OMP discovers the installed skill and `ap-*` agent files from its agent directory. The native `spawns` lists enforce canonical child edges and OMP enforces the recursion ceiling.',
    frontmatter: ['user-invocable: true', 'disable-model-invocation: true'],
  }),
  deepseek: Object.freeze({
    display: 'DeepSeek Harness',
    invocation: '/autoprompt <mission>',
    version: '0.1.0-rc.7',
    mechanism: 'fixed-persona `dsh-tool-subagent` instances in the Autoprompt agent preset',
    activation: 'Select the Autoprompt agent preset for Web sessions. For headless runs, pass the installed `headless.patch.yml` with `--patch`. Each role tool denies non-allowlisted role tools and uses a depth ceiling of four.',
    frontmatter: ['user-invocable: true', 'disable-model-invocation: true'],
  }),
  reasonix: Object.freeze({
    display: 'Reasonix',
    invocation: '/autoprompt <mission>',
    version: '1.30.0',
    mechanism: 'native manual `runAs: subagent` skill profiles',
    activation: 'Reasonix discovers the installed top-level skill and `ap-*` subagent profiles from its skill directory. Canonical role prompts define the recursive child edges.',
    frontmatter: ['invocation: manual'],
  }),
})

function inheritedProviderFrontmatter(source, provider) {
  const settings = INHERITED_PROVIDER_TEXT[provider]
  return source.replace(
    /^(---\nname: autoprompt\ndescription: [^\n]+)\n---/,
    `$1\n${settings.frontmatter.join('\n')}\n---`,
  )
}

function renderInheritedProviderText(file, source, provider) {
  const settings = INHERITED_PROVIDER_TEXT[provider]
  let output = asciiDashes(source)
    .replaceAll('OpenCode', settings.display)
    .replaceAll('opencode', provider)
    .replaceAll('OPENCODE_CONFIG', `${provider.toUpperCase()}_CONFIG`)
  if (file === 'SKILL.md') {
    output = inheritedProviderFrontmatter(output, provider)
    output = output.replace(
      'Invoke /autoprompt to turn a mission',
      `Invoke ${settings.invocation.split(' ')[0]} to turn a mission`,
    )
    output = replaceSection(output, `## 8\\. ${escapeRegExp(settings.display)} model and effort`, '## 9\\.', [
      `## 8. ${settings.display} model and effort`,
      '',
      `${settings.display} uses ${settings.mechanism}. Generated roles omit a model override and inherit the selected parent model. Casting and effort are therefore \`inherited-only\`; \`agents=auto\` and explicit model lists are not routable through this adapter.`,
      '',
      settings.activation,
    ].join('\n'))
    output = replaceSection(output, '## 11\\. Run', '$', [
      '## 11. Run',
      '',
      `Use ${settings.display} ${settings.version} or later and explicitly invoke:`,
      '',
      '```text',
      settings.invocation,
      '```',
      '',
      settings.activation,
    ].join('\n'))
  } else if (file === 'MODES.md') {
    output = replaceSection(output, `### ${escapeRegExp(settings.display)} agent selection and effort`, '## Steering', [
      `### ${settings.display} agent selection and effort`,
      '',
      `${settings.display} casting is \`inherited-only\`: ${settings.mechanism} omit model overrides and inherit the selected parent model.`,
      '',
      '- `agents=off` or omitted: the only routable mode; every role inherits the selected model.',
      '- `agents=auto`, `agents=<comma-list>`, and `agents=auto:<comma-list>`: not routable; record `inherited-only` and never claim a selection applied.',
      '',
      'Record effort as exactly `inherited-only`: omit any effort field and never claim a requested or maximum effort was applied.',
      '',
      settings.activation,
    ].join('\n'))
  } else if (file === 'GATES.md') {
    output = output.replace(
      new RegExp(`${escapeRegExp(settings.display)} agent selection is \`inherited-only\`:[\\s\\S]*?Model and effort never change gates or concurrency\\.`),
      `${settings.display} agent selection is \`inherited-only\`: generated roles omit model overrides and inherit the selected parent model. Model and effort never change gates or concurrency.`,
    )
    output = output.replace(
      /The activation profile pins `subagent_depth = 4`[\s\S]*?These are ceilings, never spawn targets\./,
      `${settings.activation} Runtime nesting limits are ceilings, never spawn targets.`,
    )
  }
  return output.replace(/\n+$/, '\n')
}

function renderInheritedProviderReadme(provider) {
  const settings = INHERITED_PROVIDER_TEXT[provider]
  return [
    `# ${settings.display} package`,
    '',
    `This package targets ${settings.display} ${settings.version}.`,
    '',
    '- [`SKILL.md`](SKILL.md): L0 conductor prompt',
    provider === 'reasonix'
      ? '- [`skills`](skills/): 25 native subagent profiles'
      : '- [`agents`](agents/): 25 generated role definitions',
    '- [`frameworks`](frameworks/): 18 task and gate workflows',
    '- [`GATES.md`](GATES.md), [`MODES.md`](MODES.md), and [`PLAYBOOKS.md`](PLAYBOOKS.md): execution contracts',
    '',
    settings.activation,
    '',
    'Every role inherits the selected parent model. Custom `agents=` model routing is not available.',
    '',
  ].join('\n')
}

const PRIME_ROOT_ALLOWED_CHILDREN = [
  'ap-scope-coordinator',
  'ap-feature-coordinator',
  'ap-sweep-coordinator',
  'ap-preflight-probe',
  'ap-intake',
]

function renderPrimePackage(provider, version) {
  return `${JSON.stringify({
    name: 'autoprompt-prime-agent-adapter',
    version,
    description: 'Native Autoprompt package for Prime Agent.',
    type: 'module',
    keywords: ['pi-package', 'prime-agent', 'autoprompt'],
    peerDependencies: {
      '@earendil-works/pi-coding-agent': provider.packagePeerRange,
    },
    pi: {
      extensions: ['./extensions/autoprompt.ts'],
      skills: ['./skills/autoprompt'],
      prompts: ['./prompts/frameworks'],
    },
  }, null, 2)}\n`
}

function renderPrimeExtension(personas, frameworks) {
  const ids = JSON.stringify(personas.map(persona => persona.id), null, 2)
  const frameworkIds = JSON.stringify(frameworks.map(framework => framework.id), null, 2)
  return [
    'import { createHash } from "node:crypto";',
    'import { readFileSync } from "node:fs";',
    'import { dirname, isAbsolute, join, resolve } from "node:path";',
    'import { fileURLToPath } from "node:url";',
    '',
    'import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";',
    '',
    `export const PERSONA_IDS = Object.freeze(${ids}) as readonly string[];`,
    `export const FRAMEWORK_IDS = Object.freeze(${frameworkIds}) as readonly string[];`,
    '',
    'const INSTANCE_PATTERN = /^[a-z0-9][a-z0-9-]{0,23}$/;',
    'const NONCE_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{7,127}$/;',
    'const SHA256_PATTERN = /^[0-9a-f]{64}$/;',
    'const ENVELOPE_HEADER = "# SEALED AUTOPROMPT DISPATCH ENVELOPE";',
    'const FRAMEWORK_START = "## BEGIN SEALED FRAMEWORK";',
    'const FRAMEWORK_END = "## END SEALED FRAMEWORK";',
    'const TASK_END = "## END BOUNDED TASK";',
    'const PERSONA_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "personas");',
    'const FRAMEWORK_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "prompts", "frameworks");',
    'const PERSONA_PROMPTS = new Map(',
    '  PERSONA_IDS.map((id) => [id, readFileSync(join(PERSONA_ROOT, `${id}.md`), "utf8").replace(/\\r\\n/g, "\\n")]),',
    ');',
    'const FRAMEWORK_PROMPTS = new Map(',
    '  FRAMEWORK_IDS.map((id) => [id, readFileSync(join(FRAMEWORK_ROOT, `${id}.md`), "utf8").replace(/\\r\\n/g, "\\n").trim()]),',
    ');',
    '',
    'interface MissionBinding {',
    '  path: string;',
    '  sha256: string;',
    '  bytes: number;',
    '  nonce: string;',
    '}',
    '',
    'interface DispatchEnvelope {',
    '  persona: string;',
    '  framework: string | null;',
    '  binding: MissionBinding;',
    '}',
    '',
    'export function resolvePersonaId(sessionName: string | undefined): string | undefined {',
    '  if (!sessionName) return undefined;',
    '  for (const persona of PERSONA_IDS) {',
    '    if (sessionName === persona) return persona;',
    '    const prefix = `${persona}--`;',
    '    if (sessionName.startsWith(prefix) && INSTANCE_PATTERN.test(sessionName.slice(prefix.length))) {',
    '      return persona;',
    '    }',
    '  }',
    '  return undefined;',
    '}',
    '',
    'function missionBindingIsCurrent(binding: MissionBinding): boolean {',
    '  if (!isAbsolute(binding.path) || resolve(binding.path) !== binding.path) return false;',
    '  if (!SHA256_PATTERN.test(binding.sha256)) return false;',
    '  if (!Number.isSafeInteger(binding.bytes) || binding.bytes <= 0) return false;',
    '  if (!NONCE_PATTERN.test(binding.nonce)) return false;',
    '  try {',
    '    const payload = readFileSync(binding.path);',
    '    new TextDecoder("utf-8", { fatal: true }).decode(payload);',
    '    return (',
    '      payload.length === binding.bytes',
    '      && createHash("sha256").update(payload).digest("hex") === binding.sha256',
    '    );',
    '  } catch {',
    '    return false;',
    '  }',
    '}',
    '',
    'function parseMissionBinding(value: string): MissionBinding | undefined {',
    '  try {',
    '    const parsed = JSON.parse(value) as Record<string, unknown>;',
    '    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return undefined;',
    '    if (Object.keys(parsed).sort().join(",") !== "bytes,nonce,path,sha256") return undefined;',
    '    if (typeof parsed.path !== "string") return undefined;',
    '    if (typeof parsed.sha256 !== "string") return undefined;',
    '    if (typeof parsed.bytes !== "number") return undefined;',
    '    if (typeof parsed.nonce !== "string") return undefined;',
    '    const binding: MissionBinding = {',
    '      path: parsed.path,',
    '      sha256: parsed.sha256,',
    '      bytes: parsed.bytes,',
    '      nonce: parsed.nonce,',
    '    };',
    '    if (JSON.stringify(binding) !== value || !missionBindingIsCurrent(binding)) return undefined;',
    '    return binding;',
    '  } catch {',
    '    return undefined;',
    '  }',
    '}',
    '',
    'export function validateDispatchEnvelope(',
    '  prompt: string,',
    '  expectedPersona: string,',
    '): DispatchEnvelope | undefined {',
    '  if (typeof prompt !== "string" || !PERSONA_IDS.includes(expectedPersona)) return undefined;',
    '  const lines = prompt.split("\\n");',
    '  if (lines[0] !== ENVELOPE_HEADER) return undefined;',
    '  if (lines[3] !== "MISSION POINTER: read the exact prompt ledger before acting; stop if its hash or byte length differs.") return undefined;',
    '  if (lines[6] !== `AUTOPROMPT_PERSONA: ${expectedPersona}`) return undefined;',
    '  if (lines[9] !== "The extension binds the canonical persona prompt by this allowlisted session name.") return undefined;',
    '  if (lines[10] !== "" || lines[11] !== FRAMEWORK_START) return undefined;',
    '',
    '  const bindingPrefix = "AUTOPROMPT_MISSION_BINDING: ";',
    '  if (!lines[4]?.startsWith(bindingPrefix)) return undefined;',
    '  const binding = parseMissionBinding(lines[4].slice(bindingPrefix.length));',
    '  if (!binding) return undefined;',
    '  if (lines[1] !== `AUTOPROMPT-RUN-MARKER: runtime=prime-agent-adapter-v1 nonce=${binding.nonce} prompt=sha256:${binding.sha256}`) return undefined;',
    '  if (lines[2] !== `RUN-NONCE: ${binding.nonce}`) return undefined;',
    '  if (lines[5] !== `AUTOPROMPT_BINDING_CALL: autoprompt.bind(${JSON.stringify(binding.path)}, nonce=${JSON.stringify(binding.nonce)})`) return undefined;',
    '',
    '  const frameworkPrefix = "AUTOPROMPT_FRAMEWORK: ";',
    '  if (!lines[7]?.startsWith(frameworkPrefix)) return undefined;',
    '  const frameworkValue = lines[7].slice(frameworkPrefix.length);',
    '  const framework = frameworkValue === "none" ? null : frameworkValue;',
    '  if (framework !== null && !FRAMEWORK_IDS.includes(framework)) return undefined;',
    '',
    '  const depth = /^AUTOPROMPT_RUNTIME_DEPTH: parent=([0-3]) child=([1-4])$/.exec(lines[8] ?? "");',
    '  if (!depth || Number(depth[2]) !== Number(depth[1]) + 1) return undefined;',
    '',
    '  const frameworkEnd = lines.indexOf(FRAMEWORK_END, 12);',
    '  if (frameworkEnd < 12 || lines[frameworkEnd + 1] !== "") return undefined;',
    '  const expectedFrameworkText = framework === null ? "" : FRAMEWORK_PROMPTS.get(framework);',
    '  if (expectedFrameworkText === undefined) return undefined;',
    '  if (lines.slice(12, frameworkEnd).join("\\n") !== expectedFrameworkText) return undefined;',
    '',
    '  const taskHeader = /^## BEGIN BOUNDED TASK \\(utf8-bytes=([1-9][0-9]*)\\)$/.exec(lines[frameworkEnd + 2] ?? "");',
    '  if (!taskHeader || lines.at(-1) !== TASK_END) return undefined;',
    '  const task = lines.slice(frameworkEnd + 3, -1).join("\\n");',
    '  if (Buffer.byteLength(task, "utf8") !== Number(taskHeader[1])) return undefined;',
    '  return { persona: expectedPersona, framework, binding };',
    '}',
    '',
    'function sameAdmission(left: DispatchEnvelope, right: DispatchEnvelope): boolean {',
    '  return (',
    '    left.persona === right.persona',
    '    && left.framework === right.framework',
    '    && JSON.stringify(left.binding) === JSON.stringify(right.binding)',
    '  );',
    '}',
    '',
    'function deniedSystemPrompt(base: string, sessionName: string): string {',
    '  return [',
    '    base,',
    '    "",',
    '    "# AUTOPROMPT PERSONA ACTIVATION DENIED",',
    '    `Session ${JSON.stringify(sessionName)} has an ap-* name but no valid sealed Autoprompt dispatch envelope.`,',
    '    "No canonical Autoprompt persona was loaded. Treat this as an unmanaged Prime Agent session.",',
    '  ].join("\\n");',
    '}',
    '',
    'export default function autopromptExtension(pi: ExtensionAPI) {',
    '  const admissions = new Map<string, DispatchEnvelope>();',
    '  pi.on("before_agent_start", async (event, ctx) => {',
    '    const sessionName = ctx.sessionManager.getSessionName();',
    '    const persona = resolvePersonaId(sessionName);',
    '    if (!persona) return undefined;',
    '    const sessionId = ctx.sessionManager.getSessionId();',
    '    const candidate = validateDispatchEnvelope(event.prompt, persona);',
    '    const previous = admissions.get(sessionId);',
    '    const resemblesEnvelope = event.prompt.startsWith(`${ENVELOPE_HEADER}\\n`)',
    '      || event.prompt.includes("AUTOPROMPT-RUN-MARKER:");',
    '    let admission: DispatchEnvelope | undefined;',
    '    if (candidate) {',
    '      if (previous && !sameAdmission(previous, candidate)) admissions.delete(sessionId);',
    '      admissions.set(sessionId, candidate);',
    '      admission = candidate;',
    '    } else if (previous && !resemblesEnvelope && missionBindingIsCurrent(previous.binding)) {',
    '      admission = previous;',
    '    }',
    '    if (!admission || admission.persona !== persona) {',
    '      admissions.delete(sessionId);',
    '      return { systemPrompt: deniedSystemPrompt(event.systemPrompt, sessionName ?? persona) };',
    '    }',
    '    const canonicalPrompt = PERSONA_PROMPTS.get(persona);',
    '    if (!canonicalPrompt) return undefined;',
    '    return {',
    '      systemPrompt: [',
    '        event.systemPrompt,',
    '        "",',
    '        "# SEALED AUTOPROMPT PERSONA",',
    '        `AUTOPROMPT_PERSONA: ${persona}`,',
    '        `AUTOPROMPT_ADMISSION: nonce=${admission.binding.nonce} prompt=sha256:${admission.binding.sha256} framework=${admission.framework ?? "none"}`,',
    '        "This session is an Autoprompt role. Dispatch only through await autoprompt.dispatch(...); the Python adapter derives daemon identity and enforces the canonical child topology.",',
    '        "Never call rlm or rlm.run directly. Omitting a model in the adapter is deliberate: Prime Agent inherits the selected parent model.",',
    '        "",',
    '        canonicalPrompt.trim(),',
    '      ].join("\\n"),',
    '    };',
    '  });',
    '  pi.on("session_shutdown", (_event, ctx) => {',
    '    admissions.delete(ctx.sessionManager.getSessionId());',
    '  });',
    '}',
    '',
  ].join('\n')
}

function renderPrimeSkill(frameworks, canonicalProtocol) {
  const frameworkLinks = frameworks.map(framework =>
    `- \`${framework.id}\`: [${framework.id}.md](../../prompts/frameworks/${framework.id}.md)`,
  )
  return [
    '---',
    'name: autoprompt',
    'description: Run the Autoprompt orchestration loop on Prime Agent through a topology-enforcing native RLM dispatcher. Use only when the user explicitly invokes Autoprompt or asks to run the loop.',
    '---',
    '',
    '# Autoprompt for Prime Agent',
    '',
    'This package targets Prime Agent 0.7.2. Before recursive use, set `rlmMaxDepth` to `4` in Prime Agent settings and start a fresh session so this Python-backed skill and its extension are loaded.',
    '',
    'Start only for an explicit `/autoprompt <mission>` request. A bare invocation reports the recorded frontier and stops; resume requires an explicit `resume` request.',
    '',
    'Before spawning, resolve only undefined operator knobs:',
    '',
    '- **Concurrency:** `tokensaver`, `wide`, or `custom max_subs=N`.',
    '- **Agent selection:** `off`/inherit only. Confirm that every child inherits the already-selected parent model; no per-child model routing selector is available.',
    '',
    'In an attended session, ask all undefined knobs in one question before repository/tool work. In an unattended supervisor run, default missing concurrency to `tokensaver` and agent selection to `off`, then record both assumptions.',
    '',
    'After the chooser, use the native dispatcher to start `ap-scope-coordinator`.',
    '',
    '## Native dispatcher',
    '',
    'Import the installed Python skill in the IPython kernel and route every child through it:',
    '',
    '```python',
    'import autoprompt',
    'binding = autoprompt.bind("PROMPTS.txt", nonce="<RUN-NONCE>")',
    'child = await autoprompt.dispatch(',
    '    "ap-scope-coordinator",',
    '    "Produce the bounded scope and roadmap for the mission.",',
    '    binding=binding,',
    '    framework="plan-scope",',
    ')',
    '```',
    '',
    '`dispatch()` reads `agent_message.list_agents` through Prime Agent\'s host bridge, validates the daemon-derived current identity and parent edge, applies the exact canonical child allowlist, rejects terminal roles, and calls Prime Agent\'s real `rlm()` with `name` only. It never passes `model`, so the child inherits the selected parent model.',
    '',
    '`bind()` reads the exact prompt ledger, requires a valid run nonce, and records its resolved path, SHA-256, and UTF-8 byte length. Every dispatch revalidates those bytes and seals the exact `AUTOPROMPT-RUN-MARKER`, `RUN-NONCE`, mission pointer, and binding recreation call into the child brief. Descendants must recreate the same binding with `autoprompt.bind(...)` before dispatching.',
    '',
    'Use the optional `instance` argument (lowercase letters, digits, and hyphens) when multiple siblings need the same persona. The sealed session name is `<persona>--<instance>`.',
    '',
    'At depth 0, routine dispatch is limited to `ap-scope-coordinator`, `ap-feature-coordinator`, and `ap-sweep-coordinator`. `ap-preflight-probe` and `ap-intake` are diagnostic or legacy-resume exceptions, not routine launches. Every deeper call is checked against the current persona\'s canonical child list. Roles with an empty child list are code-level terminals.',
    '',
    'Prime Agent returns an admission handle from native RLM dispatch. Use its native subagent registry and the bundled `agent_message` skill to observe work and exchange results; do not treat admission as completion.',
    '',
    '## Framework prompt templates',
    '',
    'Pass only one of these allowlisted IDs as `framework`. The dispatcher reads the installed immutable package path and seals the selected text into the child envelope:',
    '',
    ...frameworkLinks,
    '',
    'Preserve the framework gates, strict behavioral RED before implementation, independent review, real verification, >=95% changed-line coverage, negative-verdict repair loops, goal checking, and zero open findings before DONE.',
    '',
    '## Canonical Autoprompt protocol',
    '',
    canonicalProtocol.trim(),
    '',
  ].join('\n')
}

function renderPrimePyproject(version = '1.0.0') {
  return [
    '[project]',
    'name = "autoprompt-prime-dispatch"',
    `version = ${tomlBasicString(version)}`,
    'description = "Topology-enforcing Autoprompt dispatcher for Prime Agent"',
    'requires-python = ">=3.10"',
    'dependencies = []',
    '',
    '[build-system]',
    'requires = ["hatchling"]',
    'build-backend = "hatchling.build"',
    '',
    '[tool.hatch.build.targets.wheel]',
    'packages = ["src/autoprompt"]',
    '',
  ].join('\n')
}

function renderPrimeDispatcher(personas, frameworks) {
  const personaData = JSON.stringify(Object.fromEntries(
    personas.map(persona => [persona.id, persona.allowedChildren]),
  ), null, 2)
  const frameworkData = JSON.stringify(Object.fromEntries(
    frameworks.map(framework => [framework.id, `prompts/frameworks/${framework.id}.md`]),
  ), null, 2)
  const rootChildren = JSON.stringify(PRIME_ROOT_ALLOWED_CHILDREN, null, 2)
  return `"""Native, fail-closed Autoprompt dispatcher for Prime Agent 0.7.2."""

from __future__ import annotations

import re
import hashlib
import json
from dataclasses import dataclass
from pathlib import Path
from types import MappingProxyType
from typing import Any


MAX_DEPTH = 4
_INSTANCE_PATTERN = re.compile(r"^[a-z0-9][a-z0-9-]{0,23}$")
_NONCE_PATTERN = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._-]{7,127}$")
_PACKAGE_ROOT = Path(__file__).resolve().parents[4]
_PERSONA_DATA = ${personaData}
_FRAMEWORK_DATA = ${frameworkData}
PERSONAS = MappingProxyType({key: tuple(value) for key, value in _PERSONA_DATA.items()})
FRAMEWORKS = MappingProxyType(dict(_FRAMEWORK_DATA))
ROOT_ALLOWED_CHILDREN = tuple(${rootChildren})


class DispatchError(RuntimeError):
    """Base error for a rejected Autoprompt dispatch."""


class DispatchDenied(DispatchError):
    """The daemon-derived caller is not allowed to create the requested child."""


class UnknownPersona(DispatchError):
    """The requested persona is outside the sealed canonical registry."""


class UnknownFramework(DispatchError):
    """The requested framework is outside the sealed canonical registry."""


@dataclass(frozen=True, slots=True)
class RunBinding:
    """Verified binding to one exact Autoprompt prompt ledger."""

    path: str
    sha256: str
    bytes: int
    nonce: str


def bind(mission_path: str | Path, *, nonce: str) -> RunBinding:
    """Bind a run nonce to the exact current bytes of its prompt ledger."""
    if not isinstance(nonce, str) or not _NONCE_PATTERN.fullmatch(nonce):
        raise ValueError("nonce must be 8-128 safe characters")
    try:
        target = Path(mission_path).expanduser().resolve(strict=True)
        payload = target.read_bytes()
        payload.decode("utf-8")
    except (OSError, UnicodeError, TypeError) as error:
        raise DispatchDenied("mission binding path must be a readable UTF-8 file") from error
    if not payload:
        raise DispatchDenied("mission binding file must not be empty")
    return RunBinding(
        path=str(target),
        sha256=hashlib.sha256(payload).hexdigest(),
        bytes=len(payload),
        nonce=nonce,
    )


def _validated_binding(binding: Any) -> RunBinding:
    if not isinstance(binding, RunBinding):
        raise DispatchDenied("mission binding must come from autoprompt.bind()")
    if not _NONCE_PATTERN.fullmatch(binding.nonce):
        raise DispatchDenied("mission binding contains an invalid nonce")
    try:
        target = Path(binding.path)
        resolved = target.resolve(strict=True)
        if not target.is_absolute() or resolved != target:
            raise DispatchDenied("mission binding path is not canonical")
        payload = resolved.read_bytes()
        payload.decode("utf-8")
    except DispatchDenied:
        raise
    except (OSError, UnicodeError, TypeError) as error:
        raise DispatchDenied("mission binding path must remain a readable UTF-8 file") from error
    digest = hashlib.sha256(payload).hexdigest()
    if not payload or len(payload) != binding.bytes or digest != binding.sha256:
        raise DispatchDenied("mission binding no longer matches the exact prompt ledger")
    return binding


def _canonical_role(session_name: Any) -> str:
    if not isinstance(session_name, str):
        raise DispatchDenied("daemon identity has no valid session name")
    if session_name in PERSONAS:
        return session_name
    for persona in PERSONAS:
        prefix = f"{persona}--"
        if session_name.startswith(prefix) and _INSTANCE_PATTERN.fullmatch(session_name[len(prefix):]):
            return persona
    raise DispatchDenied(f"daemon identity is not an allowlisted Autoprompt persona: {session_name!r}")


def _validated_identity(roster: Any) -> tuple[str | None, int]:
    if not isinstance(roster, dict):
        raise DispatchDenied("daemon roster is unavailable or malformed")
    current = roster.get("current")
    entries = roster.get("entries")
    if not isinstance(current, dict) or not isinstance(entries, list):
        raise DispatchDenied("daemon roster is unavailable or malformed")
    depth = current.get("depth")
    if isinstance(depth, bool) or not isinstance(depth, int) or depth < 0 or depth > MAX_DEPTH:
        raise DispatchDenied("daemon roster reports an invalid depth")
    if not isinstance(current.get("id"), str) or not current["id"]:
        raise DispatchDenied("daemon roster reports an invalid current id")

    parents = [entry for entry in entries if isinstance(entry, dict) and entry.get("relationship") == "parent"]
    if depth == 0:
        if parents:
            raise DispatchDenied("daemon root unexpectedly reports a parent edge")
        root_name = current.get("name")
        if isinstance(root_name, str) and root_name.startswith("ap-"):
            root_role = _canonical_role(root_name)
            if not PERSONAS[root_role]:
                raise DispatchDenied(f"terminal role {root_role} cannot dispatch children from root depth")
            raise DispatchDenied(f"Autoprompt persona {root_role} cannot occupy daemon root depth")
        return None, depth

    current_role = _canonical_role(current.get("name"))
    if len(parents) != 1:
        raise DispatchDenied("daemon roster must contain exactly one parent edge")
    parent = parents[0]
    if parent.get("depth") != depth - 1 or not isinstance(parent.get("id"), str) or not parent["id"]:
        raise DispatchDenied("daemon roster contains an invalid parent edge")

    if depth == 1:
        if current_role not in ROOT_ALLOWED_CHILDREN:
            raise DispatchDenied(f"parent edge from root to {current_role} is not allowlisted")
    else:
        parent_role = _canonical_role(parent.get("name"))
        if current_role not in PERSONAS[parent_role]:
            raise DispatchDenied(f"parent edge {parent_role} -> {current_role} is not allowlisted")
    return current_role, depth


def _child_name(persona: str, instance: str | None) -> str:
    if instance is None:
        return persona
    if not isinstance(instance, str) or not _INSTANCE_PATTERN.fullmatch(instance):
        raise ValueError("instance must match ^[a-z0-9][a-z0-9-]{0,23}$")
    name = f"{persona}--{instance}"
    if len(name) > 64:
        raise ValueError("Prime Agent child session name must be at most 64 characters")
    return name


def _framework_text(framework: str | None) -> str:
    if framework is None:
        return ""
    relative_path = FRAMEWORKS.get(framework)
    if relative_path is None:
        raise UnknownFramework(f"unknown Autoprompt framework: {framework!r}")
    target = _PACKAGE_ROOT.joinpath(*relative_path.split("/"))
    try:
        return target.read_text(encoding="utf-8").strip()
    except OSError as error:
        raise DispatchError(f"installed framework is unavailable: {framework}") from error


def _sealed_prompt(
    persona: str,
    task: str,
    framework: str | None,
    parent_depth: int,
    binding: RunBinding,
) -> str:
    framework_text = _framework_text(framework)
    framework_id = framework if framework is not None else "none"
    binding_json = json.dumps(
        {
            "path": binding.path,
            "sha256": binding.sha256,
            "bytes": binding.bytes,
            "nonce": binding.nonce,
        },
        ensure_ascii=False,
        separators=(",", ":"),
    )
    return "\\n".join(
        [
            "# SEALED AUTOPROMPT DISPATCH ENVELOPE",
            f"AUTOPROMPT-RUN-MARKER: runtime=prime-agent-adapter-v1 nonce={binding.nonce} prompt=sha256:{binding.sha256}",
            f"RUN-NONCE: {binding.nonce}",
            "MISSION POINTER: read the exact prompt ledger before acting; stop if its hash or byte length differs.",
            f"AUTOPROMPT_MISSION_BINDING: {binding_json}",
            f"AUTOPROMPT_BINDING_CALL: autoprompt.bind({json.dumps(binding.path, ensure_ascii=False)}, nonce={json.dumps(binding.nonce)})",
            f"AUTOPROMPT_PERSONA: {persona}",
            f"AUTOPROMPT_FRAMEWORK: {framework_id}",
            f"AUTOPROMPT_RUNTIME_DEPTH: parent={parent_depth} child={parent_depth + 1}",
            "The extension binds the canonical persona prompt by this allowlisted session name.",
            "",
            "## BEGIN SEALED FRAMEWORK",
            framework_text,
            "## END SEALED FRAMEWORK",
            "",
            f"## BEGIN BOUNDED TASK (utf8-bytes={len(task.encode('utf-8'))})",
            task,
            "## END BOUNDED TASK",
        ]
    )


async def _list_roster() -> dict[str, Any]:
    from rlm import host_request

    return await host_request("agent_message.list_agents")


async def _spawn_child(prompt: str, name: str) -> Any:
    from rlm import rlm as prime_rlm

    # Deliberately omit model: Prime Agent 0.7.2 inherits the selected parent model.
    return await prime_rlm(prompt, name=name)


async def dispatch(
    persona: str,
    task: str,
    *,
    binding: RunBinding,
    framework: str | None = None,
    instance: str | None = None,
) -> Any:
    """Validate topology and spawn one native Prime Agent RLM child."""
    if persona not in PERSONAS:
        raise UnknownPersona(f"unknown Autoprompt persona: {persona!r}")
    if not isinstance(task, str) or not task.strip():
        raise ValueError("task must be a non-empty string")
    if framework is not None and framework not in FRAMEWORKS:
        raise UnknownFramework(f"unknown Autoprompt framework: {framework!r}")
    binding = _validated_binding(binding)
    name = _child_name(persona, instance)
    current_role, depth = _validated_identity(await _list_roster())
    if depth >= MAX_DEPTH:
        raise DispatchDenied(f"Autoprompt depth limit reached at depth {depth}")

    if current_role is None:
        allowed = ROOT_ALLOWED_CHILDREN
    else:
        allowed = PERSONAS[current_role]
        if not allowed:
            raise DispatchDenied(f"terminal role {current_role} cannot dispatch children")
    if persona not in allowed:
        caller = "root" if current_role is None else current_role
        raise DispatchDenied(f"child edge {caller} -> {persona} is not allowlisted")

    prompt = _sealed_prompt(persona, task, framework, depth, binding)
    return await _spawn_child(prompt, name)


async def run(
    persona: str,
    task: str,
    *,
    binding: RunBinding,
    framework: str | None = None,
    instance: str | None = None,
) -> Any:
    """Callable-skill alias for :func:\`dispatch\`."""
    return await dispatch(persona, task, binding=binding, framework=framework, instance=instance)
`
}

function renderOutputs(root = ROOT) {
  const contract = JSON.parse(read('agents/contracts/autoprompt.contract.json', root))
  const outputs = new Map()
  const personaIds = new Set(contract.personas.map(persona => persona.id))
  const personaSources = contract.personas.map(persona => read(persona.source, root))

  for (let index = 0; index < contract.personas.length; index += 1) {
    const persona = contract.personas[index]
    const source = personaSources[index]
    outputs.set(`agents/claude/agents/${persona.id}.md`, source)
    outputs.set(`agents/codex/agents/${persona.id}.toml`, renderCodexAgent(persona, source))
    outputs.set(`agents/opencode/agents/${persona.id}.md`, renderOpencodeAgent(persona, source))
    outputs.set(`agents/kilo/agents/${persona.id}.md`, renderOpencodeAgent(persona, source))
    outputs.set(
      `agents/vscode/agents/${persona.id}.agent.md`,
      renderVsCodeAgent(persona, source, personaIds),
    )
    outputs.set(`agents/grok/agents/${persona.id}.md`, renderGrokAgent(persona, source, personaIds))
    outputs.set(`agents/prime/personas/${persona.id}.md`, stripFrontmatter(source))
    outputs.set(`agents/omp/agents/${persona.id}.md`, renderOmpAgent(persona, source))
    outputs.set(`agents/deepseek/agents/${persona.id}.md`, renderDeepSeekAgent(persona, source))
    outputs.set(
      `agents/reasonix/skills/${persona.id}/SKILL.md`,
      renderReasonixAgent(persona, source),
    )
  }
  for (const framework of contract.frameworks) {
    const body = read(framework.source, root).replace(/^RUN-NONCE:.*\n+/, '')
    outputs.set(`agents/claude/frameworks/${framework.id}.md`, body)
    outputs.set(`agents/codex/frameworks/${framework.id}.md`, body)
    outputs.set(`agents/opencode/frameworks/${framework.id}.md`, body)
    outputs.set(`agents/kilo/frameworks/${framework.id}.md`, body)
    outputs.set(`agents/vscode/frameworks/${framework.id}.md`, asciiDashes(body))
    outputs.set(`agents/grok/frameworks/${framework.id}.md`, asciiDashes(body))
    outputs.set(`agents/prime/prompts/frameworks/${framework.id}.md`, [
      '---',
      `description: ${yamlDoubleQuoted(`Autoprompt ${framework.id} framework`)}`,
      '---',
      body,
    ].join('\n'))
    outputs.set(`agents/omp/frameworks/${framework.id}.md`, asciiDashes(body))
    outputs.set(`agents/deepseek/frameworks/${framework.id}.md`, asciiDashes(body))
    outputs.set(`agents/reasonix/frameworks/${framework.id}.md`, asciiDashes(body))
  }

  for (const file of ['SKILL.md', 'GATES.md', 'MODES.md', 'PLAYBOOKS.md']) {
    outputs.set(
      `agents/kilo/${file}`,
      renderKiloProviderText(read(`agents/opencode/${file}`, root)),
    )
  }
  outputs.set('agents/kilo/autoprompt.kilo.json', renderKiloProfile())

  for (const file of ['SKILL.md', 'GATES.md', 'MODES.md', 'PLAYBOOKS.md']) {
    outputs.set(
      `agents/vscode/${file}`,
      renderVsCodeProviderText(file, read(`agents/opencode/${file}`, root), contract.providers.vscode),
    )
  }
  outputs.set('agents/vscode/README.md', renderVsCodeReadme(contract.providers.vscode))

  for (const file of ['SKILL.md', 'GATES.md', 'MODES.md', 'PLAYBOOKS.md']) {
    outputs.set(
      `agents/grok/${file}`,
      renderGrokProviderText(file, read(`agents/opencode/${file}`, root)),
    )
  }
  outputs.set('agents/grok/README.md', renderGrokReadme(contract.providers.grok))
  outputs.set('agents/grok/autoprompt.grok.toml', renderGrokProfile(contract.personas, contract.frameworks))
  outputs.set(
    'agents/grok/workflow/autoprompt-topology.json',
    renderGrokTopology(contract.personas, contract.frameworks),
  )

  for (const provider of ['omp', 'deepseek', 'reasonix']) {
    for (const file of ['SKILL.md', 'GATES.md', 'MODES.md', 'PLAYBOOKS.md']) {
      outputs.set(
        `agents/${provider}/${file}`,
        renderInheritedProviderText(file, read(`agents/opencode/${file}`, root), provider),
      )
    }
    outputs.set(`agents/${provider}/README.md`, renderInheritedProviderReadme(provider))
  }
  outputs.set(
    'agents/deepseek/agent-preset/agent.cordis.yml',
    renderDeepSeekPreset(contract.personas, personaSources),
  )
  outputs.set('agents/deepseek/agent-preset/preset.yml', [
    'name: Autoprompt',
    'description: Useful-first orchestration with 25 fixed-persona subagent tools.',
    '',
  ].join('\n'))
  outputs.set(
    'agents/deepseek/headless.patch.yml',
    renderDeepSeekHeadlessPatch(contract.personas, personaSources),
  )

  const packageVersion = JSON.parse(read('package.json', root)).version
  for (const provider of [
    'claude', 'codex', 'opencode', 'kilo', 'grok', 'vscode', 'omp', 'deepseek', 'reasonix',
  ]) {
    outputs.set(`agents/${provider}/VERSION`, `${packageVersion}\n`)
  }
  outputs.set('agents/prime/package.json', renderPrimePackage(contract.providers.prime, packageVersion))
  outputs.set('agents/prime/extensions/autoprompt.ts', renderPrimeExtension(contract.personas, contract.frameworks))
  outputs.set(
    'agents/prime/skills/autoprompt/SKILL.md',
    renderPrimeSkill(contract.frameworks, read('agents/contracts/generic.md', root)),
  )
  outputs.set('agents/prime/skills/autoprompt/pyproject.toml', renderPrimePyproject(packageVersion))
  outputs.set(
    'agents/prime/skills/autoprompt/src/autoprompt/__init__.py',
    renderPrimeDispatcher(contract.personas, contract.frameworks),
  )

  return outputs
}

function differingOutputs(outputs, root = ROOT) {
  const differing = []
  for (const [relativePath, expected] of outputs) {
    const target = path.join(root, relativePath)
    const actual = fs.existsSync(target)
      ? fs.readFileSync(target, 'utf8').replace(/\r\n/g, '\n')
      : null
    if (actual !== expected) differing.push(relativePath)
  }
  return differing
}

function run(argv, root = ROOT, io = process) {
  const check = argv.includes('--check')
  if (argv.some(argument => argument !== '--check')) {
    io.stderr.write('generate-provider-contracts: only --check is supported\n')
    return 2
  }
  const outputs = renderOutputs(root)
  const differing = differingOutputs(outputs, root)
  if (check) {
    if (differing.length) {
      io.stderr.write(`generate-provider-contracts: stale outputs: ${differing.join(', ')}\n`)
      return 1
    }
    io.stdout.write('provider contracts are current\n')
    return 0
  }
  for (const [relativePath, content] of outputs) writeAtomic(relativePath, content, root)
  io.stdout.write(`generated ${outputs.size} provider contract files\n`)
  return 0
}

if (require.main === module) process.exitCode = run(process.argv.slice(2))

module.exports = {
  differingOutputs,
  renderCodexAgent,
  renderGrokAgent,
  renderGrokProfile,
  renderGrokProviderText,
  renderGrokReadme,
  renderGrokTopology,
  renderKiloProfile,
  renderKiloProviderText,
  renderDeepSeekAgent,
  renderDeepSeekHeadlessPatch,
  renderDeepSeekPreset,
  renderInheritedProviderReadme,
  renderInheritedProviderText,
  renderOmpAgent,
  renderOpencodeAgent,
  renderOutputs,
  renderPrimeDispatcher,
  renderPrimeExtension,
  renderPrimePackage,
  renderPrimePyproject,
  renderPrimeSkill,
  renderReasonixAgent,
  renderVsCodeAgent,
  renderVsCodeProviderText,
  renderVsCodeReadme,
  run,
  writeAtomic,
}
