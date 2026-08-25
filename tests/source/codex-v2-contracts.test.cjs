#!/usr/bin/env node
'use strict'

const assert = require('node:assert/strict')
const crypto = require('node:crypto')
const fs = require('node:fs')
const path = require('node:path')
const test = require('node:test')
const { isDeepStrictEqual } = require('node:util')
const runtimeSettings = require('../../agents/codex/workflow/settings.js')
const runtimeRouter = require('../../agents/codex/workflow/router.js')
const runtimeRouteDecision = require('../../agents/codex/workflow/route-decision.js')

const ROOT = path.resolve(__dirname, '..', '..')
const CONTRACTS = path.join(ROOT, 'agents', 'contracts')
const H = 'a'.repeat(64)
const H2 = 'b'.repeat(64)
const H3 = 'c'.repeat(64)

function readJson(relative) {
  return JSON.parse(fs.readFileSync(path.join(ROOT, relative), 'utf8'))
}

function clone(value) {
  return JSON.parse(JSON.stringify(value))
}

function stableJson(value) {
  if (Array.isArray(value)) return value.map(stableJson)
  if (value === null || typeof value !== 'object') return value
  return Object.fromEntries(Object.keys(value).sort().map(key => [key, stableJson(value[key])]))
}

function aliasEntryHash(record, policy = roles.aliasTelemetrySchema.hashChain) {
  const input = Object.fromEntries(policy.entryHashInputFields.map(field => [field, record[field]]))
  return crypto.createHash('sha256').update(JSON.stringify(stableJson(input))).digest('hex')
}

function parseAliasTelemetryJsonl(text) {
  const lines = text.split('\n')
  const crashTail = !text.endsWith('\n') ? lines.pop() : ''
  const records = lines.filter(Boolean).map(line => JSON.parse(line))
  if (crashTail) {
    try {
      JSON.parse(crashTail)
      records.push(JSON.parse(crashTail))
      return { records, crashTailDetected: false }
    } catch {
      return { records, crashTailDetected: true, crashTail }
    }
  }
  return { records, crashTailDetected: false }
}

function sha256Stable(value) {
  return crypto.createHash('sha256').update(JSON.stringify(stableJson(value))).digest('hex')
}

function accountingEntryHash(record) {
  const { entryHash, ...input } = record
  return sha256Stable(input)
}

function accountingSnapshotHash(snapshot) {
  const { snapshotHash, ...input } = snapshot
  return sha256Stable(input)
}

function totalTokens(values) {
  return Object.values(values.tokenUsage).reduce((sum, value) => sum + value, 0)
}

function accountingValuePaths() {
  return [
    ['launches'], ['retries'], ['sessions'], ['elapsedMilliseconds'], ['costMicrounits'],
    ['tokenUsage', 'noncachedInput'], ['tokenUsage', 'cachedInput'],
    ['tokenUsage', 'output'], ['tokenUsage', 'reasoning'],
  ]
}

function atPath(value, parts) {
  return parts.reduce((current, part) => current[part], value)
}

function accountingSequenceErrors(records, schema) {
  const errors = []
  let previous = null
  for (const record of records) {
    errors.push(...schemaErrors(record, schema).map(error => `schema ${record.sequence}: ${error}`))
    if (record.entryHash !== accountingEntryHash(record)) errors.push(`entry hash ${record.sequence}`)
    if (record.previousHash !== (previous ? previous.entryHash : null)) errors.push(`previous hash ${record.sequence}`)
    if (record.sequence !== (previous ? previous.sequence + 1 : 1)) errors.push(`sequence gap ${record.sequence}`)
    if (previous) {
      for (const field of ['runId', 'activationId', 'activationNonce', 'generation']) {
        if (record[field] !== previous[field]) errors.push(`binding changed ${field}`)
      }
      if (record.stateEventSequence < previous.stateEventSequence) errors.push('state event sequence decreased')
      if (record.stateEventSequence === previous.stateEventSequence && record.stateEventHash !== previous.stateEventHash) {
        errors.push('state event hash changed without a new sequence')
      }
      if (record.monotonicClock.previousObservedMilliseconds !== previous.monotonicClock.observedMilliseconds) {
        errors.push('monotonic clock predecessor mismatch')
      }
      if (record.monotonicClock.observedMilliseconds < previous.monotonicClock.observedMilliseconds) {
        errors.push('monotonic clock rolled back')
      }
    } else if (record.monotonicClock.previousObservedMilliseconds !== null) {
      errors.push('genesis monotonic predecessor must be null')
    }
    for (const pathParts of accountingValuePaths()) {
      const current = atPath(record.cumulative, pathParts)
      const prior = previous ? atPath(previous.cumulative, pathParts) : 0
      if (current < prior) errors.push(`cumulative decreased ${pathParts.join('.')}`)
      if (atPath(record.delta, pathParts) !== current - prior) errors.push(`delta mismatch ${pathParts.join('.')}`)
    }
    previous = record
  }
  return errors
}

function accountingSnapshotErrors(snapshot, schema, lastRecord) {
  const errors = schemaErrors(snapshot, schema)
  if (snapshot.snapshotHash !== accountingSnapshotHash(snapshot)) errors.push('snapshot hash')
  if (snapshot.ceilingContractHash !== sha256Stable(snapshot.ceilings)) errors.push('ceiling contract hash')
  if (snapshot.lastAccountingHash !== lastRecord.entryHash || snapshot.lastAccountingSequence !== lastRecord.sequence) {
    errors.push('snapshot is not bound to the last complete accounting record')
  }
  for (const field of ['runId', 'activationId', 'activationNonce', 'generation', 'stateEventSequence', 'stateEventHash']) {
    if (snapshot[field] !== lastRecord[field]) errors.push(`snapshot binding ${field}`)
  }
  if (!isDeepStrictEqual(snapshot.cumulative, lastRecord.cumulative)) errors.push('snapshot cumulative mismatch')
  if (snapshot.cumulative.elapsedMilliseconds > snapshot.ceilings.wallMilliseconds) errors.push('wall ceiling exceeded')
  if (snapshot.cumulative.sessions > snapshot.ceilings.sessions) errors.push('session ceiling exceeded')
  if (snapshot.cumulative.launches > snapshot.ceilings.launches) errors.push('launch ceiling exceeded')
  if (snapshot.cumulative.retries > snapshot.ceilings.retries) errors.push('retry ceiling exceeded')
  if (snapshot.cumulative.costMicrounits > snapshot.ceilings.costMicrounits) errors.push('cost ceiling exceeded')
  if (totalTokens(snapshot.cumulative) > snapshot.ceilings.totalTokens) errors.push('token ceiling exceeded')
  if (snapshot.ceilings.finalizationReserveMilliseconds >= snapshot.ceilings.wallMilliseconds) {
    errors.push('finalization reserve consumes wall ceiling')
  }
  if (!isDeepStrictEqual(snapshot.monotonicClock, lastRecord.monotonicClock)) errors.push('snapshot clock mismatch')
  return errors
}

function pointer(root, ref) {
  assert.match(ref, /^#\//, `only local schema references are expected: ${ref}`)
  return ref.slice(2).split('/').reduce((value, part) => {
    const key = part.replaceAll('~1', '/').replaceAll('~0', '~')
    return value[key]
  }, root)
}

function schemaErrors(value, schema, root = schema, at = '$') {
  const errors = []
  const evaluatedProperties = (rule, seen = new Set()) => {
    if (typeof rule === 'boolean' || seen.has(rule)) return new Set()
    seen.add(rule)
    if (rule.$ref) return evaluatedProperties(pointer(root, rule.$ref), seen)
    const result = new Set(Object.keys(rule.properties || {}))
    for (const keyword of ['allOf', 'anyOf', 'oneOf']) {
      for (const part of rule[keyword] || []) {
        for (const property of evaluatedProperties(part, new Set(seen))) result.add(property)
      }
    }
    if (rule.if) {
      for (const property of evaluatedProperties(rule.if, new Set(seen))) result.add(property)
      for (const property of evaluatedProperties(rule.then || true, new Set(seen))) result.add(property)
      for (const property of evaluatedProperties(rule.else || true, new Set(seen))) result.add(property)
    }
    return result
  }
  const visit = (current, rule, location) => {
    if (typeof rule === 'boolean') {
      if (!rule) errors.push(`${location}: rejected by false schema`)
      return
    }
    if (rule.$ref) {
      visit(current, pointer(root, rule.$ref), location)
      return
    }
    if (rule.allOf) {
      for (const part of rule.allOf) visit(current, part, location)
    }
    if (rule.anyOf) {
      const passes = rule.anyOf.some((part) => schemaErrors(current, part, root, location).length === 0)
      if (!passes) errors.push(`${location}: no anyOf branch matched`)
    }
    if (rule.oneOf) {
      const passes = rule.oneOf.filter((part) => schemaErrors(current, part, root, location).length === 0)
      if (passes.length !== 1) errors.push(`${location}: expected one oneOf match, got ${passes.length}`)
    }
    if (rule.not && schemaErrors(current, rule.not, root, location).length === 0) {
      errors.push(`${location}: matched forbidden schema`)
    }
    if (rule.if) {
      const condition = schemaErrors(current, rule.if, root, location).length === 0
      if (condition && rule.then) visit(current, rule.then, location)
      if (!condition && rule.else) visit(current, rule.else, location)
    }
    if (Object.hasOwn(rule, 'const') && !isDeepStrictEqual(current, rule.const)) {
      errors.push(`${location}: const mismatch`)
    }
    if (rule.enum && !rule.enum.some((item) => isDeepStrictEqual(item, current))) {
      errors.push(`${location}: value is not in enum`)
    }

    const actualType = current === null
      ? 'null'
      : Array.isArray(current)
        ? 'array'
        : Number.isInteger(current)
          ? 'integer'
          : typeof current
    const allowedTypes = rule.type === undefined
      ? null
      : Array.isArray(rule.type) ? rule.type : [rule.type]
    if (allowedTypes && !allowedTypes.includes(actualType)
      && !(actualType === 'integer' && allowedTypes.includes('number'))) {
      errors.push(`${location}: expected ${allowedTypes.join('|')}, got ${actualType}`)
      return
    }

    if (actualType === 'object') {
      const keys = Object.keys(current)
      for (const required of rule.required || []) {
        if (!Object.hasOwn(current, required)) errors.push(`${location}: missing ${required}`)
      }
      if (rule.minProperties !== undefined && keys.length < rule.minProperties) {
        errors.push(`${location}: too few properties`)
      }
      if (rule.maxProperties !== undefined && keys.length > rule.maxProperties) {
        errors.push(`${location}: too many properties`)
      }
      for (const [key, childRule] of Object.entries(rule.properties || {})) {
        if (Object.hasOwn(current, key)) visit(current[key], childRule, `${location}.${key}`)
      }
      if (rule.propertyNames) {
        for (const key of keys) visit(key, rule.propertyNames, `${location}{${key}}`)
      }
      const known = new Set(Object.keys(rule.properties || {}))
      for (const key of keys.filter((item) => !known.has(item))) {
        if (rule.additionalProperties === false) errors.push(`${location}: unexpected ${key}`)
        else if (rule.additionalProperties && typeof rule.additionalProperties === 'object') {
          visit(current[key], rule.additionalProperties, `${location}.${key}`)
        }
      }
      if (rule.unevaluatedProperties === false) {
        const evaluated = evaluatedProperties(rule)
        for (const key of keys.filter((item) => !evaluated.has(item))) {
          errors.push(`${location}: unevaluated ${key}`)
        }
      }
    }
    if (actualType === 'array') {
      if (rule.minItems !== undefined && current.length < rule.minItems) errors.push(`${location}: too few items`)
      if (rule.maxItems !== undefined && current.length > rule.maxItems) errors.push(`${location}: too many items`)
      if (rule.uniqueItems) {
        for (let i = 0; i < current.length; i += 1) {
          for (let j = i + 1; j < current.length; j += 1) {
            if (isDeepStrictEqual(current[i], current[j])) errors.push(`${location}: duplicate items`)
          }
        }
      }
      if (rule.items) current.forEach((item, index) => visit(item, rule.items, `${location}[${index}]`))
      if (rule.contains && !current.some((item) => schemaErrors(item, rule.contains, root).length === 0)) {
        errors.push(`${location}: contains did not match`)
      }
    }
    if (actualType === 'string') {
      if (rule.minLength !== undefined && current.length < rule.minLength) errors.push(`${location}: string too short`)
      if (rule.maxLength !== undefined && current.length > rule.maxLength) errors.push(`${location}: string too long`)
      if (rule.pattern && !(new RegExp(rule.pattern)).test(current)) errors.push(`${location}: pattern mismatch`)
      if (rule.format === 'date-time') {
        const match = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d+)?(Z|[+-](\d{2}):(\d{2}))$/u.exec(current)
        const parts = match && match.slice(1, 7).map(Number)
        const calendar = parts && new Date(Date.UTC(parts[0], parts[1] - 1, parts[2]))
        const validCalendar = calendar && calendar.getUTCFullYear() === parts[0]
          && calendar.getUTCMonth() === parts[1] - 1 && calendar.getUTCDate() === parts[2]
        const validClock = parts && parts[3] <= 23 && parts[4] <= 59 && parts[5] <= 59
        const validOffset = match && (match[7] === 'Z' || (Number(match[8]) <= 23 && Number(match[9]) <= 59))
        if (!match || !validCalendar || !validClock || !validOffset || Number.isNaN(Date.parse(current))) {
          errors.push(`${location}: invalid date-time`)
        }
      }
      if (rule.contentEncoding === 'base64') {
        const canonical = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/u
        if (!canonical.test(current)) errors.push(`${location}: invalid base64`)
      }
    }
    if (actualType === 'integer' || actualType === 'number') {
      if (rule.minimum !== undefined && current < rule.minimum) errors.push(`${location}: below minimum`)
      if (rule.maximum !== undefined && current > rule.maximum) errors.push(`${location}: above maximum`)
    }
  }
  visit(value, schema, at)
  return errors
}

function assertSchemaValid(value, schema, label) {
  assert.deepEqual(schemaErrors(value, schema), [], label)
}

const product = readJson('agents/contracts/product.json')
const routes = readJson('agents/contracts/routes.json')
const machine = readJson('agents/contracts/state-machine.json')
const gates = readJson('agents/contracts/gates.json')
const roles = readJson('agents/contracts/roles.json')
const providers = readJson('agents/contracts/providers.json')
const plain = readJson('agents/contracts/plain-language.json')
const accountingRecordSchema = readJson('agents/contracts/schemas/accounting-record.schema.json')
const accountingSnapshotSchema = readJson('agents/contracts/schemas/accounting-snapshot.schema.json')

function contractSchema(contract) {
  return JSON.parse(fs.readFileSync(path.resolve(CONTRACTS, contract.$schema), 'utf8'))
}

function expandedTransitions(inputMachine) {
  return inputMachine.transitions.flatMap((transition) => {
    const fromStates = Array.isArray(transition.from) ? transition.from : [transition.from]
    return fromStates.map((from) => ({ ...transition, from }))
  })
}

