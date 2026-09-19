'use strict'
// Dedicated diagnostic entry. Context authority is passed by the verified parent
// as a path plus exact digest; no production environment override is consulted.
const assert=require('node:assert/strict'),test=require('node:test'),path=require('node:path')
const binding=require('./binding.cjs'),{readBounded,TEST_NAME}=require('../probe-built-runtime.cjs')
assert.equal(process.argv.length,4,'Usage: pinned-node native.cjs CONTEXT SHA256')
assert.equal(process.platform,'win32','Actual Windows diagnostic required')
assert.match(process.argv[3],/^[a-f0-9]{64}$/)
const bytes=readBounded(path.resolve(process.argv[2]),1024*1024);assert.equal(binding.hash(bytes),process.argv[3],'Diagnostic context changed')
const value=JSON.parse(bytes);assert.ok(binding.canonical(value).equals(bytes),'Canonical diagnostic context required')
const executor=binding.createExecutor(value)
test(TEST_NAME,{timeout:600000},async t=>{
 await require('../../../tests/helpers/windows-bash-native-smoke.cjs').runNativeWindowsBashSmoke(t,{probeWindowsAppContainer:executor.probe,executeTool:executor.executeTool})
})
