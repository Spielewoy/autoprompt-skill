'use strict'
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),os=require('node:os'),cp=require('node:child_process'),crypto=require('node:crypto')
const workflow=fs.readFileSync(path.resolve(__dirname,'../../../.github/workflows/native-platform.yml'),'utf8')
const start='          # BEGIN exact running Node identity\n',end='          # END exact running Node identity'
function extract(text){
 text=text.replace(/\r\n/g,'\n')
 assert.equal(text.split(start).length,2);assert.equal(text.split(end).length,2)
 return text.slice(text.indexOf(start)+start.length,text.indexOf(end)).split('\n').map(line=>line.replace(/^          /,'')).join('\n')
}
const selection=extract(workflow)
const quote=s=>"'"+s.replaceAll("'","''")+"'"
test('workflow has no multi-result Get-Command Node identity selector',()=>{assert.ok(!/Get-Command\s+node\b/.test(workflow));assert.match(selection,/node -p 'process\.execPath'/)})
test('workflow selector extraction preserves its source across LF and Windows CRLF checkout',()=>{const lf=workflow.replace(/\r\n/g,'\n');assert.equal(extract(lf),selection);assert.equal(extract(lf.replace(/\n/g,'\r\n')),selection)})
test('actual PowerShell selects one running Node among multiple PATH candidates and refuses invalid identity output',{skip:process.platform!=='win32'&&!process.env.AUTOPROMPT_TEST_PWSH,timeout:60000},t=>{
 const root=fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(),'node identity with spaces ')));t.after(()=>fs.rmSync(root,{recursive:true,force:true}))
 const dirs=['first','second'].map(name=>{const dir=path.join(root,name);fs.mkdirSync(dir);const target=path.join(dir,process.platform==='win32'?'node.exe':'node');if(process.platform==='win32')fs.copyFileSync(process.execPath,target);else fs.symlinkSync(process.execPath,target);return dir})
 const script=path.join(root,'proof.ps1'),environment={...process.env}
 const pathKey=Object.keys(environment).find(k=>k.toUpperCase()==='PATH')||'PATH';environment[pathKey]=dirs.join(path.delimiter)+path.delimiter+(environment[pathKey]||'')
 const childSource="process.stdout.write(JSON.stringify(process.argv.slice(1)))"
 fs.writeFileSync(script,`$ErrorActionPreference='Stop'
$candidates=@(Get-Command node -CommandType Application)
if ($candidates.Count -lt 2) { throw 'The fixture did not expose multiple Node applications' }
${selection}
if ($controller -isnot [string] -or $digest -isnot [string]) { throw 'Controller identity must be scalar' }
$actual=@(& $controller -e ${quote(childSource)} -- $controller $digest)
if ($LASTEXITCODE -ne 0 -or $actual.Count -ne 1) { throw 'Identity argv proof failed' }
[Console]::Out.WriteLine($actual[0])
$cases=@(
 @{ output=@($controller,$controller); status=0 },
 @{ output=@(); status=0 },
 @{ output=@('relative'); status=0 },
 @{ output=@($controller); status=7 },
 @{ output=@($controller+[char]10+'extra'); status=0 },
 @{ output=@($controller+[char]0); status=0 },
 @{ output=@(${quote(root)}); status=0 },
 @{ output=@(${quote(path.join(root,'missing-node.exe'))}); status=0 },
 @{ output=@(42); status=0 }
)
foreach ($case in $cases) {
 function node { $global:LASTEXITCODE=$case.status; foreach ($item in $case.output) { Write-Output $item } }
 $refused=$false
 try { & { ${selection} } } catch { $refused=$true }
 if (-not $refused) { throw 'Invalid controller identity was accepted' }
 Remove-Item Function:node
}
[Console]::Out.WriteLine('INVALID_CASES_REFUSED:9')
`)
 const result=cp.spawnSync(process.env.AUTOPROMPT_TEST_PWSH||'pwsh',['-NoLogo','-NoProfile','-NonInteractive','-File',script],{encoding:'utf8',env:environment,timeout:55000,maxBuffer:65536,windowsHide:true})
 assert.ifError(result.error);assert.equal(result.status,0,result.stderr);assert.equal(result.stderr,'')
 const lines=result.stdout.trim().split(/\r?\n/);assert.equal(lines.length,2);assert.equal(lines[1],'INVALID_CASES_REFUSED:9')
 const argv=JSON.parse(lines[0]);assert.equal(argv.length,2)
 const expected=process.platform==='win32'?path.join(dirs[0],'node.exe'):fs.realpathSync.native(process.execPath)
 assert.equal(argv[0],expected);assert.equal(argv[1],crypto.createHash('sha256').update(fs.readFileSync(expected)).digest('hex'))
})
