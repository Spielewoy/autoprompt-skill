'use strict'
const test = require('node:test'), assert = require('node:assert/strict'), fs = require('node:fs'), path = require('node:path'), os = require('node:os'), cp = require('node:child_process')
const { parseProof, parseDiagnostic, ENVIRONMENT } = require('./parse.cjs')
const { pe } = require('./build.cjs')
const packageSid = 'S-1-15-2-1-2-3-4-5-6-7'
function proof() {
  return {
    schemaVersion: 1,
    identity: { primary: { error: 0, appContainer: true, userSid: 'S-1-5-21-1-2-3-1001', packageSid, integrityRid: 4096 }, threadTokenPresent: false, threadTokenError: 1008, thread: null },
    architecture: { error: 0, pointerBits: 64, processMachine: 0, nativeMachine: 0x8664 },
    libraries: { bcrypt: { loadError: 0, path: 'C:\\Windows\\System32\\bcrypt.dll', pathError: 0, symbolError: 0 }, advapi: { loadError: 0, path: 'C:\\Windows\\System32\\advapi32.dll', pathError: 0, symbolError: 0 } },
    rng: { systemStatus: '00000000', openStatus: '00000000', providerStatus: '00000000', closeStatus: '00000000', rtlSuccess: true, rtlError: 0 },
    environment: Object.fromEntries(ENVIRONMENT.map(name => [name, { present: false, error: 203, value: null }])),
    legacyRng: { acquireSuccess: true, acquireError: 0, generateSuccess: true, generateError: 0, releaseSuccess: true, releaseError: 0 },
    selfAccess: Object.fromEntries([['process', [0x1000, 0x400, 0x410]], ['thread', [0x800, 0x40]]].map(([kind, masks]) => [kind, masks.map(access => ({ access, success: true, error: 0 }))])),
    security: { process: { error: 0, sddl: 'D:(A;;GA;;;SY)' }, thread: { error: 0, sddl: 'D:(A;;GA;;;SY)' } },
  }
}
const encode = p => JSON.stringify(p).replace(/[\u007f-\uffff]/g, c => '\\u' + c.charCodeAt(0).toString(16).padStart(4, '0'))
test('entropy parser binds actual primary token and preserves distinct API failures', () => {
  const p = proof(); p.rng.systemStatus = 'c0000022'; p.rng.providerStatus = 'c0000001'; p.rng.rtlSuccess = false; p.rng.rtlError = 5
  p.legacyRng = { acquireSuccess: false, acquireError: 0x80090016, generateSuccess: null, generateError: null, releaseSuccess: null, releaseError: null }
  p.selfAccess.process[2] = { access: 0x410, success: false, error: 5 }; p.security.thread = { error: 5, sddl: null }
  p.environment.PATH = { present: true, error: 0, value: 'C:\\unicode-\u03a9;quote"\\line\n' }
  assert.deepEqual(parseProof(encode(p), packageSid), p)
})
test('host and impersonating observations remain distinct from expected AppContainer proof', () => {
  const p = proof(); p.identity.primary.appContainer = false; p.identity.primary.packageSid = ''; assert.deepEqual(parseProof(encode(p), null), p)
  assert.throws(() => parseProof(encode(p), packageSid))
  p.identity.threadTokenPresent = true; p.identity.threadTokenError = 0; p.identity.thread = proof().identity.primary
  assert.deepEqual(parseProof(encode(p)), p); assert.throws(() => parseProof(encode(p), null))
})
test('loader and token API failures remain recorded without invented success', () => {
  const p = proof(); p.identity.primary = { error: 5, appContainer: null, userSid: null, packageSid: null, integrityRid: null }
  p.libraries.bcrypt = { loadError: 126, path: null, pathError: 0, symbolError: 0 }
  for (const k of ['systemStatus', 'openStatus', 'providerStatus', 'closeStatus']) p.rng[k] = null
  p.libraries.advapi = { loadError: 5, path: null, pathError: 0, symbolError: 0 }; p.rng.rtlSuccess = p.rng.rtlError = null
  p.architecture = { error: 127, pointerBits: 64, processMachine: null, nativeMachine: null }
  assert.deepEqual(parseProof(encode(p)), p); assert.throws(() => parseProof(encode(p), packageSid))
})
for (const [name, change] of [
  ['extra root field', p => { p.secret = 'not allowed' }], ['missing environment', p => { delete p.environment.TEMP }],
  ['extra environment', p => { p.environment.SECRET = { present: true, error: 0, value: 'x' } }],
  ['wrong package', p => { p.identity.primary.packageSid += '-8' }], ['wrong user SID', p => { p.identity.primary.userSid = 'user' }],
  ['token error with data', p => { p.identity.primary.error = 5 }], ['absent thread with success', p => { p.identity.threadTokenError = 0 }],
  ['oversize string', p => { p.environment.PATH = { present: true, error: 0, value: 'x'.repeat(2049) } }],
  ['embedded NUL', p => { p.environment.PATH = { present: true, error: 0, value: 'a\0b' } }],
  ['absent value with success', p => { p.environment.TEMP.error = 0 }], ['truncated value retaining content', p => { p.environment.TEMP = { present: true, error: 234, value: 'x' } }],
  ['status number', p => { p.rng.systemStatus = -1073741790 }], ['uppercase NTSTATUS', p => { p.rng.systemStatus = 'C0000022' }],
  ['provider not released', p => { p.rng.closeStatus = null }], ['generation after open failure', p => { p.rng.openStatus = 'c0000022' }],
  ['RTL false success error', p => { p.rng.rtlError = 5 }], ['legacy successful error', p => { p.legacyRng.acquireError = 5 }],
  ['legacy acquire failed yet generated', p => { p.legacyRng.acquireSuccess = false; p.legacyRng.acquireError = 5 }],
  ['missing process rights cell', p => { p.selfAccess.process.pop() }], ['wrong rights order', p => { p.selfAccess.process.reverse() }],
  ['denied self access success error', p => { p.selfAccess.thread[0].success = false }], ['descriptor error with data', p => { p.security.thread.error = 5 }],
  ['relative loaded module', p => { p.libraries.bcrypt.path = 'bcrypt.dll' }], ['wrong module', p => { p.libraries.bcrypt.path = 'C:\\Windows\\System32\\evil.dll' }],
  ['load failed yet API results', p => { p.libraries.bcrypt = { loadError: 126, path: null, pathError: 0, symbolError: 0 } }],
  ['architecture overflow', p => { p.architecture.nativeMachine = 65536 }],
]) test('entropy protocol refuses ' + name, () => { const p = proof(); change(p); assert.throws(() => parseProof(encode(p), packageSid)) })
test('entropy protocol refuses non-ASCII transport, oversize output and multiple records', () => {
  for (const input of ['é', ' '.repeat(131073), encode(proof()) + encode(proof()), '', '\0' + encode(proof())]) assert.throws(() => parseProof(input))
})
test('PE binding refuses wrong architecture, DLL, malformed headers and non-executables', () => {
  const bytes = Buffer.alloc(256); bytes.writeUInt16LE(0x5a4d, 0); bytes.writeUInt32LE(64, 60); bytes.writeUInt32LE(0x4550, 64); bytes.writeUInt16LE(0x8664, 68); bytes.writeUInt16LE(112, 84); bytes.writeUInt16LE(2, 86); bytes.writeUInt16LE(0x20b, 88)
  pe(bytes, 'x64'); assert.throws(() => pe(bytes, 'arm64'))
  for (const change of [b => b.writeUInt32LE(255, 60), b => b.writeUInt16LE(0x2002, 86), b => b.writeUInt16LE(0, 86), b => b.writeUInt16LE(0x10b, 88), b => b.writeUInt16LE(255, 84)]) { const b = Buffer.from(bytes); change(b); assert.throws(() => pe(b, 'x64')) }
})
// Compile the actual serializer and legacy CryptoAPI control flow with explicit API
// substitutes; this verifies formatting/cleanup, not native RNG or Windows headers.
test('actual C++ serializer and legacy RNG branches preserve failures and erase output bytes', { skip: process.platform === 'win32' ? 'Native MSVC build executes whole diagnostic separately' : false }, t => {
  const source = fs.readFileSync(path.join(__dirname, 'entropy-proof.cc'), 'utf8')
  const helpers = source.slice(source.indexOf('constexpr DWORD text_limit'), source.indexOf('struct Handle'))
  const legacy = source.slice(source.indexOf('std::string legacy_rng()'), source.indexOf('\n}\nint wmain'))
  const prefix = `#include <cstdint>\n#include <cstdio>\n#include <cstring>\n#include <string>\n#include <stdexcept>\n#include <iostream>\ntypedef unsigned char boolean;using DWORD=uint32_t;using LONG=int32_t;using BYTE=unsigned char;using HCRYPTPROV=uintptr_t;using BOOL=int;constexpr int FALSE=0;constexpr DWORD PROV_RSA_FULL=1,CRYPT_VERIFYCONTEXT=0xf0000000,CRYPT_SILENT=64;int mode=0,calls=0,clears=0;DWORD last=0;template<size_t N,class...A>int sprintf_s(char(&b)[N],const char*f,A...a){return snprintf(b,N,f,a...);}\nDWORD GetLastError(){return last;}BOOL CryptAcquireContextW(HCRYPTPROV*p,void*a,void*b,DWORD type,DWORD flags){if(a||b||type!=1||flags!=0xf0000040)throw std::runtime_error("args");calls++;if(mode==1){last=5;return 0;}*p=42;return 1;}BOOL CryptGenRandom(HCRYPTPROV p,DWORD n,BYTE*b){if(p!=42||n!=32)throw std::runtime_error("gen-args");calls++;memset(b,0x5a,n);if(mode==2){last=9;return 0;}return 1;}BOOL CryptReleaseContext(HCRYPTPROV p,DWORD flags){if(p!=42||flags)throw std::runtime_error("release-args");calls++;if(mode==3){last=10;return 0;}return 1;}void SecureZeroMemory(void*p,size_t n){if(n!=32)throw std::runtime_error("erase-bound");memset(p,0,n);clears++;}\n`
  const suffix = `\nint main(){std::cout<<quoted(L"quote\\\"\\n\\u03a9")<<"\\n"<<status(static_cast<LONG>(0xc0000022))<<"\\n";try{quoted(std::wstring(2049,L'x'));return 2;}catch(const std::runtime_error&){}for(mode=0;mode<4;mode++){calls=clears=0;std::cout<<legacy_rng()<<"\\n";if(calls!=(mode==1?1:3)||clears!=(mode==1?0:1))return 3;}return 0;}\n`
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'entropy-source-contract-')); t.after(() => fs.rmSync(dir, { recursive: true, force: true }))
  fs.writeFileSync(path.join(dir, 'contract.cc'), prefix + helpers + legacy + suffix)
  const compile = cp.spawnSync('g++', ['-std=c++17', '-Wall', '-Wextra', '-Werror', path.join(dir, 'contract.cc'), '-o', path.join(dir, 'contract')], { encoding: 'utf8', timeout: 30000 })
  assert.ifError(compile.error); assert.equal(compile.status, 0, compile.stderr)
  const run = cp.spawnSync(path.join(dir, 'contract'), [], { encoding: 'utf8', timeout: 5000 }); assert.ifError(run.error); assert.equal(run.status, 0, run.stderr)
  const lines = run.stdout.trim().split('\n'); assert.equal(lines.length, 6); assert.equal(JSON.parse(lines[0]), 'quote"\nΩ'); assert.equal(JSON.parse(lines[1]), 'c0000022')
  for (let i = 0; i < 4; i++) { const p = proof(); p.legacyRng = JSON.parse(lines[2 + i]); parseProof(encode(p), packageSid); assert.equal(p.legacyRng.acquireSuccess, i !== 1); assert.equal(p.legacyRng.generateSuccess, i === 1 ? null : i !== 2); assert.equal(p.legacyRng.releaseSuccess, i === 1 ? null : i !== 3) }
})

test('diagnostic preserves denied token inspection without claiming a matching identity', () => {
  const p = proof()
  p.identity.primary = { error: 5, appContainer: null, userSid: null, packageSid: null, integrityRid: null }
  assert.deepEqual(parseDiagnostic(encode(p), packageSid), p)
  assert.throws(() => parseProof(encode(p), packageSid))
  p.identity.primary = proof().identity.primary
  assert.deepEqual(parseDiagnostic(encode(p), packageSid), p)
  assert.throws(() => parseDiagnostic(encode(p), packageSid.replace(/7$/, '8')))
  p.identity.threadTokenPresent = true; p.identity.threadTokenError = 0; p.identity.thread = proof().identity.primary
  assert.throws(() => parseDiagnostic(encode(p), packageSid))
})
