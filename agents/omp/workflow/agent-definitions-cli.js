#!/usr/bin/env node
'use strict'

const fs = require('node:fs')
const path = require('node:path')

function parseFrontmatter(text, filePath) {
  const fields = {}
  for (const line of text.split(/\r?\n/)) {
    if (!line.trim()) continue
    const separator = line.indexOf(':')
    if (separator < 1) throw new Error(`agent definition has invalid frontmatter: ${filePath}`)
    const key = line.slice(0, separator).trim()
    let value = line.slice(separator + 1).trim()
    if ((value.startsWith('"') && value.endsWith('"')) ||
        (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1)
    }
    fields[key] = value
  }
  return fields
}

function parseAgentDefinition(filePath) {
  const content = fs.readFileSync(filePath, 'utf8')
  const match = content.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n([\s\S]*)$/)
  if (!match) throw new Error(`agent definition has invalid frontmatter: ${filePath}`)

  const frontmatter = parseFrontmatter(match[1], filePath)
  const name = frontmatter && frontmatter.name
  if (typeof name !== 'string' || !/^ap-[a-z0-9-]+$/.test(name)) {
    throw new Error(`agent definition has invalid name: ${filePath}`)
  }

  const tools = typeof frontmatter.tools === 'string'
    ? frontmatter.tools.split(',').map(tool => tool.trim()).filter(Boolean)
    : frontmatter.tools
  if (!Array.isArray(tools) || tools.length === 0) {
    throw new Error(`agent definition has no tools: ${filePath}`)
  }

  const privatePersonaPath = path.resolve(filePath)
  const activationTools = tools.includes('Read') ? tools : ['Read', ...tools]
  return [name, {
    description: String(frontmatter.description || ''),
    prompt: [
      'Internal Autoprompt role; invalid outside an explicit Autoprompt run.',
      `Read and obey the complete private persona at: ${privatePersonaPath}`,
      'Before any other action, require its exact AUTOPROMPT-RUN-MARKER,',
      'RUN-NONCE, and mission binding. If absent or the persona is unreadable,',
      'return INVALID-DISPATCH and stop. Never load or invoke the Autoprompt skill.',
    ].join(' '),
    tools: activationTools,
    model: String(frontmatter.model || 'inherit'),
  }]
}

function loadAgentDefinitions(directory) {
  const files = fs.readdirSync(directory)
    .filter(name => /^ap-.*\.md$/.test(name))
    .sort()
  if (files.length === 0) throw new Error(`no ap-* agent definitions found: ${directory}`)

  return Object.fromEntries(files.map(name => parseAgentDefinition(path.join(directory, name))))
}

function main(argv) {
  if (argv.length !== 1 || !argv[0]) {
    throw new Error('usage: agent-definitions-cli.js <private-agents-directory>')
  }
  process.stdout.write(JSON.stringify(loadAgentDefinitions(path.resolve(argv[0]))))
}

if (require.main === module) {
  try {
    main(process.argv.slice(2))
  } catch (error) {
    process.stderr.write(`agent-definitions-cli: ${error.message}\n`)
    process.exitCode = 1
  }
}

module.exports = { loadAgentDefinitions, main, parseAgentDefinition }