function assertStateSemantics(inputMachine) {
  assert.equal(new Set(inputMachine.states).size, inputMachine.states.length, 'state ids are unique')
  assert.equal(new Set(inputMachine.transitions.map(({ id }) => id)).size,
    inputMachine.transitions.length, 'transition ids are unique')
  const states = new Set(inputMachine.states)
  const terminals = new Set(inputMachine.terminalStates)
  const expanded = expandedTransitions(inputMachine)
  const pairs = new Set()
  for (const transition of expanded) {
    assert.ok(states.has(transition.from), `known source state: ${transition.id}`)
    assert.ok(states.has(transition.to) ||
      ['$same', '$savedResumeState', '$savedCheckOrigin'].includes(transition.to),
      `known destination state: ${transition.id}`)
    const key = `${transition.from}\0${transition.event}`
    assert.ok(!pairs.has(key), `one result for ${transition.from} + ${transition.event}`)
    pairs.add(key)
    assert.ok(!terminals.has(transition.from), `terminal ${transition.from} has no outgoing event`)
    if (transition.to === '$same' || transition.to === transition.from) {
      assert.ok(transition.boundedBy, `self transition ${transition.id} is explicitly bounded`)
    }
  }
  assert.deepEqual([...terminals].sort(), ['BLOCKED', 'CANCELLED', 'DONE', 'FAILED', 'PARTIAL'])
  assert.deepEqual(inputMachine.completionRules.terminalOutgoingEvents, [])
  assert.equal(inputMachine.completionRules.itemTerminal, 'ITEM_VERIFIED')
  assert.match(inputMachine.transitions.find(({ event }) => event === 'REPAIR_READY').guard, /version|evidence/i)
  assert.ok(inputMachine.transitions.some(({ event }) => event === 'NO_PROGRESS'))
  const unrecoverableFailed = inputMachine.transitions.find(({ id }) => id === 'T038')
  const unrecoverablePartial = inputMachine.transitions.find(({ id }) => id === 'T076')
  assert.match(unrecoverableFailed.guard, /no accepted requested result survives/)
  assert.match(unrecoverableFailed.effect, /FAILED/)
  assert.match(unrecoverablePartial.guard, /at least one accepted requested result survives/)
  assert.match(unrecoverablePartial.effect, /PARTIAL/)

  const reachable = new Set([inputMachine.initialState])
  let changed = true
  while (changed) {
    changed = false
    for (const transition of expanded) {
      if (!reachable.has(transition.from)) continue
      const to = transition.to === '$same' ? transition.from : transition.to
      if (to.startsWith('$') || reachable.has(to)) continue
      reachable.add(to)
      changed = true
    }
  }
  for (const terminal of terminals) assert.ok(reachable.has(terminal), `terminal ${terminal} is reachable`)

  const canReachTerminal = new Set(terminals)
  changed = true
  while (changed) {
    changed = false
    for (const transition of expanded) {
      const to = transition.to === '$same' ? transition.from : transition.to
      const destinationCanFinish = to === '$savedResumeState'
        ? [...states].some((state) => !terminals.has(state) && canReachTerminal.has(state))
        : to === '$savedCheckOrigin'
          ? ['RUN_WORK', 'CHECK_WORK'].some(state => canReachTerminal.has(state))
        : !to.startsWith('$') && canReachTerminal.has(to)
      if (!destinationCanFinish || canReachTerminal.has(transition.from)) continue
      canReachTerminal.add(transition.from)
      changed = true
    }
  }
  for (const state of states) {
    assert.ok(canReachTerminal.has(state), `${state} has a finite path to a terminal result`)
  }
}

function assertGateSemantics(inputGates) {
  const definitions = new Set(Object.keys(inputGates.definitions))
  const typedBoundaries = new Set(inputGates.terminationPolicy.terminalBoundaries
    .map(({ state, outcomeCode }) => `${state}:${outcomeCode}`))
  assert.deepEqual([...typedBoundaries].sort(), [
    'BLOCKED:BLOCKED', 'DONE:DONE', 'FAILED:FAILED', 'PARTIAL:PARTIAL',
  ])
  for (const [route, graph] of Object.entries(inputGates.routeGraphs)) {
    const nodes = new Set(Object.keys(graph.required))
    assert.ok(nodes.has(graph.terminal), `${route} terminal is in graph`)
    const usedAsDependency = new Set()
    for (const [node, dependencies] of Object.entries(graph.required)) {
      assert.ok(definitions.has(node), `${route} uses registered ${node}`)
      for (const dependency of dependencies) {
        assert.ok(nodes.has(dependency), `${route} dependency ${dependency} exists`)
        usedAsDependency.add(dependency)
      }
    }
    const sinks = [...nodes].filter((node) => !usedAsDependency.has(node))
    assert.deepEqual(sinks, [graph.terminal], `${route} has one final node`)

    const visiting = new Set()
    const visited = new Set()
    const visit = (node) => {
      assert.ok(!visiting.has(node), `${route} graph is acyclic`)
      if (visited.has(node)) return
      visiting.add(node)
      graph.required[node].forEach(visit)
      visiting.delete(node)
      visited.add(node)
    }
    nodes.forEach(visit)

    const expectedLeaves = [...nodes].sort()
    assert.deepEqual(graph.leaves, expectedLeaves, `${route} serializes every leaf exactly once`)
    const expectedEdges = Object.entries(graph.required)
      .flatMap(([after, dependencies]) => dependencies.map((before) => ({ before, after })))
      .sort((a, b) => a.before.localeCompare(b.before) || a.after.localeCompare(b.after))
    assert.deepEqual(graph.edges, expectedEdges, `${route} serializes every dependency edge`)
    assert.deepEqual([...graph.order].sort(), expectedLeaves, `${route} order covers every leaf`)
    const positions = new Map(graph.order.map((node, index) => [node, index]))
    for (const { before, after } of graph.edges) {
      assert.ok(positions.get(before) < positions.get(after), `${route} order respects ${before} -> ${after}`)
    }
    const expectedMaxTransitions = graph.order.reduce(
      (sum, node) => sum + inputGates.definitions[node].retryPolicy.maxAttempts, 0,
    ) + 1
    assert.equal(graph.maxTransitions, expectedMaxTransitions, `${route} declares its finite bound`)

    const active = new Set()
    const explored = new Set()
    const walkAllOutcomes = (index, attempt, depth) => {
      assert.ok(depth <= graph.maxTransitions, `${route} never exceeds its transition bound`)
      if (index === graph.order.length) return new Set(['DONE:DONE'])
      const key = `${index}:${attempt}`
      assert.ok(!active.has(key), `${route} has no universally reachable unbounded cycle`)
      if (explored.has(key)) return new Set()
      active.add(key)
      const policy = inputGates.definitions[graph.order[index]].retryPolicy
      const outcomes = walkAllOutcomes(index + 1, 1, depth + 1)
      for (const failure of policy.retryableFailures) {
        assert.match(failure, /^[A-Z][A-Z0-9_]+$/)
        if (attempt < policy.maxAttempts) {
          for (const outcome of walkAllOutcomes(index, attempt + 1, depth + 1)) outcomes.add(outcome)
        } else {
          outcomes.add(`${policy.onExhaustion.state}:${policy.onExhaustion.outcomeCode}`)
        }
      }
      outcomes.add(`${policy.onExhaustion.state}:${policy.onExhaustion.outcomeCode}`)
      active.delete(key)
      explored.add(key)
      for (const outcome of outcomes) {
        assert.ok(typedBoundaries.has(outcome), `${route} branch reaches typed boundary ${outcome}`)
      }
      return outcomes
    }
    assert.ok(walkAllOutcomes(0, 1, 0).size >= 1, `${route} explores every success/failure branch`)
  }
  assert.ok(!Object.hasOwn(inputGates.routeGraphs.DIRECT.required, 'roadmap-authoring'))
  assert.ok(!Object.hasOwn(inputGates.routeGraphs.LIGHT.required, 'roadmap-authoring'))
  assert.ok(Object.hasOwn(inputGates.routeGraphs.ROADMAP.required, 'integration'))
  for (const graph of Object.values(inputGates.routeGraphs)) {
    assert.ok(Object.hasOwn(graph.required, 'independent-check'), 'one combined checker is the default')
    assert.ok(!Object.hasOwn(graph.required, 'static-review'), 'static review is not a mandatory second role')
    assert.ok(!Object.hasOwn(graph.required, 'behavior-test'), 'behavior testing is not a mandatory second role')
  }
  assert.equal(inputGates.checkerSelection.default.checkerCount, 1)
  assert.equal(inputGates.checkerSelection.default.check, 'independent-check')
  assert.deepEqual(inputGates.checkerSelection.default.covers.sort(), ['behavior-test', 'static-review'])
  assert.equal(inputGates.checkerSelection.secondChecker.requiresNamedDistinctResponsibility, true)
  assert.equal(inputGates.checkerSelection.secondChecker.duplicateEvidenceConsumptionForbidden, true)
  for (const [checkId, check] of Object.entries(inputGates.definitions)) {
    for (const field of ['inputs', 'outputs', 'sideEffects', 'owner', 'failureOwner', 'execution', 'retryPolicy']) {
      assert.ok(check[field] && check[field].length !== 0, `check has ${field}`)
    }
    assert.equal(check.execution.command.argv.at(-1), checkId, `${checkId} command targets its check`)
    assert.equal(check.execution.command.availability, 'required-preflight')
    assert.equal(check.execution.oracle.availability, 'required-preflight')
    assert.ok(check.execution.command.requiredCapabilities.length > 0)
    assert.ok(check.execution.oracle.requiredCapabilities.length > 0)
    assert.ok(check.execution.negativePaths.length >= 2)
    assert.equal(check.retryPolicy.kind, 'bounded-progress')
    assert.ok(Number.isInteger(check.retryPolicy.maxAttempts))
    assert.ok(check.retryPolicy.maxAttempts >= 1 && check.retryPolicy.maxAttempts <= 3)
    assert.equal(check.retryPolicy.requiresProgressAfterFailure, true)
    assert.ok(check.retryPolicy.maxUnchangedFailures <= 1)
    assert.ok(typedBoundaries.has(
      `${check.retryPolicy.onExhaustion.state}:${check.retryPolicy.onExhaustion.outcomeCode}`,
    ))
  }
  assert.equal(inputGates.findingClosure.severityDowngradeAllowed, false)
}

function compositionErrors(selection, inputGates = gates) {
  const errors = schemaErrors(selection, inputGates.composition.selectionSchema)
  const selectedRisks = new Set(selection.riskOverlays || [])
  const evidence = selection.riskEvidence || {}
  for (const risk of selectedRisks) {
    if (typeof evidence[risk] !== 'string' || evidence[risk].trim() === '') {
      errors.push(`missing risk evidence: ${risk}`)
    }
  }
  for (const risk of Object.keys(evidence)) {
    if (!selectedRisks.has(risk)) errors.push(`unused risk evidence: ${risk}`)
  }
  for (const incompatible of inputGates.composition.validation.incompatibleCombinations) {
    if (selection.baseWorkType === incompatible.baseWorkType
      && selectedRisks.has(incompatible.riskOverlay)) {
      errors.push(`incompatible: ${incompatible.baseWorkType} + ${incompatible.riskOverlay}`)
    }
  }
  const selectionSets = {
    artifactOverlays: new Set(selection.artifactOverlays || []),
    acceptanceOverlays: new Set(selection.acceptanceOverlays || []),
    riskOverlays: new Set(selection.riskOverlays || []),
  }
  const listMatches = (values, mode, actual) => mode === 'all'
    ? values.every((item) => actual.has(item))
    : values.some((item) => actual.has(item))
  for (const rule of inputGates.composition.validation.compoundRules) {
    const when = rule.when
    if (when.baseWorkType && selection.baseWorkType !== when.baseWorkType) continue
    if (when.artifactOverlaysAny
      && !listMatches(when.artifactOverlaysAny, 'any', selectionSets.artifactOverlays)) continue
    const required = rule.require
    if (required.resultFormats && !required.resultFormats.includes(selection.resultFormat)) {
      errors.push(`${rule.id}: result format does not fit base work`)
    }
    for (const [field, mode] of [['artifactOverlaysAll', 'all'], ['artifactOverlaysAny', 'any'],
      ['acceptanceOverlaysAll', 'all'], ['acceptanceOverlaysAny', 'any'],
      ['riskOverlaysAll', 'all'], ['riskOverlaysAny', 'any']]) {
      if (!required[field]) continue
      const selected = selectionSets[field.startsWith('artifact')
        ? 'artifactOverlays' : field.startsWith('risk') ? 'riskOverlays' : 'acceptanceOverlays']
      if (!listMatches(required[field], mode, selected)) errors.push(`${rule.id}: missing ${field}`)
    }
    for (const [field, values] of Object.entries(rule.forbid || {})) {
      const selected = selectionSets[field.startsWith('artifact')
        ? 'artifactOverlays' : field.startsWith('risk') ? 'riskOverlays' : 'acceptanceOverlays']
      if (listMatches(values, field.endsWith('All') ? 'all' : 'any', selected)) {
        errors.push(`${rule.id}: forbidden ${field}`)
      }
    }
  }
  return errors
}

function composeChecks(selection, inputGates = gates) {
  const errors = compositionErrors(selection, inputGates)
  if (errors.length > 0) throw new Error(errors.join('\n'))
  return {
    baseWorkType: selection.baseWorkType,
    artifactOverlays: [...selection.artifactOverlays],
    acceptanceOverlays: [...selection.acceptanceOverlays],
    requiredCheckKinds: [...new Set(selection.artifactOverlays.flatMap(
      (overlay) => inputGates.composition.artifactOverlays[overlay].requiredCheckKinds,
    ))],
    riskChecks: selection.riskOverlays.map((risk) => ({
      risk,
      check: inputGates.riskOverlays[risk].check,
      evidence: selection.riskEvidence[risk],
    })),
  }
}

