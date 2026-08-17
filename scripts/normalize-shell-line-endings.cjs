'use strict'

const fs = require('node:fs')
const path = require('node:path')

const ROOT = path.resolve(__dirname, '..')
const SEARCH_ROOTS = ['agents', 'scripts']

function shellFiles(directory) {
  if (!fs.existsSync(directory)) return []
  return fs.readdirSync(directory, { withFileTypes: true }).flatMap(entry => {
    const target = path.join(directory, entry.name)
    if (entry.isDirectory()) return shellFiles(target)
    return entry.isFile() && entry.name.endsWith('.sh') ? [target] : []
  })
}

let changed = 0
for (const relativeRoot of SEARCH_ROOTS) {
  for (const file of shellFiles(path.join(ROOT, relativeRoot))) {
    const original = fs.readFileSync(file)
    const normalized = Buffer.from(original.toString('utf8').replace(/\r\n?/g, '\n'))
    if (!original.equals(normalized)) {
      fs.writeFileSync(file, normalized)
      changed += 1
    }
  }
}

console.log(`Shell line endings ready (${changed} normalized).`)
