#!/usr/bin/env node
'use strict'

// Shared Bash discovery for tests that shell out to Git for Windows.
//
// The default install location is `C:\Program Files\Git\bin\bash.exe`, but
// contributors may install Git to another drive (e.g. `D:\Program Files\Git`).
// Hardcoding the C:\ path fails the entire test suite on those machines.
// This helper probes the standard Program Files locations plus D: so the
// test suite passes regardless of where Git was installed.

const childProcess = require('node:child_process')

const BASH_CANDIDATES = [
  () => process.env.ProgramFiles && `${process.env.ProgramFiles}\\Git\\bin\\bash.exe`,
  () => process.env.ProgramFiles && `${process.env.ProgramFiles}\\Git\\usr\\bin\\bash.exe`,
  () => process.env['ProgramFiles(x86)'] && `${process.env['ProgramFiles(x86)']}\\Git\\bin\\bash.exe`,
  () => process.env['ProgramFiles(x86)'] && `${process.env['ProgramFiles(x86)']}\\Git\\usr\\bin\\bash.exe`,
  () => process.env.ProgramW6432 && `${process.env.ProgramW6432}\\Git\\bin\\bash.exe`,
  () => process.env.ProgramW6432 && `${process.env.ProgramW6432}\\Git\\usr\\bin\\bash.exe`,
  () => 'C:\\Program Files\\Git\\bin\\bash.exe',
  () => 'C:\\Program Files\\Git\\usr\\bin\\bash.exe',
  () => 'D:\\Program Files\\Git\\bin\\bash.exe',
  () => 'D:\\Program Files\\Git\\usr\\bin\\bash.exe',
]

function resolveBash() {
  if (process.platform !== 'win32') return 'bash'
  for (const candidate of BASH_CANDIDATES) {
    const path = candidate()
    if (!path) continue
    try {
      if (childProcess.spawnSync(path, ['--version'], { timeout: 2000 }).status === 0) {
        return path
      }
    } catch {
      // Candidate not present or not executable - try next
    }
  }
  return 'bash'
}

module.exports = { resolveBash }
