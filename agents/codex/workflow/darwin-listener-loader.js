'use strict'

// Packaged-only loader for the Darwin launchd listener supervisor. It reuses
// the coalition loader's physical-file, manifest, provenance, and Mach-O
// checks with a distinct fixed runtime descriptor.
const path = require('node:path')
const coalition = require('./darwin-coalition-loader.js')

const RUNTIME_ROOT = path.join(__dirname, 'darwin-listener-runtime')
const SOURCE_PATH = path.join(__dirname, 'darwin-launchd-listener-supervisor.c')
const ARCHITECTURES = Object.freeze({
  x64: Object.freeze({ file: 'listener-supervisor-x64', cpuType: coalition.ARCHITECTURES.x64.cpuType }),
  arm64: Object.freeze({ file: 'listener-supervisor-arm64', cpuType: coalition.ARCHITECTURES.arm64.cpuType }),
})
const DESCRIPTOR = Object.freeze({ kind: 'autoprompt-darwin-listener-runtime', label: 'Darwin listener', architectures: ARCHITECTURES })

function loadDarwinListenerSupervisor() {
  if (process.platform !== 'darwin') {
    const error = new Error('Darwin listener supervisor requires native macOS')
    error.code = 'DARWIN_LISTENER_UNAVAILABLE'
    throw error
  }
  return coalition.validateDarwinRuntimeDescriptor(RUNTIME_ROOT, process.arch, SOURCE_PATH, DESCRIPTOR)
}

function validateDarwinListenerRuntime(runtimeRoot, architecture, sourcePath = SOURCE_PATH) {
  return coalition.validateDarwinRuntimeDescriptor(runtimeRoot, architecture, sourcePath, DESCRIPTOR)
}

function staticAvailability() {
  try {
    if (process.platform !== 'darwin') return Object.freeze({ available: false, code: 'DARWIN_LISTENER_UNAVAILABLE', reason: 'native macOS is required' })
    return Object.freeze({ available: true, supervisor: loadDarwinListenerSupervisor() })
  } catch (error) {
    return Object.freeze({ available: false, code: error.code || 'DARWIN_LISTENER_UNAVAILABLE', reason: error.message })
  }
}

module.exports = { RUNTIME_ROOT, SOURCE_PATH, ARCHITECTURES, validateDarwinListenerRuntime, loadDarwinListenerSupervisor, staticAvailability }
