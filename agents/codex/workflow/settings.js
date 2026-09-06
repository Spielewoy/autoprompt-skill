#!/usr/bin/env node
'use strict'

const SETTINGS_SCHEMA = require('../../contracts/schemas/settings.schema.json')
const { validateJsonSchema } = require('./json-schema-validator.js')
const SETTINGS_SCHEMA_VERSION = '2.0.0'
const SETTINGS_SCHEMA_ID = SETTINGS_SCHEMA.$id
const SETTINGS_PRECEDENCE = Object.freeze(['explicit', 'run', 'saved'])
const CONCURRENCY_MODES = Object.freeze(['tokensaver', 'wide', 'custom'])
const PATH_VALUES = Object.freeze(['auto', 'direct', 'light', 'roadmap'])
const TOKENSAVER_MAX_SUBS = 6
const CANONICAL_SOURCES = Object.freeze({
  explicit: 'explicit-invocation',
  run: 'resumable-run-manifest',
  saved: 'saved-user-preference',
})

function isObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function own(object, key) {
  return isObject(object) && Object.prototype.hasOwnProperty.call(object, key)
}

function firstOwn(object, keys) {
  for (const key of keys) {
    if (own(object, key)) return object[key]
  }
  return undefined
}

function sourceSettings(value) {
  if (!isObject(value)) return {}
  return isObject(value.settings) ? value.settings : value
}

function positiveInteger(value) {
  if (typeof value !== 'number' && typeof value !== 'string') return null
  if (typeof value === 'string' && !/^\d+$/.test(value.trim())) return null
  const number = typeof value === 'number' ? value : Number(value)
  return Number.isSafeInteger(number) && number > 0 ? number : null
}

function concurrencyFrom(value) {
  const source = sourceSettings(value)
  const nested = isObject(source.concurrency) ? source.concurrency : {}
  return {
    present: own(source, 'concurrency') || [
      'mode', 'concurrencyMode', 'concurrency_mode', 'maxSubs', 'max_subs',
    ].some(key => own(source, key)),
    mode: firstOwn(nested, ['mode', 'friendlyMode', 'friendlyName', 'friendly_name']) ??
      firstOwn(source, ['mode', 'concurrencyMode', 'concurrency_mode']),
    maxSubs: firstOwn(nested, [
      'maxSubs', 'max_subs', 'requestedMaxSubs', 'requested_max_subs',
      'effectiveMaxSubs', 'effective_max_subs',
    ]) ?? firstOwn(source, ['maxSubs', 'max_subs']),
  }
}

function providerMax(options) {
  const provider = isObject(options.provider) ? options.provider : {}
  const capabilities = isObject(options.capabilities) ? options.capabilities : {}
  const raw = firstOwn(provider, [
    'wideMaxSubs', 'wide_max_subs', 'maxSubs', 'max_subs',
    'maxConcurrentThreads', 'max_concurrent_threads',
  ]) ?? firstOwn(capabilities, [
    'wideMaxSubs', 'wide_max_subs', 'maxSubs', 'max_subs',
    'maxConcurrentThreads', 'max_concurrent_threads',
  ])
  if (raw === undefined) return null
  return positiveInteger(raw)
}

function selectConcurrency(options) {
  for (const name of SETTINGS_PRECEDENCE) {
    const candidate = concurrencyFrom(options[name])
    if (candidate.present) return { ...candidate, source: name }
  }
  return null
}

function pathFrom(value) {
  const source = sourceSettings(value)
  const nested = isObject(source.path) ? source.path : null
  return {
    present: own(source, 'path'),
    value: nested
      ? firstOwn(nested, ['requested', 'value', 'route'])
      : source.path,
  }
}

function selectPath(options) {
  for (const name of SETTINGS_PRECEDENCE) {
    const candidate = pathFrom(options[name])
    if (candidate.present) return { ...candidate, source: name }
  }
  return { present: false, value: 'auto', source: null }
}

