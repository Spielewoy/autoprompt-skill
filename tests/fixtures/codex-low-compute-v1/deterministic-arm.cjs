'use strict'

const fs = require('node:fs')
const path = require('node:path')

if (process.env.AUTOPROMPT_MECHANISM_EVIDENCE_CLASS !== 'harness-mechanics-only') throw new Error('deterministic arm cannot run as scored evidence')
const workspace = process.env.AUTOPROMPT_MECHANISM_WORKSPACE
if (!workspace || !process.env.AUTOPROMPT_MECHANISM_SOURCE_SHA || !process.env.AUTOPROMPT_MECHANISM_ARM_ID) throw new Error('mechanism bindings are missing')
const implementation = `'use strict'\n\nfunction normalizeTags(tags) {\n  const seen = new Set()\n  const result = []\n  for (const tag of tags) {\n    const normalized = tag.trim()\n    if (!normalized || seen.has(normalized)) continue\n    seen.add(normalized)\n    result.push(normalized)\n  }\n  return result\n}\n\nmodule.exports = { normalizeTags }\n`
fs.writeFileSync(path.join(workspace, 'index.cjs'), implementation)
