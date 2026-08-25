#!/usr/bin/env node
'use strict'

// Deliberately small, dependency-free JSON Schema 2020-12 evaluator for the
// closed keyword set used by the bundled AutoPrompt contracts. Provider
// transport schemas cannot validate JSON encoded inside canonicalJson, so the
// runtime must evaluate the decoded value before treating it as canonical.

function sameValue(left, right) {
  return JSON.stringify(left) === JSON.stringify(right)
}

function instanceType(value) {
  if (value === null) return 'null'
  if (Array.isArray(value)) return 'array'
  if (Number.isInteger(value)) return 'integer'
  if (typeof value === 'number') return 'number'
  return typeof value
}

function pointerResolve(root, reference) {
  if (reference === '#') return root
  if (typeof reference !== 'string' || !reference.startsWith('#/')) return null
  return reference.slice(2).split('/').reduce((value, segment) => {
    const key = segment.replace(/~1/g, '/').replace(/~0/g, '~')
    return value && typeof value === 'object' ? value[key] : undefined
  }, root)
}

function dateTime(value) {
  return typeof value === 'string' &&
    /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/u.test(value) &&
    Number.isFinite(Date.parse(value))
}

function validateJsonSchema(schema, value) {
  if (!schema || typeof schema !== 'object' || Array.isArray(schema)) {
    return { valid: false, errors: [{ path: '$', keyword: 'schema', message: 'schema must be an object' }] }
  }
  const root = schema

  function visit(currentSchema, currentValue, valuePath) {
    if (currentSchema === true) return { errors: [], evaluated: new Set() }
    if (currentSchema === false || !currentSchema || typeof currentSchema !== 'object') {
      return { errors: [{ path: valuePath, keyword: 'falseSchema', message: 'value is denied' }], evaluated: new Set() }
    }
    if (currentSchema.$ref) {
      const resolved = pointerResolve(root, currentSchema.$ref)
      if (!resolved) {
        return { errors: [{ path: valuePath, keyword: '$ref', message: `unresolved reference ${currentSchema.$ref}` }], evaluated: new Set() }
      }
      return visit(resolved, currentValue, valuePath)
    }

    const errors = []
    const evaluated = new Set()
    const add = (keyword, message, childPath = valuePath) => errors.push({ path: childPath, keyword, message })
    const actualType = instanceType(currentValue)
    if (currentSchema.type !== undefined) {
      const allowed = Array.isArray(currentSchema.type) ? currentSchema.type : [currentSchema.type]
      const matches = allowed.includes(actualType) || (actualType === 'integer' && allowed.includes('number'))
      if (!matches) add('type', `expected ${allowed.join('|')}, received ${actualType}`)
    }
    if (Object.hasOwn(currentSchema, 'const') && !sameValue(currentValue, currentSchema.const)) add('const', 'value differs from const')
    if (Array.isArray(currentSchema.enum) && !currentSchema.enum.some(item => sameValue(item, currentValue))) add('enum', 'value is not in enum')

    if (typeof currentValue === 'string') {
      if (Number.isInteger(currentSchema.minLength) && currentValue.length < currentSchema.minLength) add('minLength', 'string is too short')
      if (Number.isInteger(currentSchema.maxLength) && currentValue.length > currentSchema.maxLength) add('maxLength', 'string is too long')
      if (typeof currentSchema.pattern === 'string' && !new RegExp(currentSchema.pattern, 'u').test(currentValue)) add('pattern', 'string does not match pattern')
      if (currentSchema.format === 'date-time' && !dateTime(currentValue)) add('format', 'string is not an RFC3339 date-time')
    }
    if (typeof currentValue === 'number') {
      if (Number.isFinite(currentSchema.minimum) && currentValue < currentSchema.minimum) add('minimum', 'number is below minimum')
      if (Number.isFinite(currentSchema.maximum) && currentValue > currentSchema.maximum) add('maximum', 'number is above maximum')
    }
    if (Array.isArray(currentValue)) {
      if (Number.isInteger(currentSchema.minItems) && currentValue.length < currentSchema.minItems) add('minItems', 'array has too few items')
      if (Number.isInteger(currentSchema.maxItems) && currentValue.length > currentSchema.maxItems) add('maxItems', 'array has too many items')
      if (currentSchema.uniqueItems === true) {
        const keys = currentValue.map(item => JSON.stringify(item))
        if (new Set(keys).size !== keys.length) add('uniqueItems', 'array items are not unique')
      }
      if (currentSchema.items && typeof currentSchema.items === 'object') {
        currentValue.forEach((item, index) => {
          const child = visit(currentSchema.items, item, `${valuePath}[${index}]`)
          errors.push(...child.errors)
        })
      }
      if (currentSchema.contains && typeof currentSchema.contains === 'object' &&
          !currentValue.some(item => visit(currentSchema.contains, item, valuePath).errors.length === 0)) {
        add('contains', 'array has no item matching the required schema')
      }
    }
    if (currentValue && typeof currentValue === 'object' && !Array.isArray(currentValue)) {
      const properties = currentSchema.properties && typeof currentSchema.properties === 'object'
        ? currentSchema.properties : {}
      for (const required of currentSchema.required || []) {
        if (!Object.hasOwn(currentValue, required)) add('required', `missing required property ${required}`, `${valuePath}.${required}`)
      }
      const propertyCount = Object.keys(currentValue).length
      if (Number.isInteger(currentSchema.minProperties) && propertyCount < currentSchema.minProperties) {
        add('minProperties', 'object has too few properties')
      }
      if (Number.isInteger(currentSchema.maxProperties) && propertyCount > currentSchema.maxProperties) {
        add('maxProperties', 'object has too many properties')
      }
      if (currentSchema.propertyNames && typeof currentSchema.propertyNames === 'object') {
        for (const name of Object.keys(currentValue)) {
          const child = visit(currentSchema.propertyNames, name, `${valuePath}.${name}`)
          errors.push(...child.errors.map(error => ({ ...error, keyword: `propertyNames/${error.keyword}` })))
        }
      }
      for (const [name, propertySchema] of Object.entries(properties)) {
        if (!Object.hasOwn(currentValue, name)) continue
        evaluated.add(name)
        const child = visit(propertySchema, currentValue[name], `${valuePath}.${name}`)
        errors.push(...child.errors)
      }
      if (currentSchema.additionalProperties === false) {
        for (const name of Object.keys(currentValue)) {
          if (!Object.hasOwn(properties, name)) add('additionalProperties', `unexpected property ${name}`, `${valuePath}.${name}`)
        }
      } else if (currentSchema.additionalProperties && typeof currentSchema.additionalProperties === 'object') {
        for (const name of Object.keys(currentValue)) {
          if (Object.hasOwn(properties, name)) continue
          evaluated.add(name)
          const child = visit(currentSchema.additionalProperties, currentValue[name], `${valuePath}.${name}`)
          errors.push(...child.errors)
        }
      }
    }

    if (Array.isArray(currentSchema.allOf)) {
      for (const branch of currentSchema.allOf) {
        const child = visit(branch, currentValue, valuePath)
        errors.push(...child.errors)
        for (const name of child.evaluated) evaluated.add(name)
      }
    }
    if (Array.isArray(currentSchema.oneOf)) {
      const branches = currentSchema.oneOf.map(branch => visit(branch, currentValue, valuePath))
      const valid = branches.filter(branch => branch.errors.length === 0)
      if (valid.length !== 1) add('oneOf', `expected exactly one matching branch, received ${valid.length}`)
      if (valid.length === 1) for (const name of valid[0].evaluated) evaluated.add(name)
    }
    if (currentSchema.not) {
      const denied = visit(currentSchema.not, currentValue, valuePath)
      if (denied.errors.length === 0) add('not', 'value matches denied schema')
    }
    if (currentSchema.if) {
      const condition = visit(currentSchema.if, currentValue, valuePath)
      const selected = condition.errors.length === 0 ? currentSchema.then : currentSchema.else
      if (selected) {
        const child = visit(selected, currentValue, valuePath)
        errors.push(...child.errors)
        for (const name of child.evaluated) evaluated.add(name)
      }
    }
    if (currentSchema.unevaluatedProperties === false && currentValue &&
        typeof currentValue === 'object' && !Array.isArray(currentValue)) {
      for (const name of Object.keys(currentValue)) {
        if (!evaluated.has(name)) add('unevaluatedProperties', `unexpected property ${name}`, `${valuePath}.${name}`)
      }
    }
    return { errors, evaluated }
  }

  const result = visit(schema, value, '$')
  return { valid: result.errors.length === 0, errors: result.errors }
}

module.exports = { validateJsonSchema }