function normalizePath(candidate, issues) {
  const value = typeof candidate.value === 'string' ? candidate.value.trim().toLowerCase() : ''
  if (!PATH_VALUES.includes(value)) {
    issues.push({
      field: 'path',
      code: candidate.value == null || candidate.value === '' ? 'MISSING' : 'INVALID',
      source: candidate.source,
      supported_values: PATH_VALUES.slice(),
    })
    return null
  }
  if (value === 'auto') {
    return {
      requested: 'auto',
      mode: 'automatic',
      exactRoute: null,
      resolvedFrom: candidate.source ? CANONICAL_SOURCES[candidate.source] : 'automatic',
    }
  }
  return {
    requested: value,
    mode: 'exact',
    exactRoute: value.toUpperCase(),
    resolvedFrom: CANONICAL_SOURCES[candidate.source],
  }
}

function normalizeConcurrency(candidate, options, issues) {
  if (!candidate) {
    issues.push({ field: 'concurrency.mode', code: 'MISSING', source: null })
    return null
  }

  const mode = typeof candidate.mode === 'string' ? candidate.mode.trim().toLowerCase() : ''
  if (!CONCURRENCY_MODES.includes(mode)) {
    issues.push({
      field: 'concurrency.mode',
      code: candidate.mode == null || candidate.mode === '' ? 'MISSING' : 'INVALID',
      source: candidate.source,
      supported_values: CONCURRENCY_MODES.slice(),
    })
    return null
  }

  const runtimeMax = providerMax(options)
  if (runtimeMax === null) {
    issues.push({
      field: 'concurrency.providerMaximum',
      code: 'PROVIDER_CAP_REQUIRED',
      source: 'provider',
    })
    return null
  }

  let requestedMax = null
  let effectiveMax
  if (mode === 'tokensaver') {
    effectiveMax = Math.min(TOKENSAVER_MAX_SUBS, runtimeMax)
  } else if (mode === 'wide') {
    effectiveMax = runtimeMax
  } else {
    requestedMax = positiveInteger(candidate.maxSubs)
    if (requestedMax === null) {
      issues.push({
        field: 'concurrency.max_subs',
        code: candidate.maxSubs == null || candidate.maxSubs === '' ? 'MISSING' : 'INVALID',
        source: candidate.source,
      })
      return null
    }
    effectiveMax = Math.min(requestedMax, runtimeMax)
  }

  return {
    friendlyMode: mode,
    ...(mode === 'custom' ? { requestedMaxSubs: requestedMax } : {}),
    ...(mode === 'wide' ? { providerWideMax: runtimeMax } : {}),
    effectiveMaxSubs: effectiveMax,
    providerMaximum: runtimeMax,
    resolvedFrom: CANONICAL_SOURCES[candidate.source],
  }
}

function modelFields(value) {
  const source = sourceSettings(value)
  const nested = isObject(source.modelRouting)
    ? source.modelRouting
    : (isObject(source.model_routing) ? source.model_routing : {})
  const pins = isObject(nested.pins) ? nested.pins : {}
  const nestedModelPin = isObject(pins.model) ? pins.model.value : pins.model
  const nestedEffortPin = isObject(pins.effort) ? pins.effort.value : pins.effort
  const canonicalSelector = nested.supported === true &&
    ['user-pin', 'automatic', ...Object.values(CANONICAL_SOURCES)].includes(nested.selectedBy)
    ? 'automatic' : undefined
  return {
    selector: firstOwn(nested, ['selector', 'agents', 'mode']) ??
      (!isObject(source.modelRouting) ? source.modelRouting : undefined) ??
      (!isObject(source.model_routing) ? source.model_routing : undefined) ??
      firstOwn(source, ['agents', 'modelSelector', 'model_selector']) ?? canonicalSelector,
    model: firstOwn(nested, ['explicitUserModelPin', 'explicit_user_model_pin', 'modelPin', 'model_pin', 'model']) ?? nestedModelPin ??
      firstOwn(source, ['explicitUserModelPin', 'explicit_user_model_pin', 'modelPin', 'model_pin', 'model']),
    effort: firstOwn(nested, ['explicitUserEffortPin', 'explicit_user_effort_pin', 'effortPin', 'effort_pin', 'effort']) ?? nestedEffortPin ??
      firstOwn(source, ['explicitUserEffortPin', 'explicit_user_effort_pin', 'effortPin', 'effort_pin', 'effort']),
    explicitModelPin: own(nested, 'modelPin') || own(nested, 'model_pin') ||
      own(nested, 'explicitUserModelPin') || own(nested, 'explicit_user_model_pin') ||
      own(source, 'modelPin') || own(source, 'model_pin') ||
      own(source, 'explicitUserModelPin') || own(source, 'explicit_user_model_pin'),
    explicitEffortPin: own(nested, 'effortPin') || own(nested, 'effort_pin') ||
      own(nested, 'explicitUserEffortPin') || own(nested, 'explicit_user_effort_pin') ||
      own(source, 'effortPin') || own(source, 'effort_pin') ||
      own(source, 'explicitUserEffortPin') || own(source, 'explicit_user_effort_pin'),
  }
}