function assertRoleSemantics(inputRoles) {
  const allRoles = [inputRoles.orchestratorContract, ...inputRoles.roles]
  const byId = new Map(allRoles.map((role) => [role.id, role]))
  assert.equal(byId.size, allRoles.length, 'logical role ids are unique')
  assert.equal(new Set(allRoles.map(({ physicalId }) => physicalId)).size, allRoles.length,
    'physical role ids are unique')
  for (const role of allRoles) {
    assert.match(role.physicalId, /^autoprompt\.v2\./)
    for (const schemaPath of [role.inputSchema, role.outputSchema]) {
      assert.ok(fs.existsSync(path.join(ROOT, schemaPath)), `${role.id} references ${schemaPath}`)
    }
    if (role.legalChildren.length === 0) assert.equal(role.permissions.dispatch, 'none', `${role.id} is closed`)
  }
  assert.deepEqual(byId.get('route-analyst').permissions.write, [])
  assert.deepEqual(byId.get('route-analyst').legalChildren, [])
  assert.deepEqual(byId.get('worker').legalChildren, [])
  assert.deepEqual(byId.get('independent-reviewer').permissions.write, [])
  assert.ok(byId.get('independent-tester').permissions.write.every((item) => item.includes('isolated')))
  assert.ok(!byId.get('worker').legalChildren.includes('independent-reviewer'))

  const edgeSet = new Set()
  for (const edge of inputRoles.phaseAdjacency) {
    for (const child of edge.children) {
      const childRole = byId.get(child)
      assert.ok(childRole, `adjacency child ${child} exists`)
      assert.ok(childRole.legalParents.includes(edge.parent), `${edge.parent} may parent ${child}`)
      const phases = childRole.phases || [childRole.phase]
      assert.ok(phases.includes(edge.phase), `${child} is declared for ${edge.phase}`)
      edgeSet.add(`${edge.parent}\0${child}`)
    }
    if (['DIRECT', 'LIGHT'].includes(edge.route)) {
      assert.ok(!edge.children.includes('mission-coordinator'))
      assert.ok(!edge.children.includes('ap-work-group-manager'))
    }
  }
  for (const role of allRoles.filter(({ legalChildren }) => legalChildren.length > 0)) {
    for (const child of role.legalChildren) {
      assert.ok(edgeSet.has(`${role.id}\0${child}`), `${role.id} -> ${child} has a phase edge`)
    }
  }

  const legacy = readJson('agents/contracts/autoprompt.contract.json')
  assert.equal(legacy.schemaVersion, 1, 'v1 stays readable and unchanged in place')
  assert.deepEqual(inputRoles.compatibilityAliases.map(({ legacyId }) => legacyId).sort(),
    legacy.personas.map(({ id }) => id).sort(), 'every v1 role has one v2 alias record')
  assert.equal(new Set(inputRoles.compatibilityAliases.map(({ legacyId }) => legacyId)).size,
    inputRoles.compatibilityAliases.length, 'legacy alias ids are unique')
  const manager = byId.get('ap-work-group-manager')
  assert.equal(manager.physicalId, 'autoprompt.v2.ap-work-group-manager')
  assert.equal(manager.layer, 'L2')
  assert.deepEqual(manager.allowedRoutes, ['ROADMAP'])
  assert.deepEqual(manager.legalParents, ['mission-coordinator'])
  assert.deepEqual(manager.legalChildren, ['worker'])
  assert.deepEqual(manager.admissionPolicy, {
    route: 'ROADMAP', planPath: 'plan/ROADMAP.md', minimumUsefulWorkers: 2,
    disjointMutableResourceOwnershipRequired: true, singleWorkerGroupsMustStayWithParent: true,
  })
  const aliasIds = inputRoles.compatibilityAliases.map(({ legacyId }) => legacyId).sort()
  const canonicalProviderIds = inputRoles.codexPhysicalRoleProjection.map(({ physicalId }) => physicalId).sort()
  assert.deepEqual(canonicalProviderIds, [
    'ap-independent-checker', 'ap-roadmap-author', 'ap-roadmap-scout', 'ap-route-analyst',
    'ap-run-coordinator', 'ap-work-group-manager', 'ap-worker',
  ])
  assert.equal(new Set([...canonicalProviderIds, ...aliasIds]).size, 32,
    'Codex exposes exactly seven canonical physical roles plus twenty-five closed aliases')
  const providerProjection = new Map(inputRoles.codexPhysicalRoleProjection.map(record => [record.physicalId, record]))
  assert.deepEqual(providerProjection.get('ap-run-coordinator'), {
    physicalId: 'ap-run-coordinator', logicalId: 'mission-coordinator', layer: 'L1',
    modes: ['roadmap-integration'],
  })
  assert.deepEqual(providerProjection.get('ap-work-group-manager'), {
    physicalId: 'ap-work-group-manager', logicalId: 'ap-work-group-manager', layer: 'L2',
    modes: ['roadmap-work-group'],
  })
  assert.deepEqual(providerProjection.get('ap-worker').modes,
    ['general', 'implementation', 'research', 'check-resolver'])
  assert.deepEqual(providerProjection.get('ap-independent-checker').modes,
    ['combined', 'review', 'behavior-test', 'technical-decision', 'named-distinct-risk'])
  assert.equal(inputRoles.compatibilityAliasPolicy.status, 'closed-read-only')
  assert.equal(inputRoles.compatibilityAliasPolicy.activationAllowed, false)
  assert.equal(inputRoles.compatibilityAliasPolicy.writeAllowed, false)
  assert.equal(inputRoles.compatibilityAliasPolicy.telemetryRequired, true)
  assert.deepEqual(inputRoles.compatibilityAliasPolicy.legacyPhysicalIds.slice().sort(), aliasIds,
    'every legacy physical id is closed by the compatibility policy')
  for (const [legacyId, logicalId, mode] of [
    ['ap-manager', 'ap-work-group-manager', 'roadmap-only'],
    ['ap-implementer', 'worker', 'implementation'],
    ['ap-researcher', 'worker', 'research'],
    ['ap-execharness-resolver', 'worker', 'check-resolver'],
  ]) {
    const alias = inputRoles.compatibilityAliases.find(record => record.legacyId === legacyId)
    assert.deepEqual(alias, { legacyId, logicalId, mode }, `${legacyId} has one typed closed alias mapping`)
  }
  assert.equal(inputRoles.aliasTelemetrySchema.enforcer, 'deterministic-control-plane')
  assert.equal(inputRoles.aliasTelemetrySchema.appendPath, 'compatibility/alias-telemetry.jsonl')
  assert.equal(inputRoles.aliasTelemetrySchema.counterField, 'aliasUseCount')
  assert.equal(inputRoles.aliasTelemetrySchema.legacyReadVersion, '1')
  assert.equal(inputRoles.aliasTelemetrySchema.canonicalWriteVersion, '2.0.0')
  const telemetry = {
    runId: 'run-0001', activationId: 'activation-001', generation: 1,
    legacyId: 'ap-intake', logicalId: 'legacy-intake',
    physicalId: 'autoprompt.v2.legacy-intake', legacyReadVersion: '1',
    canonicalWriteVersion: '2.0.0', aliasUseCount: 1, occurredAt: '2026-08-21T00:00:00Z',
    previousHash: null,
  }
  telemetry.entryHash = aliasEntryHash(telemetry, inputRoles.aliasTelemetrySchema.hashChain)
  assertSchemaValid(telemetry, inputRoles.aliasTelemetrySchema.recordSchema, 'alias telemetry')
}

function workGroupAdmissionErrors(assignment, roleReportSchema) {
  const errors = schemaErrors(assignment, roleReportSchema)
  if (assignment.logicalRoleId !== 'ap-work-group-manager') return errors
  const admission = assignment.workGroupAdmission
  if (!admission) return [...errors, 'manager admission missing']
  if (admission.usefulWorkerCount !== admission.workerAssignments.length) {
    errors.push('useful worker count does not match assignments')
  }
  const assignmentIds = admission.workerAssignments.map(({ workerAssignmentId }) => workerAssignmentId)
  if (new Set(assignmentIds).size !== assignmentIds.length) errors.push('worker assignment ids overlap')
  const resources = admission.workerAssignments.flatMap(({ mutableResourceIdentities }) => mutableResourceIdentities)
  if (new Set(resources).size !== resources.length) errors.push('mutable resource ownership overlaps')
  return errors
}

function aliasTelemetrySequenceErrors(records, recordSchema = roles.aliasTelemetrySchema.recordSchema) {
  const errors = []
  const seenRows = new Set()
  const lastCountByGeneration = new Map()
  let previousHash = roles.aliasTelemetrySchema.hashChain.genesisPreviousHash
  for (const record of records) {
    errors.push(...schemaErrors(record, recordSchema))
    if (record.previousHash !== previousHash) errors.push('alias telemetry previousHash breaks the append-file chain')
    if (record.entryHash !== aliasEntryHash(record)) errors.push('alias telemetry entryHash does not match canonical record bytes')
    previousHash = record.entryHash
    const rowKey = [record.activationId, record.runId, record.generation, record.occurredAt].join('\0')
    if (seenRows.has(rowKey)) errors.push(`replayed alias telemetry row: ${rowKey}`)
    seenRows.add(rowKey)
    const generationKey = [record.activationId, record.runId, record.generation].join('\0')
    const expectedCount = (lastCountByGeneration.get(generationKey) ?? 0) + 1
    if (record.aliasUseCount !== expectedCount) {
      errors.push(`aliasUseCount for ${generationKey} must be ${expectedCount}`)
    }
    lastCountByGeneration.set(generationKey, record.aliasUseCount)
  }
  return errors
}

function assertProviderSemantics(inputProviders) {
  const expected = ['claude', 'codex', 'deepseek', 'kilo', 'omp', 'opencode', 'prime', 'reasonix', 'vscode']
  assert.deepEqual(inputProviders.providers.map(({ id }) => id).sort(), expected)
  assert.equal(inputProviders.providers[0].id, 'codex')
  const capabilities = Object.keys(inputProviders.capabilityDefinitions).sort()
  for (const provider of inputProviders.providers) {
    assert.deepEqual(Object.keys(provider.capabilities).sort(), capabilities, `${provider.id} is explicit`)
    if (provider.implementationStatus !== 'verified') {
      assert.match(provider.defaultAdmission, /refuse/)
    }
    for (const support of Object.values(provider.capabilities)) {
      assert.ok(inputProviders.safeSupportValues.includes(support), `${provider.id} has known support value`)
    }
    if (provider.implementationStatus === 'verified') {
      const codexPreCanary = provider.id === 'codex' && provider.attestationRequired === true &&
        provider.defaultAdmission === 'allow-verified-required-capabilities' &&
        provider.verificationAttestation === null
      if (codexPreCanary) {
        assert.deepEqual(
          Object.entries(provider.capabilities)
            .filter(([, value]) => value === 'supported')
            .map(([capability]) => capability)
            .sort(),
          ['isolation', 'privateSkillRoot', 'processOwnership'],
        )
      } else {
        assert.ok(provider.verificationAttestation, `${provider.id} has a current attestation`)
        assert.equal(provider.verificationAttestation.providerId, provider.id)
        assert.ok(Date.parse(provider.verificationAttestation.expiresAt)
          > Date.parse(provider.verificationAttestation.issuedAt), `${provider.id} attestation is currentable`)
      }
    } else {
      assert.equal(provider.verificationAttestation, null, `${provider.id} cannot imply verification`)
      assert.equal(Object.hasOwn(provider, 'attestationRequired'), false)
    }
  }
  assert.equal(inputProviders.admissionPolicy.unknown, 'refuse-required-feature')
  assert.equal(inputProviders.admissionPolicy.unsupported, 'refuse-required-feature')
}

function routePathValue(facts, dottedPath) {
  return dottedPath.split('.').reduce((value, part) => {
    if (part === 'length' && (Array.isArray(value) || typeof value === 'string')) return value.length
    return value && Object.hasOwn(value, part) ? value[part] : undefined
  }, facts)
}

function evaluateRoutePredicate(predicate, facts) {
  const value = predicate.path ? routePathValue(facts, predicate.path) : undefined
  switch (predicate.op) {
    case 'all': return predicate.predicates.every((item) => evaluateRoutePredicate(item, facts))
    case 'any': return predicate.predicates.some((item) => evaluateRoutePredicate(item, facts))
    case 'eq': return isDeepStrictEqual(value, predicate.value)
    case 'in': return predicate.values.some((item) => isDeepStrictEqual(value, item))
    case 'gte': return typeof value === 'number' && value >= predicate.value
    case 'gt': return typeof value === 'number' && value > predicate.value
    case 'lte': return typeof value === 'number' && value <= predicate.value
    case 'sum-lte': {
      const values = predicate.paths.map((item) => routePathValue(facts, item))
      const limit = routePathValue(facts, predicate.limitPath)
      const result = values.every((item) => typeof item === 'number')
        && typeof limit === 'number'
        && values.reduce((sum, item) => sum + item, 0) <= limit
      return predicate.negate ? !result : result
    }
    default: throw new Error(`unsupported route predicate operator: ${predicate.op}`)
  }
}

function selectRoute(facts, inputRoutes = routes) {
  const errors = schemaErrors(facts, inputRoutes.routeFactsSchema)
  if (errors.length > 0) throw new Error(errors.join('\n'))
  return [...inputRoutes.precedenceTable]
    .sort((left, right) => left.order - right.order)
    .find(({ when }) => evaluateRoutePredicate(when, facts)).result
}

function schemaHasRoutePath(schema, dottedPath) {
  const parts = dottedPath.split('.')
  let rule = schema
  for (const part of parts) {
    if (part === 'length') return rule.type === 'array' || rule.type === 'string'
    if (!rule.properties || !Object.hasOwn(rule.properties, part)) return false
    rule = rule.properties[part]
  }
  return true
}

function routePredicatePaths(predicate) {
  return [
    ...(predicate.path ? [predicate.path] : []),
    ...(predicate.paths || []),
    ...(predicate.limitPath ? [predicate.limitPath] : []),
    ...(predicate.predicates || []).flatMap(routePredicatePaths),
  ]
}

function validRouteFacts() {
  return {
    schemaVersion: '2.0.0',
    capturedIncidentDomains: [],
    requestedEffect: 'report',
    successCriteria: 'ready',
    dependency: {
      shape: 'bounded', dependentWorkGroupCount: 1,
      integrationOwnerRequired: false, separateDependentBodies: 1,
    },
    uncertainty: 'none',
    reversibility: 'fully-reversible',
    mutableResources: [], sideEffects: [], externality: 'local-only',
    confidentiality: 'internal', thirdPartyImpact: 'none',
    targetAuthorization: {
      targetIdentities: [], authorizedTargetIdentities: [], authorizationEvidenceHash: null,
      allTargetsAuthorized: true,
    },
    costAuthority: {
      mayIncurCost: false, estimatedCostMicrounits: 0, limitMicrounits: 0,
      approvalRequired: false, approvalGranted: false, approvalEvidenceHash: null, withinLimit: true,
    },
    riskAndIndependentCheckFloor: {
      level: 'ordinary', minimumCheckerCount: 1, namedDistinctResponsibilities: [],
    },
    checkAndBaseline: {
      checkQuality: 'authoritative', availableCheckKinds: ['structured-output'],
      baselineStatus: 'not-applicable', hiddenExternalCheck: false,
    },
    deadlineBudget: {
      remainingSeconds: 1200, admissionSeconds: 240, executionReserveSeconds: 480,
      verificationReserveSeconds: 240, recoveryAndFinalizationReserveSeconds: 120,
    },
    operatorMinimumRoute: null,
    transportCapability: { mode: 'sequential-isolated', taskCapabilityPreserved: true },
    candidateFreeze: { required: false, available: true, environmentCanBeBound: true },
    missingUserInput: [], architectureImpact: 'local', fitsLightPlan: true,
    approachNeedsShortPlanning: false, shortOrderUnclear: false,
  }
}

