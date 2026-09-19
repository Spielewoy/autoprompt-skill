'use strict'
const test = require('node:test'), assert = require('node:assert/strict')
const cp = require('node:child_process'), path = require('node:path')

test('actual discovery planner requires native architecture and selects matching compiler tools', t => {
  const pwsh = process.env.PWSH || (process.platform === 'win32' ? 'pwsh.exe' : 'pwsh')
  const script = String.raw`
$ErrorActionPreference='Stop'
$tokens=$null;$errors=$null
$ast=[Management.Automation.Language.Parser]::ParseFile($env:DISCOVERY_SOURCE,[ref]$tokens,[ref]$errors)
if($errors.Count){throw 'Discovery script syntax errors'}
foreach($name in @('SelectDiscoveryPlan','AssertDiscoveryEnvironment')) {
  $functions=@($ast.FindAll({param($node) $node -is [Management.Automation.Language.FunctionDefinitionAst] -and $node.Name -eq $name},$true))
  if($functions.Count -ne 1){throw 'Expected one actual function'}
  . ([ScriptBlock]::Create($functions[0].Extent.Text))
}
$plans=@((SelectDiscoveryPlan 'X64' 'X64'),(SelectDiscoveryPlan 'Arm64' 'Arm64'))
$refusals=0
foreach($pair in @(@('X64','Arm64'),@('Arm64','X64'),@('X86','X64'),@('X86','X86'),@('ARM','ARM'),@('arm64&exit','Arm64'),@('','X64'))) {
  $refused=$false
  try {SelectDiscoveryPlan $pair[0] $pair[1] | Out-Null}catch{$refused=$true}
  if(-not $refused){throw 'Non-native or unknown architecture admitted'}
  $refusals++
}
$environmentRefusals=0
foreach($plan in $plans) {
  $values=@{VSCMD_ARG_HOST_ARCH=$plan.arch;VSCMD_ARG_TGT_ARCH=$plan.arch}
  AssertDiscoveryEnvironment $values $plan
  foreach($key in @('VSCMD_ARG_HOST_ARCH','VSCMD_ARG_TGT_ARCH')) {
    foreach($replacement in @('x86','wrong','')) {
      $values[$key]=$replacement;$refused=$false
      try{AssertDiscoveryEnvironment $values $plan}catch{$refused=$true}
      if(-not $refused){throw 'Wrong compiler environment accepted'}
      $environmentRefusals++
    }
    $values.Remove($key);$refused=$false
    try{AssertDiscoveryEnvironment $values $plan}catch{$refused=$true}
    if(-not $refused){throw 'Missing compiler environment accepted'}
    $environmentRefusals++;$values[$key]=$plan.arch
  }
}
@{plans=$plans;refusals=$refusals;environmentRefusals=$environmentRefusals} | ConvertTo-Json -Depth 4 -Compress
`
  const result = cp.spawnSync(pwsh, ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', script], {
    encoding: 'utf8', timeout: 15000, env: { ...process.env, DISCOVERY_SOURCE: path.join(__dirname, 'discover-toolchain.ps1') },
  })
  if (result.error?.code === 'ENOENT' && process.platform !== 'win32') { t.skip('PowerShell unavailable; no native discovery claim'); return }
  assert.ifError(result.error); assert.equal(result.status, 0, result.stderr); assert.equal(result.stderr, '')
  assert.deepEqual(JSON.parse(result.stdout), { refusals: 7, environmentRefusals: 16, plans: [
    { arch: 'x64', processor: 'AMD64', vcvars: 'amd64', tools: 'bin\\Hostx64\\x64', component: 'Microsoft.VisualStudio.Component.VC.Tools.x86.x64' },
    { arch: 'arm64', processor: 'ARM64', vcvars: 'arm64', tools: 'bin\\HostARM64\\arm64', component: 'Microsoft.VisualStudio.Component.VC.Tools.ARM64' },
  ] })
})