function pickModelField(options, field) {
  for (const name of SETTINGS_PRECEDENCE) {
    const fields = modelFields(options[name])
    const value = fields[field]
    if (value !== undefined && value !== null && value !== '') {
      return {
        value,
        source: name,
        pin: field === 'model'
          ? fields.explicitModelPin || name === 'explicit'
          : field === 'effort'
            ? fields.explicitEffortPin || name === 'explicit'
            : false,
      }
    }
  }
  return null
}

function supportsModelRouting(options) {
  const capabilities = isObject(options.capabilities) ? options.capabilities : {}
  const provider = isObject(options.provider) ? options.provider : {}
  return firstOwn(capabilities, ['modelRouting', 'model_routing', 'supportsModelRouting']) === true ||
    firstOwn(provider, ['modelRouting', 'model_routing', 'supportsModelRouting']) === true
}

function normalizeNonEmptyString(selected, field, issues) {
  if (!selected) return null
  if (typeof selected.value !== 'string' || selected.value.trim() === '') {
    issues.push({ field, code: 'INVALID', source: selected.source })
    return null
  }
  return selected.value.trim()
}

function normalizeModelRouting(options, issues) {
  const selected = {
    selector: pickModelField(options, 'selector'),
    model: pickModelField(options, 'model'),
    effort: pickModelField(options, 'effort'),
  }
  if (!supportsModelRouting(options)) {
    for (const field of ['model', 'effort']) {
      if (selected[field] && selected[field].pin) {
        issues.push({
          field: `modelRouting.${field}`,
          code: 'UNSUPPORTED_EXPLICIT_PIN',
          source: selected[field].source,
          requested_value: selected[field].value,
        })
      }
    }
    return {
      supported: false,
      selectedBy: 'provider-unsupported',
    }
  }

  const selector = normalizeNonEmptyString(selected.selector, 'modelRouting.selector', issues)
  const model = normalizeNonEmptyString(selected.model, 'modelRouting.model', issues)
  const effort = normalizeNonEmptyString(selected.effort, 'modelRouting.effort', issues)

  if (!selector && !model && !effort) {
    issues.push({ field: 'modelRouting.selector', code: 'MISSING', source: null })
    return null
  }
  const modelPinned = Boolean(selected.model && selected.model.pin)
  const effortPinned = Boolean(selected.effort && selected.effort.pin)
  const firstSource = selected.model?.source ?? selected.effort?.source ?? selected.selector?.source
  return {
    supported: true,
    ...(model ? { model } : {}),
    ...(effort ? { effort } : {}),
    ...(modelPinned ? { explicitUserModelPin: model } : {}),
    ...(effortPinned ? { explicitUserEffortPin: effort } : {}),
    selectedBy: modelPinned || effortPinned
      ? 'user-pin'
      : (CANONICAL_SOURCES[firstSource] ?? 'automatic'),
  }
}