function assertRouteSemantics(inputRoutes) {
  assert.equal(inputRoutes.defaultRoute, null)
  assert.equal(inputRoutes.routeAnalyst.count, 1)
  assert.equal(inputRoutes.routeAnalyst.readOnly, true)
  assert.equal(inputRoutes.routeAnalyst.mayDispatch, false)
  assert.ok(inputRoutes.routeAnalyst.timeLimitSeconds <= 120)
  assert.ok(inputRoutes.runOwnerDecision.timeLimitSeconds <= 240)
  assert.equal(inputRoutes.preWork.needsUserIsRoute, false)
  assert.equal(inputRoutes.routes.DIRECT.coordinatorAllowed, false)
  assert.equal(inputRoutes.routes.DIRECT.managerAllowed, false)
  assert.equal(inputRoutes.routes.LIGHT.coordinatorAllowed, false)
  assert.equal(inputRoutes.routes.LIGHT.planningBulletLimit, 15)
  assert.equal(inputRoutes.routes.LIGHT.planningTimeLimitSeconds, 300)
  assert.equal(inputRoutes.routes.ROADMAP.planningFile, 'plan/ROADMAP.md')
  assert.ok(inputRoutes.classificationInputs.includes('requestedEffect'))
  for (const field of inputRoutes.classificationInputs) {
    assert.ok(inputRoutes.routeFactsSchema.required.includes(field), `${field} is required route evidence`)
  }
  assert.deepEqual(inputRoutes.precedenceTable.map(({ order }) => order), [1, 2, 3, 4, 5, 6, 7, 8, 9])
  for (const { when } of inputRoutes.precedenceTable) {
    for (const routePath of routePredicatePaths(when)) {
      assert.ok(schemaHasRoutePath(inputRoutes.routeFactsSchema, routePath), `${routePath} is schema-backed`)
    }
  }
  assert.equal(inputRoutes.semanticValidationRules.length, 7)
  assert.equal(new Set(inputRoutes.semanticValidationRules.map(rule => rule.validator)).size, 7)
  assert.deepEqual(Object.keys(inputRoutes.capabilityRequirements.byRequestedEffect).sort(),
    ['decide', 'external-operation', 'inspect', 'mutate', 'report', 'research'])
  assert.deepEqual(Object.keys(inputRoutes.capabilityRequirements.byRoute).sort(), ['DIRECT', 'LIGHT', 'ROADMAP'])
  assert.deepEqual(Object.keys(inputRoutes.effectAcceptance).sort(),
    ['decide', 'external-operation', 'inspect', 'mutate', 'report', 'research'])
  for (const effect of Object.values(inputRoutes.effectAcceptance)) {
    assert.ok(effect.requiredAcceptance.length > 0)
  }
  assert.equal(inputRoutes.probeOrCharacterize.productionWritesAllowed, false)
  assert.equal(inputRoutes.probeOrCharacterize.broadTestSuiteAllowed, false)
  assert.equal(inputRoutes.probeOrCharacterize.failureDoesNotSelectLargerRoute, true)
  for (const event of ['RISK_DISCOVERED', 'SIDE_EFFECT_DISCOVERED', 'SHARED_RESOURCE_DISCOVERED',
    'ORACLE_FAILURE', 'NO_PROGRESS', 'CAPABILITY_LOST']) {
    assert.ok(inputRoutes.escalationEvents[event], event)
    assert.ok(inputRoutes.escalationEvents[event].requiredEvidence.length > 0)
  }
  for (const route of ['DIRECT', 'LIGHT', 'ROADMAP']) {
    assert.ok(inputRoutes.examples.filter((example) => example.route === route).length >= 2,
      `${route} has examples including counterexamples`)
  }
  assert.ok(inputRoutes.nonSelectors.includes('file-count'))
  assert.ok(inputRoutes.nonSelectors.includes('one-failed-implementation'))
}

