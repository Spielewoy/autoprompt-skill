'use strict'

// Dependency-free closed tool schemas shared by the host receipt boundary and
// the isolated Grok worker. Keep this leaf free of filesystem and controller
// imports so a sandbox never needs the wider host runtime merely to validate
// MCP arguments.
const OUTPUT_LIMIT = 1024 * 1024
class BoundaryError extends Error {
  constructor(code, message) { super(message); this.name = 'BoundaryError'; this.code = code }
}
function fail(code, message) { throw new BoundaryError(code, message) }
function schema(properties, required) { return { type: 'object', properties, required, additionalProperties: false } }
const text = { type: 'string' }, integer = { type: 'integer', minimum: 1 }
const TOOLS = Object.freeze([
  { name: 'read', description: 'Read a bounded text range from an assigned physical file.', inputSchema: schema({ path: text, startLine: integer, lineCount: { ...integer, maximum: 5000 } }, ['path']) },
  { name: 'list', description: 'List an assigned directory without following links.', inputSchema: schema({ path: text }, ['path']) },
  { name: 'search', description: 'Find literal text in assigned files; no regular-expression execution.', inputSchema: schema({ path: text, text, maxResults: { ...integer, maximum: 200 } }, ['path', 'text']) },
  { name: 'write', description: 'Atomically write an explicitly authorized task or checker scratch file.', inputSchema: schema({ path: text, content: text }, ['path', 'content']) },
  { name: 'edit', description: 'Replace exact text in an authorized file. Ambiguous matches fail.', inputSchema: schema({ path: text, oldText: text, newText: text, replaceAll: { type: 'boolean' } }, ['path', 'oldText', 'newText']) },
  { name: 'bash', description: 'Run a foreground command in the assigned OS sandbox with no outbound network or host credentials.', inputSchema: schema({ command: text, cwd: text, timeoutMs: { ...integer, maximum: 300000 } }, ['command']) },
])
function validateArguments(name, args) {
  const tool = TOOLS.find(item => item.name === name)
  if (!tool) fail('TOOL_DENIED', 'The controller does not expose that tool')
  if (!args || typeof args !== 'object' || Array.isArray(args) || Object.keys(args).some(key => !Object.hasOwn(tool.inputSchema.properties, key)) ||
      tool.inputSchema.required.some(key => !Object.hasOwn(args, key))) fail('TOOL_ARGUMENTS_INVALID', 'Tool arguments do not match the fixed schema')
  for (const [key, value] of Object.entries(args)) {
    const spec = tool.inputSchema.properties[key]
    if ((spec.type === 'string' && (typeof value !== 'string' || value.includes('\0') || Buffer.byteLength(value) > 4 * OUTPUT_LIMIT)) ||
        (spec.type === 'boolean' && typeof value !== 'boolean') ||
        (spec.type === 'integer' && (!Number.isSafeInteger(value) || value < spec.minimum || value > (spec.maximum || Number.MAX_SAFE_INTEGER)))) fail('TOOL_ARGUMENTS_INVALID', `Invalid ${key} argument`)
  }
  return tool
}

module.exports = { BoundaryError, OUTPUT_LIMIT, TOOLS, validateArguments }