function configRequired(options, issues) {
  const interactive = options.interactive === true
  const userIssues = issues.filter(issue => issue.source !== 'provider')
  return {
    schemaVersion: SETTINGS_SCHEMA_VERSION,
    status: 'CONFIG_REQUIRED',
    ready: false,
    inspectionAllowed: false,
    interactionMode: interactive ? 'interactive' : 'headless',
    nextAction: interactive && userIssues.length > 0 ? 'ASK_USER' : 'STOP',
    missing: issues.filter(issue => issue.code === 'MISSING').map(issue => issue.field),
    issues,
  }
}

function providerUnsupported(options, issues) {
  return {
    schemaVersion: SETTINGS_SCHEMA_VERSION,
    status: 'PROVIDER_UNSUPPORTED',
    ready: false,
    inspectionAllowed: false,
    interactionMode: options.interactive === true ? 'interactive' : 'headless',
    nextAction: 'STOP',
    unsupported: issues.map(issue => ({
      field: issue.field,
      code: issue.code,
      requestedValue: issue.requested_value,
      source: issue.source,
    })),
    issues,
  }
}

/**
 * Resolve supported admission controls without reading the project.
 *
 * Values are selected independently in the fixed order explicit > run > saved.
 * Once a source mentions concurrency, an invalid value at that source is reported;
 * it never silently falls through to a lower-precedence preference.
 */
function resolveSettings(options = {}) {
  const issues = []
  const concurrency = normalizeConcurrency(selectConcurrency(options), options, issues)
  const path = normalizePath(selectPath(options), issues)
  const modelRouting = normalizeModelRouting(options, issues)
  const provider = isObject(options.provider) ? options.provider : {}
  const providerId = firstOwn(options, ['providerId']) ?? firstOwn(provider, ['id', 'providerId']) ?? 'codex'
  if (issues.some(issue => ['UNSUPPORTED_EXPLICIT_PIN', 'PROVIDER_CAP_REQUIRED'].includes(issue.code))) {
    return providerUnsupported(options, issues.filter(
      issue => ['UNSUPPORTED_EXPLICIT_PIN', 'PROVIDER_CAP_REQUIRED'].includes(issue.code),
    ))
  }
  if (issues.length > 0) return configRequired(options, issues)

  return {
    schemaVersion: SETTINGS_SCHEMA_VERSION,
    status: 'READY',
    ready: true,
    inspectionAllowed: true,
    providerId: providerId.trim(),
    interactionMode: options.interactive === true ? 'interactive' : 'headless',
    concurrency,
    path,
    modelRouting,
    ...(isObject(options.deadline) ? { deadline: { ...options.deadline } } : {}),
    resolvedAt: options.resolvedAt ?? new Date(options.nowMs ?? Date.now()).toISOString(),
  }
}

function validateResolvedSettings(settings) {
  const errors = validateJsonSchema(SETTINGS_SCHEMA, settings).errors.map(
    error => `${error.path}: ${error.message}`,
  )
  if (errors.length > 0) return { valid: false, errors }

  // JSON Schema covers the shape and fixed limits; pins additionally bind two
  // runtime values, which the bundled schema cannot compare to one another.
  const routing = settings.modelRouting
  if (routing.explicitUserModelPin !== undefined && routing.model !== routing.explicitUserModelPin) {
    errors.push('resolved model must equal explicitUserModelPin')
  }
  if (routing.explicitUserEffortPin !== undefined && routing.effort !== routing.explicitUserEffortPin) {
    errors.push('resolved effort must equal explicitUserEffortPin')
  }
  return { valid: errors.length === 0, errors }
}

module.exports = {
  CONCURRENCY_MODES,
  PATH_VALUES,
  SETTINGS_PRECEDENCE,
  SETTINGS_SCHEMA,
  SETTINGS_SCHEMA_ID,
  SETTINGS_SCHEMA_VERSION,
  TOKENSAVER_MAX_SUBS,
  positiveInteger,
  resolveSettings,
  resolveRunSettings: resolveSettings,
  validateResolvedSettings,
}
