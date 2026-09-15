'use strict'

// Preserve installer tools while keeping ambient native Codex packages out of
// version-only fixtures. Forward to the original paths: copying Python or pwsh
// alone loses their adjacent runtime resources and Python virtualenv identity.
const assert = require('node:assert/strict')
const cp = require('node:child_process')
const fs = require('node:fs')
const path = require('node:path')

const CODEX_COMMAND = /^codex(?:\.(?:exe|com|cmd|bat|ps1))?$/i
const shellLiteral = value => `'${value.replaceAll("'", `'"'"'`)}'`

function windowsForwarder(root, environment) {
  const executable = path.join(root, 'forward.exe')
  if (fs.existsSync(executable)) return executable
  const source = path.join(root, 'forward.cs')
  fs.writeFileSync(source, `using System;
using System.Diagnostics;
using System.IO;
using System.Reflection;
using System.Text;
public static class Forward {
  static string Quote(string value) {
    var result = new StringBuilder("\\\""); int slashes = 0;
    foreach (char item in value) {
      if (item == '\\\\') { slashes++; continue; }
      if (item == '\\"') { result.Append('\\\\', slashes * 2 + 1); result.Append(item); }
      else { result.Append('\\\\', slashes); result.Append(item); }
      slashes = 0;
    }
    result.Append('\\\\', slashes * 2); result.Append('\\"'); return result.ToString();
  }
  public static int Main(string[] args) {
    try {
      string target = File.ReadAllText(Assembly.GetExecutingAssembly().Location + ".target", Encoding.UTF8);
      var command = new StringBuilder();
      foreach (string arg in args) { if (command.Length != 0) command.Append(' '); command.Append(Quote(arg)); }
      var start = new ProcessStartInfo(target, command.ToString());
      start.UseShellExecute = false; start.WorkingDirectory = Environment.CurrentDirectory;
      using (var child = Process.Start(start)) { child.WaitForExit(); return child.ExitCode; }
    } catch (Exception error) { Console.Error.WriteLine(error.Message); return 125; }
  }
}
`)
  const systemRoot = environment.SystemRoot || environment.SYSTEMROOT || process.env.SystemRoot
  assert.ok(systemRoot, 'Windows tool forwarding requires the system PowerShell compiler')
  const powershell = path.join(systemRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe')
  const result = cp.spawnSync(powershell, ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command',
    '$ErrorActionPreference="Stop"; Add-Type -Path $env:PACKED_TOOL_PROXY_SOURCE -OutputAssembly $env:PACKED_TOOL_PROXY_OUTPUT -OutputType ConsoleApplication'], {
    env: { ...environment, PACKED_TOOL_PROXY_SOURCE: source, PACKED_TOOL_PROXY_OUTPUT: executable },
    encoding: 'utf8', timeout: 60000,
  })
  assert.ifError(result.error)
  assert.equal(result.status, 0, `Compile the isolated Windows tool forwarder: ${result.stdout}\n${result.stderr}`)
  return executable
}

function packedToolPath(root, environment = process.env, options = {}) {
  const nodePath = options.nodePath || process.execPath
  const inherited = environment.PATH || environment.Path || ''
  const directories = [path.dirname(nodePath), ...inherited.split(path.delimiter)]
    .map(value => value.trim().replace(/^"|"$/g, ''))
    .filter(value => value && path.isAbsolute(value))
  fs.mkdirSync(root, { recursive: true })
  const result = [], seen = new Set()
  for (const directory of directories) {
    let actual, entries
    try { actual = fs.realpathSync.native(directory); entries = fs.readdirSync(actual) }
    catch { continue }
    const key = process.platform === 'win32' ? actual.toLowerCase() : actual
    if (seen.has(key)) continue
    seen.add(key)
    if (!entries.some(name => CODEX_COMMAND.test(name))) { result.push(actual); continue }
    const mirror = path.join(root, `tools-${result.length}`)
    fs.mkdirSync(mirror)
    for (const name of entries) {
      if (CODEX_COMMAND.test(name)) continue
      const original = path.join(actual, name), target = path.join(mirror, name)
      try { if (!fs.statSync(original).isFile()) continue } catch { continue }
      if (process.platform === 'win32' && /\.(?:exe|com)$/i.test(name)) {
        fs.copyFileSync(windowsForwarder(root, environment), target)
        fs.writeFileSync(target + '.target', original)
      } else if (process.platform === 'win32' && /\.(?:cmd|bat)$/i.test(name)) {
        fs.writeFileSync(target, `@echo off\r\n@setlocal DisableDelayedExpansion\r\n@"${original.replaceAll('%', '%%')}" %*\r\n`)
      } else if (process.platform === 'win32' && /\.ps1$/i.test(name)) {
        fs.writeFileSync(target, `& '${original.replaceAll("'", "''")}' @args\r\nif (-not $?) { exit 1 }\r\nexit $LASTEXITCODE\r\n`)
      } else {
        try { fs.accessSync(original, fs.constants.X_OK) } catch { continue }
        fs.writeFileSync(target, `#!/bin/sh\nexec ${shellLiteral(original)} "$@"\n`, { mode: 0o700 })
      }
    }
    result.push(mirror)
  }
  return result
}

module.exports = { packedToolPath }
