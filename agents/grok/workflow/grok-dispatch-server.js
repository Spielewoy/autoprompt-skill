#!/usr/bin/env node
'use strict'

// Autoprompt dispatch MCP server for Grok Build.
//
// Grok Build denies `spawn_subagent` to every child session, so Autoprompt roles
// cannot use the native task tool to reach L2..L4. This stdio MCP server exposes
// one tool - `dispatch` - that routes every child through the sealed dispatcher in
// `grok-dispatch.js`. Grok Build namespaces it as `autoprompt__dispatch`; roles
// reach it through the built-in `search_tool` / `use_tool` pair.
//
// The server is a thin transport. Persona, edge, depth, framework, and mission
// binding admission stay in `grok-dispatch.js`, which every front end shares.

const fs = require('node:fs')
const path = require('node:path')
const readline = require('node:readline')

const dispatcher = require('./grok-dispatch.js')

const PROTOCOL_VERSION = '2025-06-18'
const SERVER_NAME = 'autoprompt'
const RUNTIME_ROOT = process.env.AUTOPROMPT_GROK_RUNTIME_ROOT || path.resolve(__dirname, '..')

function serverVersion() {
  try {
    return fs.readFileSync(path.join(RUNTIME_ROOT, 'VERSION'), 'utf8').trim() || '0.0.0'
  } catch {
    return '0.0.0'
  }
}

const JOB_PROPERTIES = Object.freeze({
  persona: {
    type: 'string',
    description: 'Canonical ap-* persona to run, for example ap-scope-coordinator.',
  },
  task: {
    type: 'string',
    description: 'The bounded task brief. Pointers and acceptance criteria only, never the mission text.',
  },
  framework: {
    type: 'string',
    description: 'Optional allowlisted framework id sealed into the child brief.',
  },
  instance: {
    type: 'string',
    description: 'Optional sibling instance suffix: 1-24 lowercase letters, digits, or hyphens.',
  },
  mission: {
    type: 'string',
    description: 'Absolute path to PROMPTS.txt. Optional once the run binding is inherited.',
  },
  nonce: {
    type: 'string',
    description: 'Run nonce. Optional once the run binding is inherited.',
  },
  maxTurns: {
    type: 'integer',
    minimum: 1,
    description: 'Optional turn ceiling for the child process.',
  },
})

// One tool, two shapes: a single job, or a ready group dispatched spawn-all-then-collect.
// Model and effort are deliberately absent - Grok Build casting is inherited-only, so
// the run-wide model and effort travel in the sealed environment, never per role.
const DISPATCH_TOOL = Object.freeze({
  name: 'dispatch',
  description: [
    'Dispatch one Autoprompt persona, or a whole ready group, as sealed Grok Build',
    'child processes. Pass `jobs` to start a group: every job is admitted before any',
    'child starts, the group runs concurrently up to the live-child ceiling, and all',
    'reports are collected together. The dispatcher enforces the canonical child',
    'allowlist, the depth ceiling of 4, the framework registry, and the exact bytes of',
    'the run prompt ledger. Terminal roles and non-allowlisted edges are refused.',
  ].join(' '),
  inputSchema: {
    type: 'object',
    additionalProperties: false,
    properties: {
      ...JOB_PROPERTIES,
      jobs: {
        type: 'array',
        minItems: 1,
        description: 'A ready group to dispatch together instead of one job.',
        items: {
          type: 'object',
          additionalProperties: false,
          required: ['persona', 'task'],
          properties: { ...JOB_PROPERTIES },
        },
      },
    },
  },
})

function textResult(text, isError = false) {
  return { content: [{ type: 'text', text }], isError }
}

function reportOf(result) {
  const header = [
    `persona=${result.admission.persona}`,
    `framework=${result.admission.framework === null ? 'none' : result.admission.framework}`,
    `depth=${result.admission.parentDepth + 1}`,
    `exit=${result.status}`,
  ].join(' ')
  return [header, result.stdout.trim(), result.status === 0 ? '' : result.stderr.trim()]
    .filter(part => part !== '')
    .join('\n\n')
}

async function callDispatch(argumentsValue, options = {}) {
  const request = argumentsValue && typeof argumentsValue === 'object' && !Array.isArray(argumentsValue)
    ? argumentsValue
    : {}
  const dispatchOptions = {
    env: options.env || process.env,
    runtimeRoot: options.runtimeRoot || RUNTIME_ROOT,
    spawn: options.spawn,
    cwd: options.cwd,
  }
  const group = Array.isArray(request.jobs) ? request.jobs : null
  try {
    if (group === null) {
      const result = await dispatcher.dispatch(request, dispatchOptions)
      return textResult(reportOf(result), result.status !== 0)
    }
    const results = await dispatcher.dispatchBatch(group, dispatchOptions)
    return textResult(
      results.map(reportOf).join('\n\n---\n\n'),
      results.some(result => result.status !== 0),
    )
  } catch (error) {
    if (error instanceof dispatcher.DispatchError) {
      return textResult(`${error.code}: ${error.message}`, true)
    }
    return textResult(`AUTOPROMPT_DISPATCH_FAILED: ${error.message}`, true)
  }
}

async function handle(message, options = {}) {
  const id = message && Object.prototype.hasOwnProperty.call(message, 'id') ? message.id : null
  const method = message && message.method
  if (id === null && typeof method === 'string') return null
  if (method === 'initialize') {
    return {
      jsonrpc: '2.0',
      id,
      result: {
        protocolVersion: PROTOCOL_VERSION,
        capabilities: { tools: { listChanged: false } },
        serverInfo: { name: SERVER_NAME, version: serverVersion() },
      },
    }
  }
  if (method === 'ping') return { jsonrpc: '2.0', id, result: {} }
  if (method === 'tools/list') {
    return { jsonrpc: '2.0', id, result: { tools: [DISPATCH_TOOL] } }
  }
  if (method === 'tools/call') {
    const params = message.params || {}
    if (params.name !== DISPATCH_TOOL.name) {
      return {
        jsonrpc: '2.0',
        id,
        error: { code: -32602, message: `unknown tool: ${String(params.name)}` },
      }
    }
    return { jsonrpc: '2.0', id, result: await callDispatch(params.arguments, options) }
  }
  return {
    jsonrpc: '2.0',
    id,
    error: { code: -32601, message: `unsupported method: ${String(method)}` },
  }
}

function serve(input = process.stdin, output = process.stdout, options = {}) {
  const lines = readline.createInterface({ input, crlfDelay: Infinity })
  lines.on('line', line => {
    const trimmed = line.trim()
    if (trimmed === '') return
    let message
    try {
      message = JSON.parse(trimmed)
    } catch {
      output.write(`${JSON.stringify({
        jsonrpc: '2.0',
        id: null,
        error: { code: -32700, message: 'parse error' },
      })}\n`)
      return
    }
    Promise.resolve(handle(message, options)).then(response => {
      if (response !== null) output.write(`${JSON.stringify(response)}\n`)
    })
  })
  return lines
}

if (require.main === module) serve()

module.exports = {
  DISPATCH_TOOL,
  PROTOCOL_VERSION,
  SERVER_NAME,
  callDispatch,
  handle,
  serve,
}