test('canonical v2 contracts parse, validate against their schemas, and retain v1 as read-only input', () => {
  for (const contract of [product, routes, machine, gates, roles, providers, plain]) {
    assert.equal(contract.contractVersion, '2.0.0')
    assertSchemaValid(contract, contractSchema(contract), contract.kind)
  }
  assert.equal(product.compatibility.policy, 'dual-read-v2-write')
  assert.equal(product.compatibility.writeVersion, '2.0.0')
  assert.equal(product.compatibility.legacySourceIsAuthoritative, false)
  for (const source of product.canonicalSources) {
    assert.ok(fs.existsSync(path.join(ROOT, source.contract)), source.contract)
    assert.ok(fs.existsSync(path.join(ROOT, source.schema)), source.schema)
  }
  assert.equal(product.generationPolicy.legacyInputAllowedForProviderGeneration, false)
  assert.equal(product.generationPolicy.requireEveryCompatibilityAliasPrompt, true)
  for (const promptSource of product.generationPolicy.authoritativePromptSources) {
    assert.ok(fs.existsSync(path.join(ROOT, promptSource)), promptSource)
  }
  const promptBasenames = new Set(product.generationPolicy.authoritativePromptSources.map(
    (source) => path.basename(source, '.md'),
  ))
  for (const { legacyId } of roles.compatibilityAliases) {
    assert.ok(promptBasenames.has(legacyId), `canonical instructions exist for ${legacyId}`)
  }
  for (const schemaPath of Object.values(product.runtimeSchemas)) {
    const schema = readJson(schemaPath)
    assert.equal(schema.$schema, 'https://json-schema.org/draft/2020-12/schema')
    assert.match(schema.$id, /\/v2\//)
  }
})

test('route selection is measurable, has no default, keeps NEEDS_USER outside the route enum, and is mutation-resistant', () => {
  assertRouteSemantics(routes)
  const direct = validRouteFacts()
  const light = clone(direct)
  light.uncertainty = 'reversible-technical'
  light.approachNeedsShortPlanning = true
  const roadmap = clone(direct)
  roadmap.uncertainty = 'architecture'
  roadmap.architectureImpact = 'multi-system'
  const waiting = clone(direct)
  waiting.missingUserInput = ['The user must choose the public behavior.']
  const measuredLanes = [
    ['direct', direct], ['light', light], ['roadmap', roadmap], ['waiting-user', waiting],
  ].map(([label, facts]) => {
    assertSchemaValid(facts, routes.routeFactsSchema, `${label} route facts`)
    return [label, selectRoute(facts)]
  })
  assert.deepEqual(measuredLanes, [
    ['direct', 'DIRECT'], ['light', 'LIGHT'], ['roadmap', 'ROADMAP'],
    ['waiting-user', 'WAITING_USER'],
  ], 'all four measurable route outcomes execute their lane assertions')
  const unsupported = clone(direct)
  unsupported.transportCapability.taskCapabilityPreserved = false
  assert.equal(selectRoute(unsupported), 'PROVIDER_UNSUPPORTED')
  const tooShort = clone(direct)
  tooShort.deadlineBudget.remainingSeconds = 100
  assert.equal(selectRoute(tooShort), 'ROUTE_BUDGET_INSUFFICIENT')
  const effectMissing = clone(direct)
  delete effectMissing.requestedEffect
  assert.throws(() => selectRoute(effectMissing), /requestedEffect/)
  const unfrozenMutation = clone(direct)
  unfrozenMutation.requestedEffect = 'mutate'
  unfrozenMutation.sideEffects = ['deliverable-write']
  unfrozenMutation.candidateFreeze.required = false
  assert.throws(() => selectRoute(unfrozenMutation), /const mismatch/)
  const ownerlessMutation = clone(direct)
  ownerlessMutation.requestedEffect = 'mutate'
  ownerlessMutation.sideEffects = ['deliverable-write']
  ownerlessMutation.candidateFreeze.required = true
  assert.throws(() => selectRoute(ownerlessMutation), /too few items/)
  const externalWithoutExternality = clone(direct)
  externalWithoutExternality.requestedEffect = 'external-operation'
  externalWithoutExternality.candidateFreeze.required = true
  assert.throws(() => selectRoute(externalWithoutExternality), /const mismatch/)
  const defaulted = clone(routes)
  defaulted.defaultRoute = 'DIRECT'
  assert.notDeepEqual(schemaErrors(defaulted, contractSchema(routes)), [])
  const writableAnalyst = clone(routes)
  writableAnalyst.routeAnalyst.readOnly = false
  assert.throws(() => assertRouteSemantics(writableAnalyst))
  const planningTeamDirect = clone(routes)
  planningTeamDirect.routes.DIRECT.coordinatorAllowed = true
  assert.throws(() => assertRouteSemantics(planningTeamDirect))
})

test('state machine is deterministic, reaches every terminal result, records resume fields, and bounds repeat paths', () => {
  assertStateSemantics(machine)
  for (const field of ['transitionId', 'activationNonce', 'fromState', 'toState', 'candidateHash',
    'evidenceHashes', 'openIds', 'attempt', 'causalParent']) {
    assert.ok(machine.eventRecordRequiredFields.includes(field), field)
  }
  const stateEvents = new Set(machine.transitions.map(({ event }) => event))
  for (const event of ['RISK_DISCOVERED', 'SIDE_EFFECT_DISCOVERED', 'SHARED_RESOURCE_DISCOVERED',
    'ORACLE_FAILURE', 'NO_PROGRESS', 'CAPABILITY_LOST']) assert.ok(stateEvents.has(event), event)
  const duplicate = clone(machine)
  duplicate.transitions.push({ ...duplicate.transitions[0], id: 'T999' })
  assert.throws(() => assertStateSemantics(duplicate), /one result/)
  const unbounded = clone(machine)
  delete unbounded.transitions.find(({ event }) => event === 'TRANSIENT_RUNTIME').boundedBy
  assert.throws(() => assertStateSemantics(unbounded), /explicitly bounded/)
  const stranded = clone(machine)
  stranded.transitions = stranded.transitions.filter(({ id }) => id !== 'T005')
  const userUpdate = stranded.transitions.find(({ id }) => id === 'T061')
  userUpdate.from = userUpdate.from.filter((state) => state !== 'CONFIG_REQUIRED')
  assert.throws(() => assertStateSemantics(stranded), /CONFIG_REQUIRED has a finite path/)
})

test('role graph enforces exact phase edges, least privilege, typed reports, resource ownership, and v1 alias telemetry', () => {
  assertRoleSemantics(roles)
  const authorSelectsReviewer = clone(roles)
  const worker = authorSelectsReviewer.roles.find(({ id }) => id === 'worker')
  worker.legalChildren.push('independent-reviewer')
  worker.permissions.dispatch = 'phase-adjacency-only'
  assert.throws(() => assertRoleSemantics(authorSelectsReviewer))
  const reviewerWritesTarget = clone(roles)
  reviewerWritesTarget.roles.find(({ id }) => id === 'independent-reviewer').permissions.write.push('target')
  assert.throws(() => assertRoleSemantics(reviewerWritesTarget))
  const wrongDecisionPhase = clone(roles)
  wrongDecisionPhase.roles.find(({ id }) => id === 'technical-decision-reviewer').phases = ['roadmap-planning']
  assert.throws(() => assertRoleSemantics(wrongDecisionPhase), /production/)
  const activeLegacyManager = clone(roles)
  activeLegacyManager.compatibilityAliasPolicy.legacyPhysicalIds = activeLegacyManager.compatibilityAliasPolicy
    .legacyPhysicalIds.filter(id => id !== 'ap-manager')
  assert.throws(() => assertRoleSemantics(activeLegacyManager), /legacy physical id/)
  const oneWorkerManager = clone(roles)
  oneWorkerManager.roles.find(({ id }) => id === 'ap-work-group-manager').admissionPolicy.minimumUsefulWorkers = 1
  assert.throws(() => assertRoleSemantics(oneWorkerManager), /minimumUsefulWorkers/)
  const wrongManagerRoute = clone(roles)
  wrongManagerRoute.roles.find(({ id }) => id === 'ap-work-group-manager').allowedRoutes = ['LIGHT']
  assert.throws(() => assertRoleSemantics(wrongManagerRoute))
  const telemetryWithoutCounter = clone(roles.aliasTelemetrySchema.recordSchema)
  telemetryWithoutCounter.required = telemetryWithoutCounter.required.filter((field) => field !== 'aliasUseCount')
  assert.notDeepEqual(schemaErrors(telemetryWithoutCounter, contractSchema(roles)
    .properties.aliasTelemetrySchema.properties.recordSchema), [])
  const baseTelemetry = {
    runId: 'run-0001', activationId: 'activation-001', generation: 1,
    legacyId: 'ap-intake', logicalId: 'legacy-intake',
    physicalId: 'autoprompt.v2.legacy-intake', legacyReadVersion: '1',
    canonicalWriteVersion: '2.0.0', occurredAt: '2026-08-21T00:00:00Z',
  }
  const chained = []
  for (const source of [
    { ...baseTelemetry, aliasUseCount: 1 },
    { ...baseTelemetry, aliasUseCount: 2, occurredAt: '2026-08-21T00:00:01Z' },
    { ...baseTelemetry, generation: 2, aliasUseCount: 1, occurredAt: '2026-08-21T00:00:02Z' },
  ]) {
    const record = { ...source, previousHash: chained.at(-1)?.entryHash ?? null }
    record.entryHash = aliasEntryHash(record)
    chained.push(record)
  }
  assert.deepEqual(aliasTelemetrySequenceErrors(chained), [], 'a new activation generation gets a fresh monotonic counter')
  assert.notDeepEqual(aliasTelemetrySequenceErrors([
    chained[0],
    chained[0],
  ]), [], 'replayed rows and repeated counters are rejected')
  const wrongGeneration = { ...chained[2], aliasUseCount: 2, previousHash: chained[0].entryHash }
  wrongGeneration.entryHash = aliasEntryHash(wrongGeneration)
  assert.notDeepEqual(aliasTelemetrySequenceErrors([chained[0], wrongGeneration]), [],
    'cross-generation counters must restart at one')
  const timestampTamper = clone(chained)
  timestampTamper[1].occurredAt = '2026-08-21T00:05:00Z'
  assert.notDeepEqual(aliasTelemetrySequenceErrors(timestampTamper), [],
    'timestamp-only historical-byte tampering breaks the canonical digest')
  const crashTail = parseAliasTelemetryJsonl(`${chained.map(record => JSON.stringify(record)).join('\n')}\n{"runId":"partial`)
  assert.equal(crashTail.crashTailDetected, true)
  assert.equal(crashTail.records.length, chained.length, 'one unterminated final crash tail is preserved but not accepted')
  assert.throws(() => parseAliasTelemetryJsonl(`${JSON.stringify(chained[0])}\nnot-json\n`), SyntaxError,
    'a malformed complete line is never skipped')
})

test('Codex P5 role doctrine mechanically closes leaves, authorities, schemas, and compatibility activation', () => {
  const physical = readJson('agents/codex/agents/role-policy.json')
  assert.equal(roles.orchestratorContract.id, 'run-owner')
  assert.equal(roles.orchestratorContract.physicalId, 'autoprompt.v2.run-owner')
  assert.equal(physical.control_plane.id, 'L0')
  assert.equal(physical.control_plane.logical_role, 'run-owner')
  assert.equal(physical.control_plane.can_dispatch, true)

  const active = Object.entries(physical.physical_roles).filter(([, role]) => role.activation_allowed === true)
  const projected = new Map(roles.codexPhysicalRoleProjection.map(role => [role.physicalId, role]))
  assert.deepEqual(active.map(([id]) => id).sort(), [...projected.keys()].sort(),
    'the provider-visible Codex roles are exactly the canonical projection')
  const dispatchers = new Map([
    ['ap-run-coordinator', ['ap-work-group-manager', 'ap-worker']],
    ['ap-work-group-manager', ['ap-worker']],
  ])
  for (const [id, role] of active) {
    const projection = projected.get(id)
    assert.equal(role.logical_role, projection.logicalId, `${id} keeps its canonical logical identity`)
    assert.equal(role.layer, projection.layer, `${id} keeps its canonical physical layer`)
    assert.ok(projection.modes.includes(role.mode), `${id} exposes only a projected provider mode`)
    assert.ok(['L1', 'L2', 'L3', 'L4'].includes(role.layer), `${id} has one physical layer`)
    assert.equal(typeof role.phase, 'string', `${id} has an independent phase`)
    assert.equal(typeof role.mode, 'string', `${id} has an independent mode`)
    const prompt = fs.readFileSync(path.join(ROOT, 'agents', 'codex', 'agents', `${id}.toml`), 'utf8')
    assert.doesNotMatch(prompt, /If you spawn/iu, `${id} has no universal spawn-positive boilerplate`)
    if (dispatchers.has(id)) {
      assert.equal(role.can_dispatch, true)
      assert.deepEqual([...role.allowed_children].sort(), [...dispatchers.get(id)].sort())
      for (const child of dispatchers.get(id)) assert.match(prompt, new RegExp(child.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'u'))
    } else {
      assert.equal(role.can_dispatch, false, `${id} is a closed physical leaf`)
      assert.deepEqual(role.allowed_children, [], `${id} has zero children`)
      assert.match(prompt, /cannot start another agent|do not start another agent/iu,
        `${id} states the closed-leaf rule`)
    }
  }

  const checker = physical.physical_roles['ap-independent-checker']
  assert.equal(checker.sandbox_mode, 'read-only')
  assert.ok(checker.resource_sets.read.includes('target.named.read'))
  assert.deepEqual(checker.resource_sets.write, [])
  assert.deepEqual(checker.resource_sets.exclusive, [])
  assert.equal(checker.can_dispatch, false)

  const nonUserAuthorities = Object.values(roles.decisionAuthority).filter(owner => owner !== 'user')
  assert.equal(new Set(nonUserAuthorities).size, nonUserAuthorities.length,
    'each runtime decision has one distinct authority seat')
  for (const role of roles.roles) {
    for (const schemaPath of [role.inputSchema, role.outputSchema]) {
      const schema = readJson(schemaPath)
      assert.notDeepEqual(schemaErrors({}, schema), [], `${role.id} mechanically rejects malformed ${schemaPath}`)
    }
    if (role.legalChildren.length === 0) assert.equal(role.permissions.dispatch, 'none')
  }

  assert.ok(physical.control_plane.decision_rights.includes('compile-and-validate-work-recipe'),
    'C0 owns deterministic work-recipe compilation and validation')
  assert.ok(physical.control_plane.decision_rights.includes('coordinate-framework-generate-validate-repair'),
    'C0 alone owns the bounded framework generate, independent validate, and same-author repair loop')
  assert.equal(physical.reasoning_risk_policy.independent_from_layer, true)
  assert.deepEqual(physical.reasoning_risk_policy.assignment_fields.sort(), [
    'effort_pin_status', 'model_pin_status', 'reasoning_class', 'risk_class',
  ])

  for (const id of [
    'ap-intake', 'ap-re-anchor', 'ap-framework-generator', 'ap-framework-validator',
    'ap-preflight-probe', 'ap-scribe', 'ap-janitor',
  ]) {
    assert.equal(physical.physical_roles[id].activation_allowed, false, `${id} is never a normal new-run role`)
    assert.equal(physical.physical_roles[id].can_dispatch, false)
    assert.equal(physical.physical_roles[id].sandbox_mode, 'read-only')
  }
})

test('Codex runtime transitions are a lossless executable projection of the one canonical state machine', () => {
  const runtimeState = require('../../agents/codex/workflow/runtime-state.js')
  const restorable = machine.crashRecoveryPolicy.recoverableActiveStates
  const canonical = machine.transitions.flatMap((transition) => {
    const fromStates = Array.isArray(transition.from) ? transition.from : [transition.from]
    return fromStates.flatMap((from) => {
      const toStates = transition.to === '$same'
        ? [from]
        : transition.to === '$savedResumeState'
          ? restorable
          : transition.to === '$savedCheckOrigin' ? ['RUN_WORK', 'CHECK_WORK'] : [transition.to]
      return toStates.map(to => ({
        id: transition.id,
        event: transition.event,
        from,
        to,
        humanDescription: transition.effect,
      }))
    })
  })
  assert.deepEqual(runtimeState.CANONICAL_TRANSITIONS, canonical)
  for (const transition of canonical) {
    assert.deepEqual(
      runtimeState.resolveCanonicalTransition(transition.from, transition.to, transition.event),
      transition,
      `${transition.id}:${transition.from}:${transition.event}`,
    )
  }
})

test('canonical assignment schema requires exact finding ids and owned typed resources for context-loss replay', () => {
  const schema = readJson('agents/contracts/schemas/role-report.schema.json')
  const assignment = {
    schemaVersion: '2.0.0', reportType: 'assignment', reportId: 'assignment:work-1',
    runId: 'run-0001', assignmentId: 'work-1', logicalRoleId: 'worker',
    physicalRoleId: 'autoprompt.v2.worker', requestEnvelopeHash: H,
    findingIds: ['AP-DESIGN-023', 'AP-LAYER-021'], requestedResult: 'Implement the exact named findings.',
    planReference: {
      planPath: 'plan/ROADMAP.md', sectionId: 'work-1', sectionHash: H2,
      workItemId: 'work-1', workItemHash: H3,
    },
    resources: [{
      kind: 'database', identity: 'test-db', access: 'exclusive', expectedPreimageHash: null,
      owner: 'work-1', ownershipMode: 'exclusive-lease',
    }],
    allowedReads: ['request-envelope'], forbiddenChanges: ['No unowned mutation.'],
    successChecklist: [{ id: 'success-1', description: 'The exact finding is closed.' }],
    checks: ['focused hostile check'], resultLocation: 'work/results/work-1.json',
    assignedAt: '2026-08-22T00:00:00Z',
  }
  assertSchemaValid(assignment, schema, 'context-loss assignment')
  for (const mutate of [
    value => { value.findingIds = [] },
    value => { delete value.resources[0].owner },
    value => { delete value.resources[0].ownershipMode },
    value => { value.resources[0].kind = 'untyped-resource' },
  ]) {
    const malformed = clone(assignment)
    mutate(malformed)
    assert.notDeepEqual(schemaErrors(malformed, schema), [])
  }
})

test('required-check registry supplies one acyclic graph per route, named owners, effects, and bounded failure policy', () => {
  assertGateSemantics(gates)
  const selection = {
    baseWorkType: 'debug-fix',
    resultFormat: 'changed-files',
    artifactOverlays: ['executable-code', 'external-system'],
    acceptanceOverlays: ['failing-to-passing-behavior', 'receipts'],
    riskOverlays: ['authorization-security-privacy', 'concurrency-or-shared-state'],
    riskEvidence: {
      'authorization-security-privacy': 'The change reads protected account state.',
      'concurrency-or-shared-state': 'Two requests can update the same record.',
    },
  }
  const composed = composeChecks(selection)
  assert.equal(composed.baseWorkType, 'debug-fix')
  assert.deepEqual(composed.artifactOverlays, ['executable-code', 'external-system'])
  assert.ok(composed.requiredCheckKinds.includes('behavior'))
  assert.ok(composed.requiredCheckKinds.includes('receipts'))
  assert.equal(composed.riskChecks.length, 2, 'multiple risks compose instead of replacing each other')
  const unknownOverlay = clone(selection)
  unknownOverlay.artifactOverlays.push('mystery-output')
  assert.notDeepEqual(compositionErrors(unknownOverlay), [])
  const duplicateOverlay = clone(selection)
  duplicateOverlay.artifactOverlays.push('executable-code')
  assert.notDeepEqual(compositionErrors(duplicateOverlay), [])
  const missingRiskEvidence = clone(selection)
  delete missingRiskEvidence.riskEvidence['concurrency-or-shared-state']
  assert.notDeepEqual(compositionErrors(missingRiskEvidence), [])
  const incompatible = {
    baseWorkType: 'inspect-report', resultFormat: 'read-only-findings', artifactOverlays: ['read-only-result'],
    acceptanceOverlays: ['receipts'], riskOverlays: ['destructive-migration'],
    riskEvidence: { 'destructive-migration': 'The proposed action would remove stored data.' },
  }
  assert.notDeepEqual(compositionErrors(incompatible), [])
  const receiptsOnlyDebug = {
    baseWorkType: 'debug-fix', resultFormat: 'changed-files', artifactOverlays: ['executable-code'],
    acceptanceOverlays: ['receipts'], riskOverlays: [], riskEvidence: {},
  }
  assert.notDeepEqual(compositionErrors(receiptsOnlyDebug), [], 'debug work needs behavior proof')
  const docsOnlyExternal = {
    baseWorkType: 'external-operation', resultFormat: 'external-receipt', artifactOverlays: ['documentation'],
    acceptanceOverlays: ['documentation-example'], riskOverlays: [], riskEvidence: {},
  }
  assert.notDeepEqual(compositionErrors(docsOnlyExternal), [], 'external work needs transaction receipts')
  const validExternal = {
    baseWorkType: 'external-operation', resultFormat: 'external-receipt',
    artifactOverlays: ['external-system'],
    acceptanceOverlays: ['receipts', 'external-prepare', 'external-commit', 'external-reconcile',
      'external-rollback', 'external-idempotency'],
    riskOverlays: ['external-write-or-cost'],
    riskEvidence: { 'external-write-or-cost': 'The authorized operation writes remote state.' },
  }
  assert.deepEqual(compositionErrors(validExternal), [])
  const writingInspection = {
    baseWorkType: 'inspect-report', resultFormat: 'read-only-findings',
    artifactOverlays: ['read-only-result'], acceptanceOverlays: ['exact-diff'],
    riskOverlays: [], riskEvidence: {},
  }
  assert.notDeepEqual(compositionErrors(writingInspection), [], 'inspection cannot use write acceptance')
  const unknownCheck = clone(gates)
  unknownCheck.routeGraphs.DIRECT.required.unknown = []
  assert.throws(() => assertGateSemantics(unknownCheck), /registered/)
  const cycle = clone(gates)
  cycle.routeGraphs.LIGHT.required['success-definition'] = ['final-record']
  assert.throws(() => assertGateSemantics(cycle), /acyclic|one final node/)
  const proseRetry = clone(gates)
  proseRetry.definitions['produce-work'].retryPolicy = 'retry while useful'
  assert.notDeepEqual(schemaErrors(proseRetry, contractSchema(gates)), [])
  const unboundedRetry = clone(gates)
  unboundedRetry.definitions['produce-work'].retryPolicy.maxAttempts = 100
  assert.notDeepEqual(schemaErrors(unboundedRetry, contractSchema(gates)), [])
  assert.throws(() => assertGateSemantics(unboundedRetry), /finite bound|maxAttempts/)
  const missingOracle = clone(gates)
  delete missingOracle.definitions['behavior-test'].execution.oracle
  assert.notDeepEqual(schemaErrors(missingOracle, contractSchema(gates)), [])
  const missingNegativePath = clone(gates)
  missingNegativePath.definitions['independent-check'].execution.negativePaths = []
  assert.notDeepEqual(schemaErrors(missingNegativePath, contractSchema(gates)), [])
  const driftedEdge = clone(gates)
  driftedEdge.routeGraphs.DIRECT.edges.pop()
  assert.throws(() => assertGateSemantics(driftedEdge), /dependency edge/)
  const falseTerminationBound = clone(gates)
  falseTerminationBound.routeGraphs.ROADMAP.maxTransitions = 1
  assert.throws(() => assertGateSemantics(falseTerminationBound), /finite bound/)
})

test('provider projection is Codex-first, explicit for all nine providers, and fails closed while support is unverified', () => {
  assertSchemaValid(providers, contractSchema(providers), 'pre-canary provider projection')
  assertProviderSemantics(providers)
  const nonCodexPending = clone(providers)
  nonCodexPending.providers.find(provider => provider.id === 'claude').attestationRequired = true
  assert.notDeepEqual(schemaErrors(nonCodexPending, contractSchema(nonCodexPending)), [])
  const missingCapability = clone(providers)
  delete missingCapability.providers[0].capabilities.eventStreaming
  assert.throws(() => assertProviderSemantics(missingCapability))
  const optimisticUnknown = clone(providers)
  optimisticUnknown.admissionPolicy.unknown = 'continue'
  assert.throws(() => assertProviderSemantics(optimisticUnknown))
  const attestation = {
    schemaVersion: '2.0.0', attestationId: 'attest-0001', providerId: 'codex',
    issuer: 'autoprompt-provider-conformance', issuedAt: '2026-08-21T00:00:00Z',
    expiresAt: '2026-08-22T00:00:00Z',
    signature: { algorithm: 'ed25519', keyId: H, value: 'A'.repeat(43) },
    runtimeIdentityHash: H, activationNonce: 'abcdefghijklmnop',
    providerAdmissionSha256: H,
    supportedEnvironment: {
      platform: 'win32', arch: 'x64', codexExecutableBasename: 'codex.exe',
      codexExecutableSha256: H, codexExecutableVersion: 'codex-cli fixture-1.0',
    },
    verificationMethod: 'live-conformance-suite', verifiedCapabilities: ['isolation'], result: 'supported',
  }
  assertSchemaValid(attestation, providers.verificationAttestationSchema, 'provider attestation')
  const verified = clone(providers)
  verified.providers[0].implementationStatus = 'verified'
  verified.providers[0].verificationAttestation = attestation
  assertSchemaValid(verified, contractSchema(verified), 'verified provider projection')
  assertProviderSemantics(verified)
  const unsigned = clone(attestation)
  delete unsigned.issuer
  assert.notDeepEqual(schemaErrors(unsigned, providers.verificationAttestationSchema), [])
  const expired = clone(verified)
  expired.providers[0].verificationAttestation.expiresAt = '2026-08-20T00:00:00Z'
  assert.throws(() => assertProviderSemantics(expired), /currentable/)
})

test('runtime schemas reject malformed settings, recommendations, decisions, evidence, events, outcomes, and reports', () => {
  const settingsSchema = readJson(product.runtimeSchemas.settings)
  const settings = {
    schemaVersion: '2.0.0',
    status: 'READY', ready: true, inspectionAllowed: true,
    providerId: 'codex',
    interactionMode: 'headless',
    concurrency: {
      friendlyMode: 'tokensaver',
      effectiveMaxSubs: 6,
      providerMaximum: 10,
      resolvedFrom: 'explicit-invocation',
    },
    modelRouting: { supported: false, selectedBy: 'provider-unsupported' },
    resolvedAt: '2026-08-21T00:00:00Z',
  }
  assertSchemaValid(settings, settingsSchema, 'settings')
  const tooWide = clone(settings)
  tooWide.concurrency.effectiveMaxSubs = 7
  assert.notDeepEqual(schemaErrors(tooWide, settingsSchema), [])
  const aboveProviderCap = clone(settings)
  aboveProviderCap.concurrency.providerMaximum = 3
  aboveProviderCap.concurrency.effectiveMaxSubs = 4
  assert.notDeepEqual(schemaErrors(aboveProviderCap, settingsSchema), [])
  const pinned = clone(settings)
  pinned.modelRouting = {
    supported: true,
    model: 'gpt-example',
    explicitUserModelPin: 'gpt-example',
    selectedBy: 'user-pin',
  }
  assertSchemaValid(pinned, settingsSchema, 'explicit model pin is the resolved value')
  const conflictingPin = clone(pinned)
  conflictingPin.modelRouting.model = 'different-model'
  assert.equal(runtimeSettings.validateResolvedSettings(conflictingPin).valid, false)
  const pinIgnored = clone(settings)
  pinIgnored.modelRouting = {
    supported: true,
    model: 'gpt-example',
    explicitUserModelPin: 'gpt-example',
    selectedBy: 'automatic',
  }
  assert.notDeepEqual(schemaErrors(pinIgnored, settingsSchema), [])

  const recommendationSchema = readJson(product.runtimeSchemas.routeRecommendation)
  const recommendation = {
    schemaVersion: '2.0.0',
    preWorkResult: 'CONTINUE',
    recommendedRoute: 'DIRECT',
    confidence: 'high',
    whatTheUserWants: ['Fix the bounded behavior.'],
    likelyAreas: ['src/example.js'],
    howSuccessCanBeChecked: ['node --test'],
    unknowns: [], risks: [], independentWorkItems: [], dependencies: [],
    reasonsForDirect: ['One bounded behavior and a known check.'],
    reasonsForLight: ['No short design choice is open.'],
    reasonsForRoadmap: ['No dependent work groups exist.'],
    userInputNeeded: [], evidenceIndex: [],
  }
  assertSchemaValid(recommendation, recommendationSchema, 'recommendation')
  const missingRouteReason = clone(recommendation)
  missingRouteReason.reasonsForRoadmap = []
  assert.notDeepEqual(schemaErrors(missingRouteReason, recommendationSchema), [])
  const illegalNeedsUserRoute = clone(recommendation)
  illegalNeedsUserRoute.preWorkResult = 'NEEDS_USER'
  illegalNeedsUserRoute.userInputNeeded = ['Choose the product behavior.']
  assert.notDeepEqual(schemaErrors(illegalNeedsUserRoute, recommendationSchema), [])

  const decisionSchema = readJson(product.runtimeSchemas.routeDecision)
  assert.deepEqual(decisionSchema.properties.gateSelection, gates.composition.selectionSchema,
    'route decision embeds the one canonical gate selection schema exactly')
  const decision = {
    schemaVersion: '2.0.0', status: 'DECIDED', route: 'DIRECT', routeSource: 'automatic', userInputNeeded: [],
    requestedResult: 'Fix the bounded behavior and retain existing behavior.',
    successChecklist: ['The failing case passes.', 'Existing checks still pass.'],
    plannedChecks: ['node --test'], likelyAreas: ['src/example.js'], risks: [], missingInformation: [],
    existingTests: [{ id: 'planned-check-1', command: 'node --test' }],
    usefulWorkerCount: 1, workerOwnershipReason: 'One owner controls the connected change.',
    independentCheckingPlan: {
      checkerCount: 1,
      responsibilities: ['Review the change and run its tests.'],
      nonOverlapReason: 'One independent checker can use the same toolchain for both jobs.',
    },
    chosenRouteReason: 'The result and real check are known and no design choice is open.',
    rejectedRouteReasons: {
      LIGHT: 'Short planning would not resolve any uncertainty.',
      ROADMAP: 'There are no dependent work groups or integration owner.',
    },
    analystDisagreement: null,
    routeChangeTrigger: {
      event: 'SPEC_MISUNDERSTOOD',
      factRequired: 'A check proves that the requested behavior was interpreted incorrectly.',
    },
    decisionClassifications: [{
      question: 'Which recorded facts determine the route?', class: 'FACTUAL',
      owner: 'evidence-owner', materiality: 'evidence-resolution', requiresUserDecision: false,
    }],
    capturedDomainContracts: [],
    normalizedRouteFacts: { schemaVersion: '2.0.0' },
    routeFactsFingerprint: H, classifierFingerprint: H2,
    acceptance: { terminalResult: 'REPORT_DELIVERED', requiredAcceptance: ['Answer every requested item.'] },
    requiredCapabilities: ['toolOutputCapture'],
    gateSelection: {
      baseWorkType: 'inspect-report', resultFormat: 'read-only-findings',
      artifactOverlays: ['read-only-result'], acceptanceOverlays: ['receipts'],
      riskOverlays: [], riskEvidence: {},
    },
    mutableResourceOwnership: [],
    candidateFreeze: {
      required: false, available: true, environmentCanBeBound: true,
      freezeBeforeIndependentCheck: true, frozenVersionIdRequired: false,
    },
    assurancePreconditions: {
      mutableResourceOwnershipValid: true, candidateFreezeBeforeCheck: true,
      frozenVersionIdRequired: false,
    },
    topology: runtimeRouteDecision.buildRouteTopology('DIRECT', {
      facts: validRouteFacts(), mutableResourceOwnership: [], workerCount: 1,
    }),
    requestEnvelopeHash: H, recommendationHash: H,
    decidedAt: '2026-08-21T00:00:00Z',
  }
  assertSchemaValid(decision, decisionSchema, 'decision')
  const missingRouteSource = clone(decision)
  delete missingRouteSource.routeSource
  assert.notDeepEqual(schemaErrors(missingRouteSource, decisionSchema), [],
    'every persisted route decision requires an immutable route source')
  const invalidRouteSource = clone(decision)
  invalidRouteSource.routeSource = 'route-name-inferred'
  assert.notDeepEqual(schemaErrors(invalidRouteSource, decisionSchema), [],
    'route source must be automatic or explicit_control')
  const capturedDomainSchema = readJson('agents/contracts/schemas/captured-domain.schema.json')
  const capturedDomainCases = [
    {
      valid: {
        schemaVersion: '1.0.0', kind: 'MISSION_SOURCE_CONFLICT', certificateHash: H,
        sourceDataHash: H2, priorCertificateHash: H2, priorSourceDataHash: H3,
        retryAuthority: { mode: 'NEW_SOURCE_DATA', sourceTransitionCertificateHash: H3 },
      },
      break: contract => {
        delete contract.retryAuthority
        contract.explicitUserAuthorityHash = null
      },
    },
    {
      valid: {
        schemaVersion: '1.0.0', kind: 'SIGNATURE_SEARCH', strongestInvariantInventoryHash: H,
        secondCandidateFamily: true, identifiabilityProofHash: H2,
      },
      break: contract => { contract.identifiabilityProofHash = null },
    },
    {
      valid: {
        schemaVersion: '1.0.0', kind: 'FIXTURE_PROVENANCE', fixtureProvenanceHash: H,
        mutationReplayHash: H2, initialStatus: 'RED', executablePrebuildValidationRequired: true,
        executablePrebuildValidationHash: H3,
      },
      break: contract => { contract.initialStatus = 'GREEN' },
    },
    {
      valid: {
        schemaVersion: '1.0.0', kind: 'HIDDEN_EXTERNAL_ORACLE', externalOracleId: 'pixel-oracle',
        verificationRoute: 'EXTERNALLY_VERIFIABLE_ONLY', maxProvisionalWorkerLaunches: 1,
        localDoneAllowed: false,
      },
      break: contract => { contract.maxProvisionalWorkerLaunches = 2 },
    },
    {
      valid: {
        schemaVersion: '1.0.0', kind: 'IMAGE_DATUM', imageEvidenceHash: H,
        selectedInterpretation: { id: 'top', interpretation: 'z=42 is the top datum' },
        alternativeInterpretations: ['z=42 is the center datum'],
        rulingHash: H2, certificateHash: H3,
      },
      break: contract => {
        delete contract.selectedInterpretation
        delete contract.alternativeInterpretations
        contract.competingInterpretations = [
          { id: 'top', interpretation: 'z=42 is the top datum' },
          { id: 'center', interpretation: 'z=42 is the center datum' },
        ]
        contract.selectedInterpretationId = 'not-a-member'
      },
    },
    {
      valid: {
        schemaVersion: '1.0.0', kind: 'DONE_RETRY_PROMOTION', priorDoneCandidateHash: H,
        isolationCertificateHash: H3, requiredAcceptanceIds: ['empty-case'],
      },
      break: contract => {
        delete contract.isolationCertificateHash
        contract.retryCandidateHash = contract.priorDoneCandidateHash
        contract.isolatedWorktreeHash = H3
      },
    },
  ]
  for (const capturedCase of capturedDomainCases) {
    assertSchemaValid(capturedCase.valid, capturedDomainSchema,
      `standalone captured domain ${capturedCase.valid.kind}`)
    const validDecision = clone(decision)
    validDecision.normalizedRouteFacts.capturedIncidentDomains = [capturedCase.valid.kind]
    validDecision.capturedDomainContracts = [capturedCase.valid]
    assertSchemaValid(validDecision, decisionSchema, `captured domain ${capturedCase.valid.kind}`)
    const missingApplicableContract = clone(validDecision)
    missingApplicableContract.capturedDomainContracts = []
    assert.notDeepEqual(schemaErrors(missingApplicableContract, decisionSchema), [],
      `${capturedCase.valid.kind} applicability must require its pre-work contract in schema-only admission`)
    const malformed = clone(validDecision)
    capturedCase.break(malformed.capturedDomainContracts[0])
    assert.notDeepEqual(schemaErrors(malformed.capturedDomainContracts[0], capturedDomainSchema), [],
      `${capturedCase.valid.kind} malformed contract must fail standalone schema validation`)
    assert.notDeepEqual(schemaErrors(malformed, decisionSchema), [],
      `${capturedCase.valid.kind} malformed contract must fail schema-only validation`)
  }
  const noRejectedRoutes = clone(decision)
  delete noRejectedRoutes.rejectedRouteReasons.ROADMAP
  assert.notDeepEqual(schemaErrors(noRejectedRoutes, decisionSchema), [])
  const chosenRouteRejected = clone(decision)
  chosenRouteRejected.rejectedRouteReasons.DIRECT = 'The chosen route cannot also be rejected.'
  delete chosenRouteRejected.rejectedRouteReasons.LIGHT
  assert.notDeepEqual(schemaErrors(chosenRouteRejected, decisionSchema), [])
  const duplicateCheckerWork = clone(decision)
  duplicateCheckerWork.independentCheckingPlan = {
    checkerCount: 2,
    responsibilities: ['Run the exact behavior check.', 'Run the exact behavior check.'],
    nonOverlapReason: 'The responsibilities are improperly duplicated.',
  }
  assert.notDeepEqual(schemaErrors(duplicateCheckerWork, decisionSchema), [])
  const factsForProducer = validRouteFacts()
  const classifiedForProducer = runtimeRouter.classifyRoute(factsForProducer)
  const producedRecommendation = runtimeRouteDecision.createRouteRecommendation(recommendation)
  assertSchemaValid(producedRecommendation, recommendationSchema, 'actual recommendation producer')
  const producedDecision = runtimeRouteDecision.createRouteDecision({
    route: 'DIRECT', routeFacts: factsForProducer,
    requestedResult: 'Fix the bounded behavior and retain existing behavior.',
    successChecklist: ['The requested result passes.'], plannedChecks: ['node --test'],
    existingTests: [{ id: 'planned-check-1', command: 'node --test' }],
    likelyAreas: ['src/example.js'], workers: {
      count: 1, responsibilities: ['Own the bounded result.'],
      nonOverlapReason: 'One worker owns the connected change.',
    },
    mutableResourceOwnership: [], chosenRouteReason: 'The facts select one bounded result.',
    rejectedRouteReasons: {
      LIGHT: 'The bounded request has no planning uncertainty.', ROADMAP: 'No dependent work groups exist.',
    },
    analystComparison: {
      recommendedRoute: 'DIRECT', reason: 'The same facts and classifier select DIRECT.',
      analystFactsFingerprint: classifiedForProducer.facts_fingerprint,
      analystClassifierFingerprint: classifiedForProducer.classifier_fingerprint,
    },
    routeChangeTrigger: { event: 'NEW_ROUTE_FACT', factRequired: 'A canonical route fact changes.' },
    gateSelection: {
      baseWorkType: 'inspect-report', resultFormat: 'read-only-findings',
      artifactOverlays: ['read-only-result'], acceptanceOverlays: ['receipts'],
      riskOverlays: [], riskEvidence: {},
    },
    requestEnvelopeHash: H, recommendationHash: H2, decidedAt: '2026-08-21T00:00:00Z',
  })
  const producedDecisionValidation = runtimeRouteDecision.validateRouteDecision(producedDecision)
  assert.equal(producedDecisionValidation.valid, true, JSON.stringify(producedDecisionValidation.errors))
  assertSchemaValid(producedDecision, decisionSchema, 'actual decision producer')
  const missingGateSelection = clone(producedDecision)
  delete missingGateSelection.gateSelection
  assert.equal(runtimeRouteDecision.validateRouteDecision(missingGateSelection).valid, false)
  const writeAcceptanceOnReport = clone(producedDecision)
  writeAcceptanceOnReport.gateSelection.acceptanceOverlays = ['exact-diff']
  assert.equal(runtimeRouteDecision.validateRouteDecision(writeAcceptanceOnReport).valid, false)
  const topologyJargonAlias = clone(producedDecision)
  topologyJargonAlias.topology.counts.route_analysts = topologyJargonAlias.topology.counts.routeAnalysts
  assert.notDeepEqual(schemaErrors(topologyJargonAlias, decisionSchema), [],
    'private snake-case topology aliases are not canonical v2 fields')
  const managerOnDirect = clone(producedDecision)
  managerOnDirect.topology.workGroupManager = {
    role: 'ap-work-group-manager', physicalRoleId: 'autoprompt.v2.ap-work-group-manager',
    parent: 'mission-coordinator', count: 1, admitted: true, planPath: 'plan/ROADMAP.md',
    minimumUsefulWorkersPerManager: 2, assignedWorkerCount: 2,
    disjointMutableResourceOwnershipRequired: true,
  }
  assert.notDeepEqual(schemaErrors(managerOnDirect, decisionSchema), [],
    'DIRECT cannot smuggle in an L2 manager')
  const unnamedSecondChecker = clone(decision)
  unnamedSecondChecker.independentCheckingPlan = {
    checkerCount: 2,
    responsibilities: ['Review and test everything together.'],
    nonOverlapReason: 'No distinct responsibility is named.',
  }
  assert.notDeepEqual(schemaErrors(unnamedSecondChecker, decisionSchema), [])
  const productChoiceByAgent = clone(decision)
  productChoiceByAgent.decisionClassifications = [{
    question: 'Which public behavior should users receive?', class: 'PRODUCT_SEMANTIC', owner: 'run-owner',
  }]
  assert.notDeepEqual(schemaErrors(productChoiceByAgent, decisionSchema), [])

  const evidenceSchema = readJson(product.runtimeSchemas.evidence)
  const evidence = {
    schemaVersion: '2.0.0', evidenceId: 'evidence:0001', evidenceType: 'behavior-test',
    producedBy: {
      logicalRoleId: 'independent-tester', physicalRoleId: 'autoprompt.v2.independent-tester',
      sessionId: 'session-1', activationNonce: 'abcdefghijklmnop',
    },
    immutable: true,
    versionBinding: {
      requestEnvelopeHash: H, candidate: { workspaceEpoch: 1, manifestHash: H },
      environmentHash: H, checkDefinitionHash: H, assumptionHashes: [],
      contractDigest: H, providerDigest: H, toolDigest: H,
    },
    inputEvidenceIds: [],
    outputs: [{ name: 'test-output', sha256: H, byteLength: 2, mediaType: 'text/plain', truncated: false }],
    status: 'valid', invalidatedBy: [], createdAt: '2026-08-21T00:00:00Z',
  }
  assertSchemaValid(evidence, evidenceSchema, 'evidence')
  const mutableEvidence = clone(evidence)
  mutableEvidence.immutable = false
  assert.notDeepEqual(schemaErrors(mutableEvidence, evidenceSchema), [])
  const silentlyInvalid = clone(evidence)
  silentlyInvalid.status = 'invalidated'
  assert.notDeepEqual(schemaErrors(silentlyInvalid, evidenceSchema), [])

  const eventSchema = readJson(product.runtimeSchemas.stateEvent)
  const event = {
    contractVersion: '2.0.0', transitionId: 'T001', eventId: 'BOOTSTRAP', runId: 'run-0001',
    activationNonce: 'abcdefghijklmnop', sequence: 1, fromState: 'BOOT', toState: 'LOAD_SKILL',
    requestEnvelopeHash: H, targetIdentityHash: H, candidateHash: null,
    evidenceHashes: [], openIds: [], attempt: 1, causalParent: null,
    occurredAt: '2026-08-21T00:00:00Z', humanDescription: 'The explicit run started.',
  }
  const recoveryContext = {
    savedState: 'RUN_WORK', resumeState: 'RUN_WORK', checkpointHash: H, frontierHash: H2,
    frontier: { nextReadyWorkIds: ['work-1'], openCheckIds: [], acceptedResultIds: [] },
    completedMilestones: ['route-analysis', 'route-decision', 'work-preparation'],
    priorOwner: {
      ownerId: 'owner-before-crash', staleOwnerEvidenceHash: H,
      processesDrained: true, processDrainEvidenceHash: H2,
    },
    externalRecovery: { status: 'none', operationIds: [], idempotencyKeys: [], receiptHashes: [] },
    releaseIntentHash: null,
    accountingCheckpoint: { snapshotHash: H3, lastAccountingSequence: 7, lastAccountingHash: H },
  }
  assertSchemaValid(event, eventSchema, 'event')
  const incompleteEvent = clone(event)
  delete incompleteEvent.causalParent
  assert.notDeepEqual(schemaErrors(incompleteEvent, eventSchema), [])
  for (const transition of expandedTransitions(machine)) {
    const canonicalEvent = {
      ...event,
      transitionId: transition.id,
      eventId: transition.event,
      fromState: transition.from,
      toState: transition.to === '$same'
        ? transition.from
        : transition.to === '$savedResumeState'
          ? 'PREPARE_WORK'
          : transition.to === '$savedCheckOrigin' ? 'RUN_WORK' : transition.to,
    }
    if (['T066', 'T077', 'T078'].includes(transition.id)) {
      canonicalEvent.recoveryContext = clone(recoveryContext)
      canonicalEvent.recoveryContext.savedState = transition.id === 'T077' ? transition.from : 'PREPARE_WORK'
      canonicalEvent.recoveryContext.resumeState = transition.id === 'T077' ? transition.from : 'PREPARE_WORK'
    }
    assertSchemaValid(canonicalEvent, eventSchema, `canonical event ${transition.id}:${transition.from}`)
  }
  for (const mutation of [
    { transitionId: 'T999' },
    { eventId: 'UNKNOWN_EVENT' },
    { fromState: 'UNKNOWN_STATE' },
    { toState: 'UNKNOWN_STATE' },
    { transitionId: 'T002' },
  ]) {
    assert.notDeepEqual(schemaErrors({ ...event, ...mutation }, eventSchema), [], JSON.stringify(mutation))
  }
  const invalidTimestamp = clone(event)
  invalidTimestamp.occurredAt = 'not-a-date'
  assert.notDeepEqual(schemaErrors(invalidTimestamp, eventSchema), [])
  invalidTimestamp.occurredAt = '2026-02-30T00:00:00Z'
  assert.notDeepEqual(schemaErrors(invalidTimestamp, eventSchema), [])

  const crashTransition = machine.transitions.find(({ id }) => id === 'T077')
  assert.deepEqual(crashTransition.from, machine.crashRecoveryPolicy.recoverableActiveStates)
  assert.equal(crashTransition.to, 'PAUSED')
  assert.ok(!crashTransition.from.includes('RELEASING_LOCK'))
  assert.equal(machine.crashRecoveryPolicy.releasingLockCrashAction,
    'deterministic-finalizer-reconciles-existing-release-intent')
  const resumeCapabilities = machine.transitions.find(({ id }) => id === 'T078')
  assert.deepEqual([resumeCapabilities.from, resumeCapabilities.to],
    ['CHECK_PROVIDER_CAPABILITIES', 'RESUME_EXACT_STATE'])
  const unsafeExternal = {
    ...event, transitionId: 'T077', eventId: 'CRASH_DETECTED', fromState: 'RUN_WORK', toState: 'PAUSED',
    recoveryContext: {
      ...clone(recoveryContext), resumeState: 'CHECK_WORK',
      externalRecovery: {
        status: 'reconciliation-required', operationIds: ['operation-1'],
        idempotencyKeys: ['idempotency-1'], receiptHashes: [],
      },
    },
  }
  assertSchemaValid(unsafeExternal, eventSchema, 'external crash resumes at reconciliation check')
  const blindRepeat = clone(unsafeExternal)
  blindRepeat.recoveryContext.resumeState = 'RUN_WORK'
  assert.notDeepEqual(schemaErrors(blindRepeat, eventSchema), [])
  const undrained = clone(unsafeExternal)
  undrained.recoveryContext.priorOwner.processesDrained = false
  assert.notDeepEqual(schemaErrors(undrained, eventSchema), [])
  const missingAccounting = clone(unsafeExternal)
  delete missingAccounting.recoveryContext.accountingCheckpoint
  assert.notDeepEqual(schemaErrors(missingAccounting, eventSchema), [])
  assert.equal(machine.crashRecoveryPolicy.checkpointDigest.frontierHashFormula,
    'sha256(stable-json-v1(frontier))')
  assert.deepEqual(machine.crashRecoveryPolicy.checkpointDigest.checkpointHashFields,
    ['savedState', 'resumeState', 'frontierHash', 'completedMilestones', 'priorOwner',
      'externalRecovery', 'releaseIntentHash', 'accountingCheckpoint'])
  const restoreMismatch = {
    ...event, transitionId: 'T066', eventId: 'EXACT_STATE_RESTORED',
    fromState: 'RESUME_EXACT_STATE', toState: 'PREPARE_WORK', recoveryContext: clone(recoveryContext),
  }
  restoreMismatch.recoveryContext.resumeState = 'RUN_WORK'
  assert.notEqual(restoreMismatch.toState, restoreMismatch.recoveryContext.resumeState,
    'runtime must reject an exact-state restore whose target differs from recoveryContext.resumeState')

  const outcomeSchema = readJson(product.runtimeSchemas.outcome)
  const outcome = {
    schemaVersion: '2.0.0', code: 'DONE',
    description: 'Every requested result passed its current required checks.',
    stateClass: 'terminal', runId: 'run-0001', requestEnvelopeHash: H, currentVersionHash: H,
    completedResults: [], nextReadyWork: [],
    cause: { event: 'VERIFIED', reason: 'The final checks passed.', unblockPath: null },
    payloadSchemaId: 'autoprompt.done.v2', payload: {}, recordedAt: '2026-08-21T00:00:00Z',
  }
  assertSchemaValid(outcome, outcomeSchema, 'outcome')
  const unknownOutcome = clone(outcome)
  unknownOutcome.code = 'MAYBE'
  assert.notDeepEqual(schemaErrors(unknownOutcome, outcomeSchema), [])
  const swappedDescription = clone(outcome)
  swappedDescription.description = plain.userVisibleCodes.find(({ code }) => code === 'FAILED').description
  assert.notDeepEqual(schemaErrors(swappedDescription, outcomeSchema), [])
  const wrongTerminalClass = clone(outcome)
  wrongTerminalClass.stateClass = 'resumable'
  assert.notDeepEqual(schemaErrors(wrongTerminalClass, outcomeSchema), [])
  const paused = {
    ...outcome,
    code: 'PAUSED',
    description: plain.userVisibleCodes.find(({ code }) => code === 'PAUSED').description,
    stateClass: 'resumable',
    nextReadyWork: ['work-item-2'],
    cause: {
      event: 'BUDGET_EXHAUSTED_RESUMABLE',
      reason: 'The current execution allowance ended at a safe continuation point.',
      unblockPath: 'Resume this saved run with a renewed execution allowance.',
    },
    payloadSchemaId: 'autoprompt.paused.v2',
    payload: {
      resumeState: 'RUN_WORK', nextReadyWorkIds: ['work-item-2'], remainingBudgetSeconds: 0,
      continuationBindingHash: H,
    },
  }
  assertSchemaValid(paused, outcomeSchema, 'resumable paused outcome')
  for (const mutate of [
    (value) => { value.stateClass = 'terminal' },
    (value) => { value.nextReadyWork = [] },
    (value) => { value.cause.event = 'FAILED' },
    (value) => { value.cause.unblockPath = null },
    (value) => { value.payload = {} },
  ]) {
    const invalidPaused = clone(paused)
    mutate(invalidPaused)
    assert.notDeepEqual(schemaErrors(invalidPaused, outcomeSchema), [])
  }

  const roleReportSchema = readJson(product.runtimeSchemas.roleReport)
  const report = {
    schemaVersion: '2.0.0', reportType: 'result', reportId: 'report-1', runId: 'run-0001',
    assignmentId: 'assignment-1', logicalRoleId: 'worker', physicalRoleId: 'autoprompt.v2.worker',
    requestEnvelopeHash: H, findingIds: ['AP-ROUTE-003'],
    startedAt: '2026-08-21T00:00:00Z', endedAt: '2026-08-21T00:01:00Z',
    filesChanged: ['src/example.js'], resourcesChanged: [], behaviorChanged: ['The bounded case now passes.'],
    commands: [{ command: 'node --test', exitCode: 0, result: 'All focused tests passed.' }],
    successItems: [{ id: 'success-1', status: 'pass', evidenceIds: ['evidence:0001'] }],
    remainingConcerns: [], allAssignedItemsPass: true,
    requestedTransition: { event: 'WORK_ITEM_VERIFIED', reason: 'The assigned result passes.', invalidateEvidenceIds: [] },
  }
  assertSchemaValid(report, roleReportSchema, 'role report')
  const noCommands = clone(report)
  delete noCommands.commands
  assert.notDeepEqual(schemaErrors(noCommands, roleReportSchema), [])
  const assignment = {
    schemaVersion: '2.0.0', reportType: 'assignment', reportId: 'report-2', runId: 'run-0001',
    assignmentId: 'assignment-1', logicalRoleId: 'worker', physicalRoleId: 'autoprompt.v2.worker',
    requestEnvelopeHash: H, findingIds: ['AP-ROUTE-003'], requestedResult: 'Fix the bounded behavior.',
    planReference: {
      planPath: 'plan/ROADMAP.md', sectionId: 'feature:contracts', sectionHash: H,
      workItemId: 'work-item-1', workItemHash: H2,
    },
    resources: [{
      kind: 'file', identity: 'src/example.js', access: 'write', expectedPreimageHash: H,
      owner: 'assignment-1', ownershipMode: 'single-owner',
    }],
    allowedReads: ['src/example.test.js'], forbiddenChanges: ['Do not change public behavior.'],
    successChecklist: [{ id: 'success-1', description: 'The bounded case passes.' }],
    checks: ['node --test'], resultLocation: 'reports/work-item-1.json',
    assignedAt: '2026-08-21T00:00:00Z',
  }
  assertSchemaValid(assignment, roleReportSchema, 'section-bound assignment')
  const managerAssignment = {
    ...assignment,
    reportId: 'report-manager-1', assignmentId: 'manager-assignment-1',
    logicalRoleId: 'ap-work-group-manager', physicalRoleId: 'autoprompt.v2.ap-work-group-manager',
    requestedResult: 'Coordinate the accepted work group without overlapping mutable resources.',
    workGroupAdmission: {
      route: 'ROADMAP', parentRoleId: 'mission-coordinator', managerRoleId: 'ap-work-group-manager',
      usefulWorkerCount: 2, disjointMutableResourceOwnershipRequired: true,
      workerAssignments: [
        {
          workerAssignmentId: 'worker-a', workerLogicalRoleId: 'worker', workerMode: 'implementation',
          mutableResourceIdentities: ['file:src/a.js'],
        },
        {
          workerAssignmentId: 'worker-b', workerLogicalRoleId: 'worker', workerMode: 'research',
          mutableResourceIdentities: ['output:reports/b.json'],
        },
      ],
    },
  }
  assert.deepEqual(workGroupAdmissionErrors(managerAssignment, roleReportSchema), [])
  const singleWorkerManager = clone(managerAssignment)
  singleWorkerManager.workGroupAdmission.usefulWorkerCount = 1
  singleWorkerManager.workGroupAdmission.workerAssignments.pop()
  assert.notDeepEqual(workGroupAdmissionErrors(singleWorkerManager, roleReportSchema), [],
    'manager cannot wrap one worker')
  const overlappingManager = clone(managerAssignment)
  overlappingManager.workGroupAdmission.workerAssignments[1].mutableResourceIdentities = ['file:src/a.js']
  assert.notDeepEqual(workGroupAdmissionErrors(overlappingManager, roleReportSchema), [],
    'manager worker ownership must be disjoint')
  const nonManagerAdmission = clone(managerAssignment)
  nonManagerAdmission.logicalRoleId = 'worker'
  nonManagerAdmission.physicalRoleId = 'autoprompt.v2.worker'
  assert.notDeepEqual(schemaErrors(nonManagerAdmission, roleReportSchema), [],
    'only the canonical manager carries work-group admission')
  const floatingAssignment = clone(assignment)
  delete floatingAssignment.planReference.sectionHash
  assert.notDeepEqual(schemaErrors(floatingAssignment, roleReportSchema), [])
  const extraReportField = clone(report)
  extraReportField.uncontractedClaim = true
  assert.notDeepEqual(schemaErrors(extraReportField, roleReportSchema), [])
})

test('request and run-record schemas keep exact bytes separate from parsed controls and enforce the canonical case-sensitive layout', () => {
  const requestSchema = readJson(product.runtimeSchemas.requestEnvelopeEntry)
  const objectRef = {
    objectId: 'exact-invocation:object-1', sha256: H, byteLength: 4, mediaType: 'application/octet-stream',
    storagePath: `request/objects/sha256/${H}`, purpose: 'exact-invocation', derivedFromSha256: null,
    bindingRef: `exact-invocation:${H}`,
    derivation: { method: 'captured-exact-bytes', sourceRole: null, sourceSha256: null },
  }
  const header = {
    schemaVersion: '2.0.0', entryType: 'envelope-header', runId: 'run-0001', sequence: 0,
    previousEntryHash: null, entryHash: H, recordedAt: '2026-08-21T00:00:00Z', envelopeId: 'envelope-1',
    exactInvocationObject: objectRef,
    parsedControlsObject: {
      ...objectRef, objectId: 'parsed-controls:object-2', sha256: H2, storagePath: `request/objects/sha256/${H2}`,
      purpose: 'parsed-controls', derivedFromSha256: H,
      bindingRef: `parsed-controls:${H2}`,
      derivation: { method: 'parse-controls-v2', sourceRole: 'exact-invocation', sourceSha256: H },
    },
    canonicalRequestObject: {
      ...objectRef, objectId: 'canonical-request:object-3', sha256: H3, storagePath: `request/objects/sha256/${H3}`,
      purpose: 'canonical-request', derivedFromSha256: H,
      bindingRef: `canonical-request:${H3}`,
      derivation: { method: 'canonicalize-request-v2', sourceRole: 'exact-invocation', sourceSha256: H },
    },
  }
  assertSchemaValid(header, requestSchema, 'request header')
  const assertObjectBindings = (entry) => {
    const refs = [entry.exactInvocationObject, entry.parsedControlsObject, entry.canonicalRequestObject]
    assert.equal(new Set(refs.map(({ objectId }) => objectId)).size, 3, 'object ids are distinct')
    assert.equal(new Set(refs.map(({ sha256 }) => sha256)).size, 3, 'object content hashes are distinct')
    for (const ref of refs) {
      assert.equal(ref.storagePath, `request/objects/sha256/${ref.sha256}`, 'storage path binds content hash')
    }
    assert.equal(entry.exactInvocationObject.purpose, 'exact-invocation')
    assert.equal(entry.exactInvocationObject.bindingRef, `exact-invocation:${entry.exactInvocationObject.sha256}`)
    assert.equal(entry.exactInvocationObject.derivedFromSha256, null)
    assert.equal(entry.parsedControlsObject.purpose, 'parsed-controls')
    assert.equal(entry.canonicalRequestObject.purpose, 'canonical-request')
    assert.equal(entry.parsedControlsObject.bindingRef, `parsed-controls:${entry.parsedControlsObject.sha256}`)
    assert.equal(entry.canonicalRequestObject.bindingRef,
      `canonical-request:${entry.canonicalRequestObject.sha256}`)
    assert.equal(entry.parsedControlsObject.derivedFromSha256, entry.exactInvocationObject.sha256,
      'parsed derivedFromSha256 binds exact invocation')
    assert.equal(entry.canonicalRequestObject.derivedFromSha256, entry.exactInvocationObject.sha256,
      'canonical derivedFromSha256 binds exact invocation')
    assert.equal(entry.parsedControlsObject.derivation.sourceSha256, entry.exactInvocationObject.sha256,
      'parsed derivation binds exact invocation')
    assert.equal(entry.canonicalRequestObject.derivation.sourceSha256, entry.exactInvocationObject.sha256,
      'canonical derivation binds exact invocation')
  }
  assertObjectBindings(header)
  const mergedControls = clone(header)
  delete mergedControls.parsedControlsObject
  assert.notDeepEqual(schemaErrors(mergedControls, requestSchema), [])
  const aliasedControls = clone(header)
  aliasedControls.parsedControlsObject = clone(aliasedControls.exactInvocationObject)
  assert.notDeepEqual(schemaErrors(aliasedControls, requestSchema), [])
  const semanticallyAliasedControls = clone(header)
  semanticallyAliasedControls.parsedControlsObject.objectId = header.exactInvocationObject.objectId
  semanticallyAliasedControls.parsedControlsObject.bindingRef = header.exactInvocationObject.bindingRef
  assert.notDeepEqual(schemaErrors(semanticallyAliasedControls, requestSchema), [])
  const unboundControls = clone(header)
  unboundControls.parsedControlsObject.derivedFromSha256 = H2
  assert.throws(() => assertObjectBindings(unboundControls), /derivedFromSha256/)
  const pathHashMismatch = clone(header)
  pathHashMismatch.canonicalRequestObject.storagePath = `request/objects/sha256/${H2}`
  assert.throws(() => assertObjectBindings(pathHashMismatch), /storage path binds/)
  const extraHeaderField = clone(header)
  extraHeaderField.uncontracted = true
  assert.notDeepEqual(schemaErrors(extraHeaderField, requestSchema), [])

  const runSchema = readJson(product.runtimeSchemas.runRecord)
  assert.equal(runSchema.properties.paths.properties.roadmapPlan.const, 'plan/ROADMAP.md')
  assert.equal(runSchema.properties.paths.additionalProperties, false)
  assert.equal(runSchema.properties.runRoot.properties.noFollowChecked.const, true)
  assert.equal(runSchema.properties.sourceControlProtection.properties.trackedFiles.const, 0)
  assert.equal(runSchema.properties.sourceControlProtection.properties.stagedFiles.const, 0)
  assert.equal(runSchema.properties.privacy.properties.automaticUpload.const, false)
  assert.notEqual(runSchema.properties.paths.properties.roadmapPlan.const, 'plan/roadmap.md')
  assert.equal(runSchema.properties.paths.properties.accountingRecords.const, 'runtime/accounting.jsonl')
  assert.equal(runSchema.properties.paths.properties.accountingSnapshot.const, 'runtime/budget.json')
  assert.equal(runSchema.properties.paths.properties.aliasTelemetry.const, 'compatibility/alias-telemetry.jsonl')
})

test('runtime accounting is hash chained, monotonic, exact by category, and snapshot-bound to immutable ceilings', () => {
  assert.equal(product.runtimeAccountingPolicy.recordPath, 'runtime/accounting.jsonl')
  assert.equal(product.runtimeAccountingPolicy.snapshotPath, 'runtime/budget.json')
  assert.equal(product.runtimeAccountingPolicy.implicitUnlimitedAllowed, false)
  assert.deepEqual(product.runtimeAccountingPolicy.requiredCeilingFields, [
    'wallMilliseconds', 'totalTokens', 'sessions', 'launches', 'retries', 'costMicrounits',
    'finalizationReserveMilliseconds',
  ])
  const base = {
    schemaVersion: '2.0.0', runId: 'run-0001', activationId: 'activation-001',
    activationNonce: 'activation_nonce_0001', generation: 1,
    stateEventSequence: 7, stateEventHash: H,
    monotonicClock: {
      source: 'process-monotonic-clock', bootId: 'test-boot',
      previousObservedMilliseconds: null, observedMilliseconds: 1000,
    },
    cumulative: {
      launches: 1, retries: 0, sessions: 1, elapsedMilliseconds: 100,
      costMicrounits: 120,
      tokenUsage: { noncachedInput: 10, cachedInput: 2, output: 4, reasoning: 3 },
    },
    delta: {
      launches: 1, retries: 0, sessions: 1, elapsedMilliseconds: 100,
      costMicrounits: 120,
      tokenUsage: { noncachedInput: 10, cachedInput: 2, output: 4, reasoning: 3 },
    },
    cause: { kind: 'LAUNCH', causeId: 'launch:worker-1', humanDescription: 'Started one assigned worker.' },
    sequence: 1, previousHash: null, entryHash: H,
    occurredAt: '2026-08-21T00:00:00Z',
  }
  base.entryHash = accountingEntryHash(base)
  const second = clone(base)
  second.stateEventSequence = 8
  second.stateEventHash = H2
  second.monotonicClock.previousObservedMilliseconds = 1000
  second.monotonicClock.observedMilliseconds = 1500
  second.cumulative = {
    launches: 1, retries: 1, sessions: 1, elapsedMilliseconds: 600,
    costMicrounits: 180,
    tokenUsage: { noncachedInput: 12, cachedInput: 5, output: 8, reasoning: 4 },
  }
  second.delta = {
    launches: 0, retries: 1, sessions: 0, elapsedMilliseconds: 500,
    costMicrounits: 60,
    tokenUsage: { noncachedInput: 2, cachedInput: 3, output: 4, reasoning: 1 },
  }
  second.cause = { kind: 'RETRY', causeId: 'retry:worker-1:1', humanDescription: 'Recorded one bounded retry.' }
  second.sequence = 2
  second.previousHash = base.entryHash
  second.occurredAt = '2026-08-21T00:00:01Z'
  second.entryHash = accountingEntryHash(second)
  assert.deepEqual(accountingSequenceErrors([base, second], accountingRecordSchema), [])

  const decrease = clone(second)
  decrease.cumulative.costMicrounits = 100
  decrease.delta.costMicrounits = -20
  decrease.entryHash = accountingEntryHash(decrease)
  assert.notDeepEqual(accountingSequenceErrors([base, decrease], accountingRecordSchema), [], 'decrease fails')
  const gap = clone(second)
  gap.sequence = 3
  gap.entryHash = accountingEntryHash(gap)
  assert.notDeepEqual(accountingSequenceErrors([base, gap], accountingRecordSchema), [], 'sequence gap fails')
  const rollback = clone(second)
  rollback.monotonicClock.observedMilliseconds = 999
  rollback.entryHash = accountingEntryHash(rollback)
  assert.notDeepEqual(accountingSequenceErrors([base, rollback], accountingRecordSchema), [], 'clock rollback fails')
  const historicalTamper = clone(second)
  historicalTamper.occurredAt = '2026-08-21T00:10:00Z'
  assert.notDeepEqual(accountingSequenceErrors([base, historicalTamper], accountingRecordSchema), [], 'hash tamper fails')
  const missingCategory = clone(second)
  delete missingCategory.cumulative.tokenUsage.reasoning
  assert.notDeepEqual(schemaErrors(missingCategory, accountingRecordSchema), [], 'category omission fails')
  const wrongDelta = clone(second)
  wrongDelta.delta.tokenUsage.output = 3
  wrongDelta.entryHash = accountingEntryHash(wrongDelta)
  assert.notDeepEqual(accountingSequenceErrors([base, wrongDelta], accountingRecordSchema), [], 'inexact delta fails')

  const snapshot = {
    schemaVersion: '2.0.0', runId: second.runId, activationId: second.activationId,
    activationNonce: second.activationNonce, generation: second.generation,
    lastAccountingSequence: second.sequence, lastAccountingHash: second.entryHash,
    stateEventSequence: second.stateEventSequence, stateEventHash: second.stateEventHash,
    monotonicClock: clone(second.monotonicClock), cumulative: clone(second.cumulative),
    ceilings: {
      wallMilliseconds: 10000, totalTokens: 1000, sessions: 4, launches: 10,
      retries: 3, costMicrounits: 5000, verificationReserveMilliseconds: 500,
      finalizationReserveMilliseconds: 1000,
    },
    ceilingContractHash: H, snapshotHash: H,
    recordedAt: '2026-08-21T00:00:02Z',
  }
  snapshot.ceilingContractHash = sha256Stable(snapshot.ceilings)
  snapshot.snapshotHash = accountingSnapshotHash(snapshot)
  assert.deepEqual(accountingSnapshotErrors(snapshot, accountingSnapshotSchema, second), [])
  const missingVerificationReserve = clone(snapshot)
  delete missingVerificationReserve.ceilings.verificationReserveMilliseconds
  missingVerificationReserve.ceilingContractHash = sha256Stable(missingVerificationReserve.ceilings)
  missingVerificationReserve.snapshotHash = accountingSnapshotHash(missingVerificationReserve)
  assert.notDeepEqual(accountingSnapshotErrors(missingVerificationReserve, accountingSnapshotSchema, second), [],
    'missing verification reserve fails')
  const invalidVerificationReserve = clone(snapshot)
  invalidVerificationReserve.ceilings.verificationReserveMilliseconds = -1
  invalidVerificationReserve.ceilingContractHash = sha256Stable(invalidVerificationReserve.ceilings)
  invalidVerificationReserve.snapshotHash = accountingSnapshotHash(invalidVerificationReserve)
  assert.notDeepEqual(accountingSnapshotErrors(invalidVerificationReserve, accountingSnapshotSchema, second), [],
    'invalid verification reserve fails')
  const stale = clone(snapshot)
  stale.lastAccountingSequence = 1
  stale.snapshotHash = accountingSnapshotHash(stale)
  assert.notDeepEqual(accountingSnapshotErrors(stale, accountingSnapshotSchema, second), [], 'stale snapshot fails')
  const changedCeiling = clone(snapshot)
  changedCeiling.ceilings.retries = 4
  changedCeiling.snapshotHash = accountingSnapshotHash(changedCeiling)
  assert.notDeepEqual(accountingSnapshotErrors(changedCeiling, accountingSnapshotSchema, second), [],
    'ceiling replacement without matching immutable ceiling hash fails')
  const exceeded = clone(snapshot)
  exceeded.ceilings.retries = 1
  exceeded.ceilingContractHash = sha256Stable(exceeded.ceilings)
  exceeded.cumulative.retries = 2
  exceeded.snapshotHash = accountingSnapshotHash(exceeded)
  assert.notDeepEqual(accountingSnapshotErrors(exceeded, accountingSnapshotSchema, second), [], 'ceiling excess fails')
})

test('plain-language lint fails forbidden prose and every user-visible code has one standalone golden description', () => {
  assert.deepEqual(plain.instructionFields,
    ['whatToRead', 'whatToDo', 'whatNotToChange', 'howToCheck', 'whatToReturn'])
  assert.equal(plain.lintPolicy.mode, 'fail')
  assert.equal(plain.lintPolicy.unapprovedExceptionResult, 'fail')
  const forbidden = Object.keys(plain.avoid).map((term) => new RegExp(`\\b${term.replace(' ', '\\s+')}\\b`, 'i'))
  const descriptions = [
    product.product.humanDescription,
    ...product.invariants.map(({ humanDescription }) => humanDescription),
    roles.orchestratorContract.humanDescription,
    ...roles.roles.map(({ humanDescription }) => humanDescription),
    ...machine.transitions.flatMap(({ guard, effect }) => [guard, effect]),
    ...plain.userVisibleCodes.map(({ description }) => description),
  ]
  for (const description of descriptions) {
    for (const pattern of forbidden) assert.doesNotMatch(description, pattern, description)
  }
  for (const promptSource of product.generationPolicy.authoritativePromptSources) {
    const source = fs.readFileSync(path.join(ROOT, promptSource), 'utf8')
    const prose = source
      .replace(/^---[\s\S]*?---\s*/u, '')
      .replace(/`[^`]*`/gu, '')
    for (const pattern of forbidden) assert.doesNotMatch(prose, pattern, promptSource)
  }
  const outcomeCodes = readJson(product.runtimeSchemas.outcome).properties.code.enum.slice().sort()
  assert.deepEqual(plain.userVisibleCodes.map(({ code }) => code).sort(), outcomeCodes)
  assert.equal(new Set(plain.userVisibleCodes.map(({ code }) => code)).size, plain.userVisibleCodes.length)
  for (const { code, description } of plain.userVisibleCodes) {
    assert.match(code, /^[A-Z][A-Z0-9_]+$/)
    assert.match(description, /^[A-Z].*[.!]$/)
    assert.ok(description.split(/\s+/u).length >= 7, `${code} description stands alone`)
  }
  const badCode = clone(plain)
  delete badCode.userVisibleCodes[0].description
  assert.notDeepEqual(schemaErrors(badCode, contractSchema(plain)), [])
  const outcomeSchema = readJson(product.runtimeSchemas.outcome)
  const descriptionBranches = outcomeSchema.allOf.find(({ oneOf }) => oneOf).oneOf
  const goldenDescriptions = new Map(descriptionBranches.map((branch) => [
    branch.properties.code.const,
    branch.properties.description.const,
  ]))
  const assertGoldenDescriptions = (contract) => {
    for (const { code, description } of contract.userVisibleCodes) {
      assert.equal(description, goldenDescriptions.get(code), `${code} uses its golden standalone description`)
    }
  }
  assertGoldenDescriptions(plain)
  const swapped = clone(plain)
  ;[swapped.userVisibleCodes[0].description, swapped.userVisibleCodes[1].description] =
    [swapped.userVisibleCodes[1].description, swapped.userVisibleCodes[0].description]
  assert.throws(() => assertGoldenDescriptions(swapped), /golden standalone description/)
  const meaningless = clone(plain)
  meaningless.userVisibleCodes[0].description = 'Something happened.'
  assert.throws(() => assertGoldenDescriptions(meaningless), /golden standalone description/)
  assert.deepEqual(plain.userVisibleCodeFields.required, ['code', 'description'])
})
