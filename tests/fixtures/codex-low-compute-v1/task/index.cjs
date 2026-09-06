'use strict'

function normalizeTags(tags) {
  return tags.map(tag => tag.trim())
}

module.exports = { normalizeTags }
