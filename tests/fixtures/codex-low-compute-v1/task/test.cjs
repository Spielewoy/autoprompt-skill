'use strict'

const assert = require('node:assert/strict')
const test = require('node:test')
const { normalizeTags } = require('./index.cjs')

test('normalizeTags trims, removes empties and exact duplicates, and preserves first-seen order', () => {
  assert.deepEqual(normalizeTags([' beta ', '', 'alpha', 'beta', ' alpha ', 'ALPHA', '   ']), ['beta', 'alpha', 'ALPHA'])
})
