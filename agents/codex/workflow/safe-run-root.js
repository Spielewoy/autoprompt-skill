'use strict'

const crypto = require('node:crypto')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { spawnSync } = require('node:child_process')

const OWNER_FILE = '.autoprompt-owner.json'
const OWNER_SCHEMA = 'autoprompt.run-root-owner.v2'
const DIRECTORY_MODE = 0o700
const FILE_MODE = 0o600

class RunRecordError extends Error {
  constructor(code, message, details = {}) {
    super(message)
    this.name = 'RunRecordError'
    this.code = code
    this.details = details
  }
}

function sha256(value) {
  return crypto.createHash('sha256').update(value).digest('hex')
}

function normalizeIdentityPath(value) {
  const resolved = path.resolve(value)
  return process.platform === 'win32' ? resolved.toLowerCase() : resolved
}

function pathIsInside(parent, child) {
  const relative = path.relative(path.resolve(parent), path.resolve(child))
  return relative === '' || (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative))
}

function statIdentity(stats) {
  return {
    dev: String(stats.dev),
    ino: String(stats.ino),
    mode: Number(stats.mode),
    nlink: Number(stats.nlink),
  }
}

function sameIdentity(left, right) {
  return Boolean(left && right && String(left.dev) === String(right.dev) && String(left.ino) === String(right.ino))
}

function existingPrefixes(absolutePath) {
  const resolved = path.resolve(absolutePath)
  const root = path.parse(resolved).root
  const rest = resolved.slice(root.length).split(path.sep).filter(Boolean)
  const prefixes = [root]
  let current = root
  for (const part of rest) {
    current = path.join(current, part)
    prefixes.push(current)
  }
  return prefixes
}

// Node exposes symbolic links and Windows junctions through lstat().isSymbolicLink().
// O_NOFOLLOW adds the kernel check where supported. realpath comparison catches other
// name-surrogate/reparse redirects that Node can observe, while device/inode binding
// detects a later replacement. Unknown reparse tags cannot be safely opened by Node,
// so callers fall back to the provider-private root on any ambiguity.
function inspectPathNoFollow(candidate, options = {}) {
  const absolute = path.resolve(candidate)
  const mustBeDirectory = options.mustBeDirectory !== false
  const fileSystem = options.fsImpl || fs
  let last = null
  let targetStats = null

  for (const prefix of existingPrefixes(absolute)) {
    let stats
    try {
      stats = fileSystem.lstatSync(prefix, { bigint: true })
    } catch (error) {
      if (error.code === 'ENOENT') break
      throw new RunRecordError('RUN_RECORD_UNSAFE', `Cannot inspect run-record path without following links: ${prefix}`, { cause: error.code })
    }
    if (stats.isSymbolicLink()) {
      throw new RunRecordError('RUN_RECORD_UNSAFE', `Linked, junction, or name-surrogate path is not allowed: ${prefix}`, { path: prefix })
    }
    if (prefix !== absolute && !stats.isDirectory()) {
      throw new RunRecordError('RUN_RECORD_UNSAFE', `A run-record ancestor is not a directory: ${prefix}`, { path: prefix })
    }
    if (prefix === absolute) targetStats = stats
    else last = { path: prefix, stats }
  }

  const disappeared = () => ({
    exists: false,
    path: absolute,
    nearestExisting: last && last.path,
    nearestIdentity: last && statIdentity(last.stats),
  })

  if (targetStats) {
    if (mustBeDirectory && !targetStats.isDirectory()) {
      throw new RunRecordError('RUN_RECORD_UNSAFE', `Run-record path is not a directory: ${absolute}`, { path: absolute })
    }
    let real
    try {
      real = fileSystem.realpathSync.native(absolute)
    } catch (error) {
      if (error.code === 'ENOENT') return disappeared()
      throw error
    }
    if (normalizeIdentityPath(real) !== normalizeIdentityPath(absolute)) {
      // On Windows a name deleted after lstat can briefly resolve through the
      // NTFS deleted-object namespace. Accept only proven disappearance; a
      // still-present redirect, junction, or replacement remains fail-closed.
      try { fileSystem.lstatSync(absolute) } catch (error) {
        if (error.code === 'ENOENT') return disappeared()
        throw new RunRecordError('RUN_RECORD_UNSAFE', `Cannot recheck redirected run-record path: ${absolute}`, { cause: error.code })
      }
      throw new RunRecordError('RUN_RECORD_UNSAFE', `Run-record path resolves through a redirect: ${absolute}`, { path: absolute, realpath: real })
    }
    return { exists: true, path: absolute, realpath: real, identity: statIdentity(targetStats) }
  }
  return disappeared()
}

function assertDirectoryBinding(binding) {
  if (!binding || !binding.path || !binding.identity) {
    throw new RunRecordError('RUN_RECORD_UNSAFE', 'A directory identity binding is required')
  }
  const inspected = inspectPathNoFollow(binding.path)
  if (!inspected.exists || !sameIdentity(binding.identity, inspected.identity)) {
    throw new RunRecordError('RUN_RECORD_UNSAFE', `Run-record directory was replaced after validation: ${binding.path}`, {
      expected: binding.identity,
      actual: inspected.identity || null,
    })
  }
  return inspected
}

function chmodPrivate(target, mode) {
  ensureWindowsDefaultTokenOwner()
  try {
    fs.chmodSync(target, mode)
  } catch (error) {
    throw new RunRecordError('PRIVACY_UNSUPPORTED', `Cannot apply private permissions to run-record path: ${target}`, { cause: error.code })
  }
}

let windowsDefaultTokenOwnerEstablished = false
let windowsBunKnownFolders
function windowsTokenProfileFolders(systemRoot) {
  if (!process.versions?.bun) {
    let profileHome
    try { profileHome = os.userInfo().homedir } catch (error) { throw new RunRecordError('PRIVACY_UNSUPPORTED', 'The current Windows token profile root could not be resolved', { cause: error && error.code }) }
    if (typeof profileHome !== 'string' || !/^[A-Za-z]:\\/u.test(profileHome)) throw new RunRecordError('PRIVACY_UNSUPPORTED', 'The current Windows token returned no usable profile root')
    return { profileHome, localAppData: path.join(profileHome, 'AppData', 'Local'), roamingAppData: path.join(profileHome, 'AppData', 'Roaming') }
  }
  if (!windowsBunKnownFolders) {
    const powershell = path.win32.join(systemRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe')
    const script = [
      "$ErrorActionPreference='Stop'",
      '[Console]::OutputEncoding=[Text.UTF8Encoding]::new($false)',
      // This query bootstraps the private compiler directory itself. Emit the
      // fixed P/Invoke in memory: Add-Type would need TEMP before we know it.
      "$assembly=[Reflection.Emit.AssemblyBuilder]::DefineDynamicAssembly([Reflection.AssemblyName]::new('AutopromptTokenProfile'),[Reflection.Emit.AssemblyBuilderAccess]::Run)",
      "$module=$assembly.DefineDynamicModule('AutopromptTokenProfile')",
      "$type=$module.DefineType('AutopromptTokenProfile',[Reflection.TypeAttributes]'Public,Sealed,Abstract')",
      "$method=$type.DefinePInvokeMethod('GetUserProfileDirectory','userenv.dll',[Reflection.MethodAttributes]'Public,Static,PinvokeImpl',[Reflection.CallingConventions]::Standard,[bool],[Type[]]@([IntPtr],[Text.StringBuilder],[uint32].MakeByRefType()),[Runtime.InteropServices.CallingConvention]::Winapi,[Runtime.InteropServices.CharSet]::Unicode)",
      '$method.SetImplementationFlags($method.GetMethodImplementationFlags() -bor [Reflection.MethodImplAttributes]::PreserveSig)',
      '$native=$type.CreateType()',
      '$identity=[Security.Principal.WindowsIdentity]::GetCurrent()',
      "try {$parameters=[object[]]@($identity.Token,[Text.StringBuilder]::new(32768),[uint32]32768);$ok=$native.GetMethod('GetUserProfileDirectory').Invoke($null,$parameters);if(-not $ok -or $parameters[2] -eq 0 -or $parameters[2] -ge 32768){throw 'Token profile path unavailable'};$profile=$parameters[1].ToString()}finally{$identity.Dispose()}",
      "$value=[ordered]@{profile=$profile;local=[IO.Path]::Combine($profile,'AppData','Local');roaming=[IO.Path]::Combine($profile,'AppData','Roaming')}",
      '[Console]::Out.Write(($value|ConvertTo-Json -Compress))',
    ].join(';')
    const result = spawnSync(powershell, ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', script], {
      encoding: 'utf8', windowsHide: true, shell: false, timeout: 30000, maxBuffer: 65536,
      stdio: ['ignore', 'pipe', 'pipe'], cwd: path.win32.dirname(powershell),
      // Do not project HOME, USERPROFILE, APPDATA or LOCALAPPDATA. The fixed
      // Read the process token explicitly. Shell known-folder helpers can
      // expand an isolated profile from a bundled runtime's environment.
      env: { SystemRoot: systemRoot, WINDIR: systemRoot, SystemDrive: systemRoot.slice(0, 2), PATH: path.win32.join(systemRoot, 'System32') },
    })
    if (result.error || result.signal || result.status !== 0 || result.stderr) {
      const diagnostic = {
        status: result.status, signal: result.signal, cause: result.error && result.error.code,
        stderr: String(result.stderr || '').replace(/[\r\n]+/g, ' ').slice(0, 1024),
      }
      throw new RunRecordError('PRIVACY_UNSUPPORTED', `The current Windows token known folders could not be resolved (${JSON.stringify(diagnostic)})`, {
        ...diagnostic,
      })
    }
    let parsed
    try { parsed = JSON.parse(result.stdout) } catch { throw new RunRecordError('PRIVACY_UNSUPPORTED', 'The current Windows token known-folder helper returned invalid JSON') }
    if (!parsed || Object.keys(parsed).sort().join(',') !== 'local,profile,roaming' ||
        ![parsed.profile, parsed.local, parsed.roaming].every(value => typeof value === 'string' && /^[A-Za-z]:\\/u.test(value))) {
      throw new RunRecordError('PRIVACY_UNSUPPORTED', 'The current Windows token known-folder helper returned invalid paths')
    }
    windowsBunKnownFolders = Object.freeze({ profileHome: parsed.profile, localAppData: parsed.local, roamingAppData: parsed.roaming })
  }
  return windowsBunKnownFolders
}

function ensureWindowsDefaultTokenOwner() {
  if (process.platform !== 'win32' || windowsDefaultTokenOwnerEstablished) {
    return { supported: true, mechanism: process.platform === 'win32' ? 'windows-token-owner' : 'posix-owner' }
  }
  // Elevated Windows tokens can default newly-created objects to the local
  // Administrators group even though the token user is the interactive user.
  // Adjust this live Node process token once so every later run-record child
  // is born with the owner that the native record authority verifies.
  const source = [
    'using System;',
    'using System.ComponentModel;',
    'using System.IO;',
    'using System.Runtime.InteropServices;',
    'public static class AutopromptDefaultTokenOwner {',
    ' [StructLayout(LayoutKind.Sequential)] struct FILETIME { public uint Low, High; public ulong Value { get { return ((ulong)High << 32) | Low; } } }',
    ' [StructLayout(LayoutKind.Sequential)] struct TOKEN_OWNER { public IntPtr Owner; }',
    ' [DllImport("kernel32.dll",SetLastError=true)] static extern IntPtr OpenProcess(uint access,bool inherit,int pid);',
    ' [DllImport("kernel32.dll",SetLastError=true)] static extern uint GetProcessId(IntPtr process);',
    ' [DllImport("kernel32.dll",SetLastError=true,CharSet=CharSet.Unicode)] static extern bool QueryFullProcessImageName(IntPtr process,uint flags,System.Text.StringBuilder image,ref uint size);',
    ' [DllImport("kernel32.dll",SetLastError=true)] static extern bool GetProcessTimes(IntPtr process,out FILETIME creation,out FILETIME exit,out FILETIME kernel,out FILETIME user);',
    ' [DllImport("kernel32.dll",SetLastError=true)] static extern bool CloseHandle(IntPtr handle);',
    ' [DllImport("advapi32.dll",SetLastError=true)] static extern bool OpenProcessToken(IntPtr process,uint access,out IntPtr token);',
    ' [DllImport("advapi32.dll",SetLastError=true)] static extern bool GetTokenInformation(IntPtr token,int kind,IntPtr data,int length,out int required);',
    ' [DllImport("advapi32.dll",SetLastError=true)] static extern bool SetTokenInformation(IntPtr token,int kind,IntPtr data,int length);',
    ' [DllImport("advapi32.dll")] static extern bool EqualSid(IntPtr first,IntPtr second);',
    ' static void Need(bool value,string call) { if(!value) throw new Win32Exception(Marshal.GetLastWin32Error(),call); }',
    ' static IntPtr TokenInfo(IntPtr token,int kind) { int required; GetTokenInformation(token,kind,IntPtr.Zero,0,out required); if(required<=0) throw new Win32Exception(Marshal.GetLastWin32Error(),"GetTokenInformation-size"); IntPtr data=Marshal.AllocHGlobal(required); try { Need(GetTokenInformation(token,kind,data,required,out required),"GetTokenInformation"); return data; } catch { Marshal.FreeHGlobal(data); throw; } }',
    ' public static void Apply(int pid,string expectedImage) {',
    '  IntPtr process=IntPtr.Zero,token=IntPtr.Zero,user=IntPtr.Zero,owner=IntPtr.Zero,ownerRecord=IntPtr.Zero;',
    '  try {',
    '   process=OpenProcess(0x1000,false,pid); Need(process!=IntPtr.Zero,"OpenProcess"); if(GetProcessId(process)!=(uint)pid) throw new InvalidOperationException("process identity changed");',
    '   var image=new System.Text.StringBuilder(32768); uint size=(uint)image.Capacity; Need(QueryFullProcessImageName(process,0,image,ref size),"QueryFullProcessImageName"); if(!String.Equals(Path.GetFullPath(image.ToString()),Path.GetFullPath(expectedImage),StringComparison.OrdinalIgnoreCase)) throw new InvalidOperationException("process image changed");',
    '   FILETIME createdBefore,exit,kernel,userTime; Need(GetProcessTimes(process,out createdBefore,out exit,out kernel,out userTime),"GetProcessTimes");',
    '   Need(OpenProcessToken(process,0x88,out token),"OpenProcessToken"); user=TokenInfo(token,1); IntPtr userSid=Marshal.ReadIntPtr(user);',
    '   ownerRecord=Marshal.AllocHGlobal(IntPtr.Size); Marshal.WriteIntPtr(ownerRecord,userSid); Need(SetTokenInformation(token,4,ownerRecord,IntPtr.Size),"SetTokenInformation");',
    '   owner=TokenInfo(token,4); if(!EqualSid(userSid,Marshal.ReadIntPtr(owner))) throw new InvalidOperationException("token owner was not applied");',
    '   FILETIME createdAfter; Need(GetProcessTimes(process,out createdAfter,out exit,out kernel,out userTime),"GetProcessTimes"); if(createdBefore.Value!=createdAfter.Value) throw new InvalidOperationException("process creation identity changed");',
    '  } finally { if(ownerRecord!=IntPtr.Zero)Marshal.FreeHGlobal(ownerRecord); if(owner!=IntPtr.Zero)Marshal.FreeHGlobal(owner); if(user!=IntPtr.Zero)Marshal.FreeHGlobal(user); if(token!=IntPtr.Zero)CloseHandle(token); if(process!=IntPtr.Zero)CloseHandle(process); }',
    ' }',
    '}',
  ].join(' ')
  const script = [
    "$ErrorActionPreference='Stop'",
    "[Environment]::SetEnvironmentVariable('PSModulePath',[IO.Path]::Combine($PSHOME,'Modules'),[EnvironmentVariableTarget]::Process)",
    "[Console]::Out.WriteLine('TOKEN_OWNER_COMPILING')",
    'Add-Type -TypeDefinition $env:AUTOPROMPT_TOKEN_OWNER_SOURCE -Language CSharp',
    "[Console]::Out.WriteLine('TOKEN_OWNER_APPLYING')",
    '[AutopromptDefaultTokenOwner]::Apply([int]$env:AUTOPROMPT_TOKEN_OWNER_PID,$env:AUTOPROMPT_TOKEN_OWNER_IMAGE)',
    "[Console]::Out.WriteLine('TOKEN_OWNER_READY')",
  ].join(';')
  const systemRoot = process.env.SystemRoot || process.env.WINDIR
  if (typeof systemRoot !== 'string' || !/^[A-Za-z]:\\Windows$/iu.test(systemRoot)) {
    throw new RunRecordError('PRIVACY_UNSUPPORTED', 'Windows system root is unavailable for the default-owner helper')
  }
  const powershell = path.win32.join(systemRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe')
  const temporary = createWindowsCompilerDirectory('autoprompt-token-owner-')
  // The first native PowerShell/Add-Type startup on a Windows runner can be
  // slower than a warmed helper. Keep a finite setup bound without treating a
  // cold compiler as proof that private ownership cannot be established.
  const timeoutMs = 60000
  let result
  try {
    result = spawnSync(powershell, ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', script], {
      encoding: 'utf8', windowsHide: true, shell: false, timeout: timeoutMs, maxBuffer: 1024 * 1024,
      stdio: ['ignore', 'pipe', 'pipe'],
      cwd: path.win32.dirname(powershell),
      env: {
        ...windowsControllerEnvironment(systemRoot, temporary),
        AUTOPROMPT_TOKEN_OWNER_SOURCE: source,
        AUTOPROMPT_TOKEN_OWNER_PID: String(process.pid),
        AUTOPROMPT_TOKEN_OWNER_IMAGE: process.execPath,
      },
    })
  } finally {
    fs.rmSync(temporary, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })
  }
  if (result.error || result.signal || result.status !== 0 || result.stderr) {
    const helperPhase = String(result.stdout || '').includes('TOKEN_OWNER_APPLYING') ? 'applying'
      : String(result.stdout || '').includes('TOKEN_OWNER_COMPILING') ? 'compiling' : 'startup'
    const cause = result.error && typeof result.error.code === 'string' && /^[A-Z0-9_]{1,40}$/.test(result.error.code)
      ? result.error.code : `status ${result.status}`
    throw new RunRecordError('PRIVACY_UNSUPPORTED', `Cannot establish the Windows token user as the default owner for new run-record objects (${helperPhase}: ${cause})`, {
      stage: 'windows-default-token-owner',
      helperPhase,
      status: result.status,
      cause: result.error && result.error.code,
      signal: result.signal,
      timeoutMs,
      stderr: result.stderr && result.stderr.trim(),
    })
  }
  windowsDefaultTokenOwnerEstablished = true
  return { supported: true, mechanism: 'windows-token-owner' }
}

// CodeDOM creates nested source/output names below TEMP. Callers must remove
// the returned directory after the bounded compiler operation completes.
function createWindowsCompilerDirectory(prefix = 'autoprompt-compiler-') {
  if (typeof prefix !== 'string' || !/^[A-Za-z0-9_-]{1,48}-$/.test(prefix)) {
    throw new RunRecordError('PRIVACY_UNSUPPORTED', 'The Windows compiler directory prefix is invalid')
  }
  const systemRoot = process.env.SystemRoot || process.env.WINDIR
  if (typeof systemRoot !== 'string' || !/^[A-Za-z]:\\Windows$/iu.test(systemRoot)) {
    throw new RunRecordError('PRIVACY_UNSUPPORTED', 'Windows system root is unavailable for the private compiler helper')
  }
  // Node's userInfo is token-backed on Windows. Bun's Node compatibility
  // layer can instead follow the deliberately isolated HOME/USERPROFILE, so
  // that runtime uses fixed .NET known-folder calls in a clean child.
  const { localAppData } = windowsTokenProfileFolders(systemRoot)
  const inspectedLocalAppData = inspectPathNoFollow(localAppData)
  if (!inspectedLocalAppData.exists || !inspectedLocalAppData.realpath) throw new RunRecordError('PRIVACY_UNSUPPORTED', 'The current Windows token local application data root is unavailable')
  let temporary
  try {
    temporary = fs.mkdtempSync(path.join(inspectedLocalAppData.realpath, prefix))
    applyWindowsPrivateAcl(temporary)
    return temporary
  } catch (error) {
    if (temporary) { try { fs.rmSync(temporary, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }) } catch {} }
    throw error
  }
}

function ensureWindowsPrivateAcl(target) {
  if (process.platform !== 'win32') return { supported: true, mechanism: 'posix-mode' }
  ensureWindowsDefaultTokenOwner()
  return applyWindowsPrivateAcl(target)
}

function applyWindowsPrivateAcl(target) {
  const absolute = path.resolve(target)
  const before = fs.lstatSync(absolute)
  if (before.isSymbolicLink() || (!before.isDirectory() && !before.isFile())) {
    throw new RunRecordError('PRIVACY_UNSUPPORTED', 'A private Windows DACL requires a physical file or directory')
  }
  const systemRoot = process.env.SystemRoot || process.env.WINDIR
  if (typeof systemRoot !== 'string' || !/^[A-Za-z]:\\Windows$/iu.test(systemRoot)) {
    throw new RunRecordError('PRIVACY_UNSUPPORTED', 'Windows system root is unavailable for the private ACL helper')
  }
  const powershell = path.win32.join(systemRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe')
  // Callers select or claim controller-owned storage before establishment.
  // A fresh descriptor replaces explicit foreign grants too; /grant:r would
  // retain those grants even after inheritance was disabled. This does not
  // change which paths those callers authorize for permission updates.
  const script = [
    "$ErrorActionPreference='Stop'",
    '[Console]::OutputEncoding=[Text.UTF8Encoding]::new($false)',
    "[Environment]::SetEnvironmentVariable('PSModulePath',[IO.Path]::Combine($PSHOME,'Modules'),[EnvironmentVariableTarget]::Process)",
    '$p=$env:AUTOPROMPT_PRIVATE_ACL_PATH',
    "$directory=$env:AUTOPROMPT_PRIVATE_ACL_DIRECTORY -eq '1'",
    '$attributes=[System.IO.File]::GetAttributes($p)',
    "if(($attributes -band [System.IO.FileAttributes]::ReparsePoint) -ne 0){throw 'Private ACL target is redirected'}",
    "if((($attributes -band [System.IO.FileAttributes]::Directory) -ne 0) -ne $directory){throw 'Private ACL target type changed'}",
    '$identity=[System.Security.Principal.WindowsIdentity]::GetCurrent()',
    '$user=$identity.User',
    "$system=[System.Security.Principal.SecurityIdentifier]::new('S-1-5-18')",
    '$inheritance=[System.Security.AccessControl.InheritanceFlags]::None',
    'if($directory){$acl=[System.Security.AccessControl.DirectorySecurity]::new();$inheritance=[System.Security.AccessControl.InheritanceFlags]::ContainerInherit -bor [System.Security.AccessControl.InheritanceFlags]::ObjectInherit}else{$acl=[System.Security.AccessControl.FileSecurity]::new()}',
    '$acl.SetAccessRuleProtection($true,$false)',
    '$acl.SetOwner($user)',
    'foreach($sid in @($user,$system)){$rule=[System.Security.AccessControl.FileSystemAccessRule]::new($sid,[System.Security.AccessControl.FileSystemRights]::FullControl,$inheritance,[System.Security.AccessControl.PropagationFlags]::None,[System.Security.AccessControl.AccessControlType]::Allow);$acl.SetAccessRule($rule)}',
    'if($directory){[System.IO.Directory]::SetAccessControl($p,$acl);$verified=[System.IO.Directory]::GetAccessControl($p)}else{[System.IO.File]::SetAccessControl($p,$acl);$verified=[System.IO.File]::GetAccessControl($p)}',
    '$attributes=[System.IO.File]::GetAttributes($p)',
    "if(($attributes -band [System.IO.FileAttributes]::ReparsePoint) -ne 0 -or ((($attributes -band [System.IO.FileAttributes]::Directory) -ne 0) -ne $directory)){throw 'Private ACL target changed'}",
    '$ownerSid=$verified.GetOwner([System.Security.Principal.SecurityIdentifier]).Value',
    '$rules=@($verified.GetAccessRules($true,$true,[System.Security.Principal.SecurityIdentifier]) | ForEach-Object {[pscustomobject]@{identity=$_.IdentityReference.Value;sid=$_.IdentityReference.Value;type=$_.AccessControlType.ToString();inherited=$_.IsInherited;rights=[int]$_.FileSystemRights;inheritanceFlags=[int]$_.InheritanceFlags;propagationFlags=[int]$_.PropagationFlags}})',
    '$item=[pscustomobject]@{path=$p;owner=$ownerSid;ownerSid=$ownerSid;protected=$verified.AreAccessRulesProtected;rules=$rules}',
    '[pscustomobject]@{currentName=$identity.Name;currentSid=$user.Value;items=@($item)}|ConvertTo-Json -Compress -Depth 7',
  ].join(';')
  const result = spawnSync(powershell, ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', script], {
    encoding: 'utf8', windowsHide: true, shell: false, timeout: 60000, maxBuffer: 1024 * 1024,
    stdio: ['ignore', 'pipe', 'pipe'], cwd: path.win32.dirname(powershell),
    env: {
      ...windowsControllerEnvironment(systemRoot),
      AUTOPROMPT_PRIVATE_ACL_PATH: absolute,
      AUTOPROMPT_PRIVATE_ACL_DIRECTORY: before.isDirectory() ? '1' : '0',
    },
  })
  if (result.error || result.signal || result.status !== 0 || result.stderr) {
    throw new RunRecordError('PRIVACY_UNSUPPORTED', `Cannot establish an exact private Windows DACL: ${absolute}`, {
      status: result.status, signal: result.signal, cause: result.error && result.error.code,
      stderr: result.stderr && result.stderr.trim(),
    })
  }
  const after = fs.lstatSync(absolute)
  if (after.isSymbolicLink() || before.isDirectory() !== after.isDirectory() || !sameIdentity(statIdentity(before), statIdentity(after))) {
    throw new RunRecordError('PRIVACY_VIOLATION', `Private Windows ACL target changed during establishment: ${absolute}`)
  }
  let snapshot
  try { snapshot = JSON.parse(result.stdout) } catch { throw new RunRecordError('PRIVACY_UNSUPPORTED', 'Private Windows ACL helper returned invalid JSON') }
  validateWindowsAclSnapshot(snapshot)
  const item = snapshot.items[0]
  const expectedSids = new Set([snapshot.currentSid, 'S-1-5-18'])
  if (snapshot.items.length !== 1 || item.path !== absolute || item.ownerSid !== snapshot.currentSid
      || !Array.isArray(item.rules) || item.rules.length !== expectedSids.size
      || item.rules.some(rule => !expectedSids.delete(rule.sid) || rule.type !== 'Allow' || rule.inherited
        || rule.rights !== 2032127 || rule.inheritanceFlags !== (before.isDirectory() ? 3 : 0) || rule.propagationFlags !== 0)
      || expectedSids.size !== 0) {
    throw new RunRecordError('PRIVACY_VIOLATION', `Private Windows ACL helper did not establish the exact owner and grants: ${absolute}`)
  }
  return { supported: true, mechanism: 'windows-dacl' }
}

function windowsPowerShellEnvironment(extra = {}) {
  if (process.platform !== 'win32') return { ...process.env, ...extra }
  const systemRoot = process.env.SystemRoot || process.env.WINDIR
  const environment = windowsControllerEnvironment(systemRoot, extra.TEMP || extra.TMP)
  // Codex Desktop can run Node from a bundled PowerShell host whose
  // PSModulePath points only at the bundled PowerShell modules. Passing that
  // value to Windows PowerShell prevents built-in commands such as Get-Acl
  // from loading Microsoft.PowerShell.Security. Let powershell.exe rebuild
  // its own native module search path instead.
  for (const key of Object.keys(environment)) {
    if (key.toLowerCase() === 'psmodulepath') delete environment[key]
  }
  return { ...environment, ...extra }
}

function windowsControllerEnvironment(systemRoot, temporary) {
  if (typeof systemRoot !== 'string' || !/^[A-Za-z]:\\Windows$/iu.test(systemRoot)) throw new RunRecordError('PRIVACY_UNSUPPORTED', 'Windows system root is unavailable for the controller environment')
  const { profileHome, localAppData, roamingAppData } = windowsTokenProfileFolders(systemRoot)
  const appDataPath = path.dirname(localAppData)
  if (normalizeIdentityPath(appDataPath) !== normalizeIdentityPath(path.dirname(roamingAppData)) || !pathIsInside(profileHome, appDataPath)) throw new RunRecordError('PRIVACY_UNSUPPORTED', 'Windows token profile folders are not contained by one profile')
  const profile = inspectPathNoFollow(profileHome), appData = inspectPathNoFollow(appDataPath), roaming = inspectPathNoFollow(roamingAppData), local = inspectPathNoFollow(localAppData)
  if (!profile.exists || !profile.realpath || !appData.exists || !appData.realpath || !roaming.exists || !roaming.realpath || !local.exists || !local.realpath) throw new RunRecordError('PRIVACY_UNSUPPORTED', 'Windows token profile folders are unavailable')
  const tempPath = temporary || path.join(local.realpath, 'Temp'), temp = inspectPathNoFollow(tempPath)
  if (!temp.exists || !temp.realpath) throw new RunRecordError('PRIVACY_UNSUPPORTED', `Windows controller temporary folder is unavailable (${JSON.stringify({ path: tempPath, nearestExisting: temp.nearestExisting || null })})`, {
    path: tempPath, nearestExisting: temp.nearestExisting || null,
  })
  const parsed = path.win32.parse(profileHome)
  if (!/^[A-Za-z]:\\$/u.test(parsed.root)) throw new RunRecordError('PRIVACY_UNSUPPORTED', 'Windows token profile drive is unavailable')
  return { SystemRoot: systemRoot, WINDIR: systemRoot, SystemDrive: systemRoot.slice(0, 2), PATH: path.win32.join(systemRoot, 'System32'), PSModulePath: '', USERPROFILE: profile.realpath, HOME: profile.realpath, HOMEDRIVE: parsed.root.slice(0, 2), HOMEPATH: profileHome.slice(2), APPDATA: roaming.realpath, LOCALAPPDATA: local.realpath, TEMP: temp.realpath, TMP: temp.realpath }
}

function validateWindowsAclSnapshot(snapshot) {
  if (!snapshot || typeof snapshot !== 'object' || !Array.isArray(snapshot.items) || !snapshot.currentName || !snapshot.currentSid) {
    throw new RunRecordError('PRIVACY_UNSUPPORTED', 'Windows ACL audit did not return a complete owner/rule snapshot')
  }
  const allowed = new Set([
    String(snapshot.currentName).toLowerCase(),
    String(snapshot.currentSid).toLowerCase(),
    'nt authority\\system',
    's-1-5-18',
  ])
  for (const [index, item] of snapshot.items.entries()) {
    // The first item is the audited run root. Its DACL must be protected;
    // descendants may safely inherit only the allowlisted ACL from that root.
    if (index === 0 && item.protected !== true) {
      throw new RunRecordError('PRIVACY_VIOLATION', `Private run-record path has an inherited or unprotected Windows DACL: ${item.path}`, {
        path: item.path,
        protected: item.protected === true,
      })
    }
    const owner = String(item.owner || '').toLowerCase()
    const ownerSid = String(item.ownerSid || '').toLowerCase()
    if (!allowed.has(owner) && !allowed.has(ownerSid)) throw new RunRecordError('PRIVACY_VIOLATION', `Private run-record path has a foreign Windows owner: ${item.path}`, { path: item.path, owner: item.owner })
    for (const rule of item.rules || []) {
      if (String(rule.type).toLowerCase() !== 'allow') continue
      const identity = String(rule.identity || '').toLowerCase()
      const identitySid = String(rule.sid || '').toLowerCase()
      if (!allowed.has(identity) && !allowed.has(identitySid)) {
        throw new RunRecordError('PRIVACY_VIOLATION', `Private run-record path grants Windows access to an unapproved identity: ${item.path}`, {
          path: item.path,
          identity: rule.identity,
          inherited: Boolean(rule.inherited),
        })
      }
    }
  }
  return { valid: true, mechanism: 'windows-dacl', paths: snapshot.items.length }
}

function auditPrivatePermissions(runPath, options = {}) {
  const absolute = path.resolve(runPath)
  const additional = (options.additionalPaths || []).map(item => path.resolve(item))
  const recurse = options.recurse !== false
  if (process.platform !== 'win32') {
    const paths = [absolute, ...additional]
    const allowedOwnerReadableFiles = new Set((options.allowedOwnerReadableFiles || [])
      .map(item => path.resolve(item)))
    const visit = (privatePath, recurse) => {
      const stats = fs.lstatSync(privatePath)
      if (stats.isSymbolicLink()) throw new RunRecordError('PRIVACY_VIOLATION', `Private path is linked: ${privatePath}`)
      if (typeof process.getuid === 'function' && Number(stats.uid) !== process.getuid()) {
        throw new RunRecordError('PRIVACY_VIOLATION', `Private path has a foreign POSIX owner: ${privatePath}`, { uid: Number(stats.uid) })
      }
      const expected = stats.isDirectory()
        ? [0o700]
        : allowedOwnerReadableFiles.has(path.resolve(privatePath))
          ? [0o600, 0o644, 0o700]
          : [0o600, 0o700]
      const actual = stats.mode & 0o777
      if (!expected.includes(actual)) throw new RunRecordError('PRIVACY_VIOLATION', `Private path mode is broader or incompatible: ${privatePath}`, { path: privatePath, expected, actual })
      if (stats.isDirectory() && recurse) for (const name of fs.readdirSync(privatePath)) visit(path.join(privatePath, name), true)
    }
    visit(absolute, recurse)
    for (const privatePath of additional) visit(privatePath, false)
    return { valid: true, mechanism: 'posix-mode' }
  }
  const script = [
    "$ErrorActionPreference='Stop'",
    '$inputPaths=@($env:AUTOPROMPT_ACL_AUDIT_PATHS|ConvertFrom-Json)',
    '$root=$inputPaths[0]',
    '$targets=@($root)',
    "if($env:AUTOPROMPT_ACL_AUDIT_RECURSE -eq '1'){$targets+=@(Get-ChildItem -LiteralPath $root -Force -Recurse | ForEach-Object { $_.FullName })}",
    'for($i=1;$i -lt $inputPaths.Count;$i++){if(Test-Path -LiteralPath $inputPaths[$i]){$targets+=$inputPaths[$i]}}',
    '$identity=[System.Security.Principal.WindowsIdentity]::GetCurrent()',
    '$items=@()',
    'foreach($p in ($targets | Select-Object -Unique)){',
    '  $acl=Get-Acl -LiteralPath $p',
    '  $ownerSid=(New-Object System.Security.Principal.NTAccount($acl.Owner)).Translate([System.Security.Principal.SecurityIdentifier]).Value',
    '  $rules=@($acl.Access | ForEach-Object {$sid=$null;try{$sid=$_.IdentityReference.Translate([System.Security.Principal.SecurityIdentifier]).Value}catch{};[pscustomobject]@{identity=$_.IdentityReference.Value;sid=$sid;type=$_.AccessControlType.ToString();inherited=$_.IsInherited;rights=$_.FileSystemRights.ToString()}})',
    '  $items+=[pscustomobject]@{path=$p;owner=$acl.Owner;ownerSid=$ownerSid;protected=$acl.AreAccessRulesProtected;rules=$rules}',
    '}',
    '[Console]::OutputEncoding=[Text.UTF8Encoding]::new($false)',
    '[pscustomobject]@{currentName=$identity.Name;currentSid=$identity.User.Value;items=$items}|ConvertTo-Json -Compress -Depth 7',
  ].join(';')
  const environment = windowsPowerShellEnvironment({
    AUTOPROMPT_ACL_AUDIT_PATHS: JSON.stringify([absolute, ...additional]),
    AUTOPROMPT_ACL_AUDIT_RECURSE: recurse ? '1' : '0',
  })
  const powershell = path.win32.join(environment.SystemRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe')
  const result = spawnSync(powershell, ['-NoProfile', '-NonInteractive', '-Command', script], {
    encoding: 'utf8', windowsHide: true, timeout: 60000, stdio: ['ignore', 'pipe', 'pipe'], env: environment,
  })
  if (result.status !== 0) throw new RunRecordError('PRIVACY_UNSUPPORTED', 'Cannot revalidate Windows run-record ACLs', { status: result.status, cause: result.error && result.error.code, stderr: result.stderr && result.stderr.trim() })
  let snapshot
  try { snapshot = JSON.parse(result.stdout) } catch { throw new RunRecordError('PRIVACY_UNSUPPORTED', 'Windows ACL audit returned invalid JSON') }
  return validateWindowsAclSnapshot(snapshot)
}

function ensureDirectoryNoFollow(directory, boundary) {
  const absolute = path.resolve(directory)
  if (boundary && !pathIsInside(boundary, absolute)) {
    throw new RunRecordError('RUN_RECORD_UNSAFE', `Run-record directory escapes its registered root: ${absolute}`, { boundary })
  }
  const prefixes = existingPrefixes(absolute)
  for (const prefix of prefixes) {
    if (boundary && !pathIsInside(boundary, prefix) && !pathIsInside(prefix, boundary)) continue
    const before = inspectPathNoFollow(prefix)
    if (!before.exists) {
      try {
        fs.mkdirSync(prefix, { mode: DIRECTORY_MODE })
      } catch (error) {
        if (error.code !== 'EEXIST') throw error
      }
      chmodPrivate(prefix, DIRECTORY_MODE)
    }
    inspectPathNoFollow(prefix)
  }
  return inspectPathNoFollow(absolute)
}

function writeExclusiveFile(filename, bytes) {
  const flags = fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | (fs.constants.O_NOFOLLOW || 0)
  let fd
  try {
    fd = fs.openSync(filename, flags, FILE_MODE)
    const buffer = Buffer.isBuffer(bytes) ? bytes : Buffer.from(String(bytes))
    let offset = 0
    while (offset < buffer.length) offset += fs.writeSync(fd, buffer, offset, buffer.length - offset)
    fs.fsyncSync(fd)
  } finally {
    if (fd !== undefined) fs.closeSync(fd)
  }
  chmodPrivate(filename, FILE_MODE)
}

function processIsAlive(pid) {
  if (!Number.isSafeInteger(pid) || pid <= 0) return false
  try { process.kill(pid, 0); return true } catch (error) { return error.code === 'EPERM' }
}

function syncContainingDirectory(filename) {
  try {
    const descriptor = fs.openSync(path.dirname(filename), 'r')
    try { fs.fsyncSync(descriptor) } finally { fs.closeSync(descriptor) }
  } catch (error) {
    if (!error || !['EINVAL', 'EPERM', 'EISDIR', 'EBADF'].includes(error.code)) throw error
  }
}

function withOwnedLock(lockPath, operation, options = {}) {
  const staleAfterMs = Number.isSafeInteger(options.staleAfterMs) && options.staleAfterMs >= 0 ? options.staleAfterMs : 1000
  const now = options.now instanceof Date ? options.now : new Date(options.now || Date.now())
  const owner = {
    schema: 'autoprompt.private-lock.v3',
    pid: process.pid,
    hostname: os.hostname(),
    createdAt: now.toISOString(),
    processStartedAt: new Date(Date.now() - Math.floor(process.uptime() * 1000)).toISOString(),
    ownerToken: crypto.randomBytes(16).toString('hex'),
  }
  const ownerBytes = Buffer.from(`${JSON.stringify(owner)}\n`, 'utf8')
  const ownerPath = path.join(lockPath, 'owner.json')
  const publicationName = `.owner.${process.pid}.${owner.ownerToken}.tmp`
  const publicationPath = path.join(lockPath, publicationName)
  const recoveryDirectory = options.recoveryDirectory || path.join(path.dirname(lockPath), 'recovered-locks')
  let recovered = false

  const preserveEvidence = (bytes) => {
    ensureDirectoryNoFollow(recoveryDirectory, path.dirname(lockPath))
    const evidencePath = path.join(recoveryDirectory, `${sha256(bytes)}.json`)
    try { writeExclusiveFile(evidencePath, bytes) } catch (error) {
      if (error.code !== 'EEXIST') throw error
      const retained = readFileNoFollow(evidencePath)
      if (!retained || !retained.equals(bytes)) {
        throw new RunRecordError('RUN_RECORD_RECOVERY_REQUIRED', `Existing stale-lock evidence does not match: ${evidencePath}`)
      }
    }
    syncContainingDirectory(evidencePath)
  }

  const removeOwnedDirectory = (recordPath) => {
    if (recordPath) fs.unlinkSync(recordPath)
    if (fs.readdirSync(lockPath).length !== 0) {
      throw new RunRecordError('RUN_RECORD_UNSAFE', `Writer lock contains foreign entries: ${lockPath}`)
    }
    fs.rmdirSync(lockPath)
    syncContainingDirectory(lockPath)
  }

  for (let attempt = 0; attempt < 2; attempt++) {
    let acquired = false
    try {
      // mkdir is the atomic ownership primitive. The metadata is published only
      // after the private directory exists, so fresh empty/partial publication is
      // distinguishable from durable corrupt metadata and is treated as BUSY.
      fs.mkdirSync(lockPath, { mode: DIRECTORY_MODE })
      acquired = true
      chmodPrivate(lockPath, DIRECTORY_MODE)
      syncContainingDirectory(lockPath)
      if (typeof options.afterLockDirectoryCreate === 'function') options.afterLockDirectoryCreate({ lockPath, owner })
      writeExclusiveFile(publicationPath, ownerBytes)
      if (typeof options.beforeLockPublish === 'function') options.beforeLockPublish({ lockPath, publicationPath, owner })
      fs.renameSync(publicationPath, ownerPath)
      syncContainingDirectory(ownerPath)
      syncContainingDirectory(lockPath)
      try {
        if (typeof options.afterLockPublish === 'function') options.afterLockPublish({ lockPath, owner })
        return operation({ owner, recovered })
      } finally {
        const current = readFileNoFollow(ownerPath)
        let saved = null
        try { saved = current && JSON.parse(current.toString('utf8')) } catch {}
        if (!saved || saved.ownerToken !== owner.ownerToken) {
          throw new RunRecordError('RUN_RECORD_UNSAFE', `Writer lock ownership changed before release: ${lockPath}`)
        }
        removeOwnedDirectory(ownerPath)
      }
    } catch (error) {
      if (acquired) {
        // Normal local failures are cleaned up. A process crash bypasses this path;
        // the next contender observes the bounded incomplete directory below.
        try {
          if (fs.existsSync(publicationPath)) fs.unlinkSync(publicationPath)
          if (fs.existsSync(ownerPath)) {
            const bytes = readFileNoFollow(ownerPath)
            let saved = null
            try { saved = JSON.parse(bytes.toString('utf8')) } catch {}
            if (!saved || saved.ownerToken !== owner.ownerToken) throw error
            fs.unlinkSync(ownerPath)
          }
          if (fs.existsSync(lockPath) && fs.readdirSync(lockPath).length === 0) fs.rmdirSync(lockPath)
          syncContainingDirectory(lockPath)
        } catch (cleanupError) {
          if (cleanupError !== error) throw cleanupError
        }
        throw error
      }
      if (error.code !== 'EEXIST') throw error

      let lockItem
      try { lockItem = fs.lstatSync(lockPath) } catch (inspectionError) {
        if (inspectionError.code === 'ENOENT') continue
        throw inspectionError
      }
      if (typeof options.afterContendedLockLstat === 'function') options.afterContendedLockLstat({ lockPath, lockItem, attempt })
      if (lockItem.isSymbolicLink()) {
        throw new RunRecordError('RUN_RECORD_UNSAFE', `Writer lock is a link or name surrogate: ${lockPath}`)
      }
      // Preserve compatibility with already persisted v2 lock files. They may be
      // recovered once, but a hard-linked/foreign object is never trusted.
      if (!lockItem.isDirectory()) {
        if (!lockItem.isFile() || Number(lockItem.nlink) !== 1) {
          throw new RunRecordError('RUN_RECORD_UNSAFE', `Writer lock is not one physical object: ${lockPath}`)
        }
        let bytes
        try { bytes = readFileNoFollow(lockPath) } catch (readError) {
          if (readError.code === 'ENOENT') continue
          throw readError
        }
        if (bytes === null) continue
        let staleOwner
        try { staleOwner = JSON.parse(bytes.toString('utf8')) } catch {
          throw new RunRecordError('RUN_RECORD_RECOVERY_REQUIRED', `Writer lock metadata is corrupt: ${lockPath}`)
        }
        const created = Date.parse(staleOwner.createdAt)
        const ageMs = Number.isFinite(created) ? now.getTime() - created : -1
        const safelyStale = staleOwner.schema === 'autoprompt.private-lock.v2' && staleOwner.hostname === os.hostname() &&
          Number.isSafeInteger(staleOwner.pid) && !processIsAlive(staleOwner.pid) && ageMs >= staleAfterMs
        if (!safelyStale) throw new RunRecordError('RUN_RECORD_BUSY', `Writer lock is active or not safely stale: ${lockPath}`, { owner: staleOwner, ageMs, staleAfterMs })
        preserveEvidence(bytes)
        fs.unlinkSync(lockPath)
        syncContainingDirectory(lockPath)
        recovered = true
        continue
      }

      const inspected = inspectPathNoFollow(lockPath)
      if (!inspected.exists) continue
      let entries
      try { entries = fs.readdirSync(lockPath) } catch (inspectionError) {
        if (inspectionError.code === 'ENOENT') continue
        throw inspectionError
      }
      const publications = entries.filter((entry) => /^\.owner\.\d+\.[a-f0-9]{32}\.tmp$/.test(entry))
      const metadataExists = entries.includes('owner.json')
      const foreign = entries.filter((entry) => entry !== 'owner.json' && !publications.includes(entry))
      if (foreign.length || publications.length > 1 || (metadataExists && publications.length)) {
        throw new RunRecordError('RUN_RECORD_UNSAFE', `Writer lock contains foreign or ambiguous entries: ${lockPath}`, { entries })
      }
      const lockAgeMs = now.getTime() - lockItem.mtimeMs
      let bytes = null
      let staleOwner = null
      let recordPath = null
      if (metadataExists) {
        recordPath = ownerPath
        try { bytes = readFileNoFollow(recordPath) } catch (readError) {
          if (readError.code === 'ENOENT') continue
          throw readError
        }
        if (bytes === null) continue
        try { staleOwner = JSON.parse(bytes.toString('utf8')) } catch {
          if (lockAgeMs < staleAfterMs) throw new RunRecordError('RUN_RECORD_BUSY', `Writer lock publication is still in progress: ${lockPath}`, { ageMs: lockAgeMs, staleAfterMs })
          throw new RunRecordError('RUN_RECORD_RECOVERY_REQUIRED', `Writer lock metadata is corrupt: ${lockPath}`)
        }
      } else if (publications.length) {
        recordPath = path.join(lockPath, publications[0])
        try { bytes = readFileNoFollow(recordPath) } catch (readError) {
          if (readError.code === 'ENOENT') continue
          throw readError
        }
        if (bytes === null) continue
        try { staleOwner = JSON.parse(bytes.toString('utf8')) } catch {}
      }
      const created = staleOwner && Date.parse(staleOwner.createdAt)
      const ageMs = Number.isFinite(created) ? now.getTime() - created : -1
      const safelyStale = staleOwner && staleOwner.schema === 'autoprompt.private-lock.v3' && staleOwner.hostname === os.hostname() &&
        Number.isSafeInteger(staleOwner.pid) && !processIsAlive(staleOwner.pid) && ageMs >= staleAfterMs
      if (safelyStale) {
        const afterRead = inspectPathNoFollow(lockPath)
        if (!sameIdentity(inspected.identity, afterRead.identity)) throw new RunRecordError('RUN_RECORD_UNSAFE', `Writer lock changed during stale recovery: ${lockPath}`)
        preserveEvidence(bytes)
        removeOwnedDirectory(recordPath)
        recovered = true
        continue
      }
      if (!metadataExists && lockAgeMs >= staleAfterMs) {
        const evidence = Buffer.from(`${JSON.stringify({
          schema: 'autoprompt.incomplete-private-lock.v1',
          lockName: path.basename(lockPath),
          entries,
          bytesSha256: bytes ? sha256(bytes) : null,
          directoryIdentity: inspected.identity,
        })}\n`, 'utf8')
        preserveEvidence(evidence)
        removeOwnedDirectory(recordPath)
        recovered = true
        continue
      }
      throw new RunRecordError('RUN_RECORD_BUSY', `Writer lock is active or publication is not safely stale: ${lockPath}`, { owner: staleOwner, ageMs, lockAgeMs, staleAfterMs })
    }
  }
  throw new RunRecordError('RUN_RECORD_BUSY', `Could not acquire writer lock after bounded stale recovery: ${lockPath}`)
}

function readFileNoFollow(filename) {
  const inspected = inspectPathNoFollow(filename, { mustBeDirectory: false })
  if (!inspected.exists) return null
  const stats = fs.lstatSync(filename, { bigint: true })
  if (!stats.isFile()) throw new RunRecordError('RUN_RECORD_UNSAFE', `Expected a regular ownership file: ${filename}`)
  if (Number(stats.nlink) !== 1) {
    throw new RunRecordError('RUN_RECORD_UNSAFE', `Hard-linked private run-record files are not allowed: ${filename}`, { nlink: Number(stats.nlink) })
  }
  const flags = fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0)
  const fd = fs.openSync(filename, flags)
  try {
    const opened = fs.fstatSync(fd, { bigint: true })
    if (!sameIdentity(statIdentity(stats), statIdentity(opened))) {
      throw new RunRecordError('RUN_RECORD_UNSAFE', `Ownership file changed while it was opened: ${filename}`)
    }
    return fs.readFileSync(fd)
  } finally {
    fs.closeSync(fd)
  }
}

function canonicalTargetIdentity(options) {
  if (options.targetKind === 'non-filesystem' || options.nonFilesystem === true) {
    if (!options.targetIdentity) throw new RunRecordError('RUN_RECORD_UNSAFE', 'A stable targetIdentity is required for a non-filesystem target')
    return `non-filesystem:${options.targetIdentity}`
  }
  if (!options.targetPath) throw new RunRecordError('RUN_RECORD_UNSAFE', 'targetPath is required for a filesystem target')
  const target = path.resolve(options.targetPath)
  let real = target
  try {
    real = fs.realpathSync.native(target)
  } catch (error) {
    if (error.code !== 'ENOENT') throw new RunRecordError('RUN_RECORD_UNSAFE', `Cannot identify target: ${target}`, { cause: error.code })
  }
  return `filesystem:${normalizeIdentityPath(real)}`
}

function markerFor(rootKind, providerId, targetIdentity) {
  return {
    schema: OWNER_SCHEMA,
    owner: 'autoprompt',
    provider_id: providerId,
    root_kind: rootKind,
    target_identity_sha256: sha256(targetIdentity),
  }
}

function markerMatches(actual, expected) {
  return actual && Object.keys(expected).every(key => actual[key] === expected[key])
}

function preflightOwnedRoot(rootPath, expectedMarker) {
  const inspected = inspectPathNoFollow(rootPath)
  if (!inspected.exists) return { claimable: true, exists: false }
  const markerPath = path.join(rootPath, OWNER_FILE)
  const markerBytes = readFileNoFollow(markerPath)
  if (markerBytes === null) {
    const entries = fs.readdirSync(rootPath)
    if (entries.length === 0) return { claimable: true, exists: true }
    throw new RunRecordError('RUN_RECORD_UNSAFE', `Existing run root has no Autoprompt ownership marker: ${rootPath}`, { path: rootPath })
  }
  let actual
  try { actual = JSON.parse(markerBytes.toString('utf8')) } catch {
    throw new RunRecordError('RUN_RECORD_UNSAFE', `Run-root ownership marker is invalid: ${markerPath}`, { path: markerPath })
  }
  if (!markerMatches(actual, expectedMarker)) {
    throw new RunRecordError('RUN_RECORD_UNSAFE', `Run root is owned by another target or provider: ${rootPath}`, { expected: expectedMarker, actual })
  }
  return { claimable: false, exists: true }
}

function verifyRootOwnership(rootPath, rootKind, providerId, targetIdentity) {
  const expected = markerFor(rootKind, providerId, targetIdentity)
  const result = preflightOwnedRoot(path.resolve(rootPath), expected)
  if (!result.exists || result.claimable) {
    throw new RunRecordError('RUN_RECORD_UNSAFE', `Run root has no confirmed ownership marker: ${rootPath}`)
  }
  return true
}

function claimRoot(rootPath, expectedMarker, boundary) {
  const preflight = preflightOwnedRoot(rootPath, expectedMarker)
  ensureDirectoryNoFollow(rootPath, boundary)
  const markerPath = path.join(rootPath, OWNER_FILE)
  if (preflight.claimable) {
    try {
      writeExclusiveFile(markerPath, `${JSON.stringify(expectedMarker)}\n`)
    } catch (error) {
      if (error.code !== 'EEXIST') throw error
    }
  }
  const confirmed = preflightOwnedRoot(rootPath, expectedMarker)
  if (!confirmed.exists) throw new RunRecordError('RUN_RECORD_FAILURE', `Failed to claim run root: ${rootPath}`)
  const bound = inspectPathNoFollow(rootPath)
  const privacy = ensureWindowsPrivateAcl(rootPath)
  return { path: rootPath, identity: bound.identity, realpath: bound.realpath, privacy }
}

function projectEligibility(options, targetPath) {
  const disallowed = [
    ['project mutation was not explicitly allowed', options.allowProjectMutation !== true && options.projectMutationAllowed !== true],
    ['target is read-only', options.readOnly === true],
    ['exact-tree behavior is required', options.exactTree === true],
    ['target is an archive or package input', options.archive === true || options.packageInput === true],
    ['target is non-filesystem', options.targetKind === 'non-filesystem' || options.nonFilesystem === true],
    ['provider policy forbids target history', options.policyRestricted === true],
  ]
  const blocked = disallowed.find(([, value]) => value)
  if (blocked) return { eligible: false, reason: blocked[0] }

  let target
  try { target = inspectPathNoFollow(targetPath) } catch (error) { return { eligible: false, reason: error.message } }
  if (!target.exists) return { eligible: false, reason: 'target directory does not exist' }

  try { fs.accessSync(targetPath, fs.constants.R_OK | fs.constants.W_OK) } catch { return { eligible: false, reason: 'target directory is not writable' } }
  const gitDir = path.join(targetPath, '.git')
  try {
    const git = inspectPathNoFollow(gitDir)
    if (!git.exists) return { eligible: false, reason: 'non-Git targets use a sidecar' }
  } catch (error) {
    return { eligible: false, reason: error.message }
  }
  if (fs.existsSync(path.join(targetPath, 'package.json'))) {
    return { eligible: false, reason: 'package targets use a sidecar until their package boundary is mechanically proven' }
  }
  const infoDir = path.join(gitDir, 'info')
  try {
    const info = inspectPathNoFollow(infoDir)
    if (!info.exists) return { eligible: false, reason: 'Git info directory is unavailable for a local-only exclude' }
    const exclude = path.join(infoDir, 'exclude')
    const exclusion = inspectPathNoFollow(exclude, { mustBeDirectory: false })
    if (exclusion.exists && !fs.lstatSync(exclude).isFile()) return { eligible: false, reason: 'Git exclude is not a regular file' }
  } catch (error) {
    return { eligible: false, reason: error.message }
  }
  try {
    preflightOwnedRoot(path.join(targetPath, '.autoprompt'), markerFor('project', options.providerId || 'codex', canonicalTargetIdentity(options)))
  } catch (error) {
    return { eligible: false, reason: error.message }
  }
  return { eligible: true, reason: null }
}

function appendGitInfoExclude(targetPath) {
  const exclude = path.join(targetPath, '.git', 'info', 'exclude')
  const current = readFileNoFollow(exclude)
  const text = current ? current.toString('utf8') : ''
  if (text.split(/\r?\n/).some(line => line.trim() === '.autoprompt/')) return
  const prefix = text.length > 0 && !text.endsWith('\n') ? '\n' : ''
  const flags = fs.constants.O_WRONLY | fs.constants.O_APPEND | fs.constants.O_CREAT | (fs.constants.O_NOFOLLOW || 0)
  const fd = fs.openSync(exclude, flags, FILE_MODE)
  try {
    fs.writeSync(fd, `${prefix}.autoprompt/\n`)
    fs.fsyncSync(fd)
  } finally { fs.closeSync(fd) }
}

function selectSafeRunRoot(options = {}) {
  const providerId = options.providerId || 'codex'
  const targetIdentity = canonicalTargetIdentity(options)
  const targetHash = sha256(targetIdentity)
  const targetPath = options.targetPath && path.resolve(options.targetPath)
  const eligibility = targetPath ? projectEligibility({ ...options, providerId }, targetPath) : { eligible: false, reason: 'target is non-filesystem' }

  if (eligibility.eligible) {
    const rootPath = path.join(targetPath, '.autoprompt')
    const marker = markerFor('project', providerId, targetIdentity)
    const binding = claimRoot(rootPath, marker, targetPath)
    appendGitInfoExclude(targetPath)
    return Object.freeze({
      kind: 'project', rootPath, binding, targetPath, targetIdentity, targetIdentitySha256: targetHash,
      providerId, projectRejection: null, ownerFile: path.join(rootPath, OWNER_FILE),
    })
  }

  const configuredCanonicalRoot = options.canonicalProviderPrivateRoot || process.env.AUTOPROMPT_PRIVATE_ROOT ||
    path.join(process.env.CODEX_HOME || path.join(os.homedir(), '.codex'), 'autoprompt-private')
  const privateBase = path.resolve(configuredCanonicalRoot)
  if (options.providerPrivateRoot && path.resolve(options.providerPrivateRoot) !== privateBase) {
    throw new RunRecordError('SIDECAR_ROOT_NONCANONICAL', 'Caller-supplied providerPrivateRoot cannot choose a second run-history root; use the provider-owned canonicalProviderPrivateRoot', {
      supplied: path.resolve(options.providerPrivateRoot),
      canonical: privateBase,
    })
  }
  const canonicalFilesystemTarget = targetIdentity.startsWith('filesystem:') ? targetIdentity.slice('filesystem:'.length) : null
  if (targetPath && (pathIsInside(targetPath, privateBase) || (canonicalFilesystemTarget && pathIsInside(canonicalFilesystemTarget, privateBase)))) {
    throw new RunRecordError('RUN_RECORD_UNSAFE', 'Provider-private sidecar root must resolve outside the target tree', { targetPath, privateBase })
  }
  const baseParent = path.dirname(privateBase)
  inspectPathNoFollow(baseParent)
  ensureDirectoryNoFollow(privateBase, baseParent)
  const rootPath = path.join(privateBase, 'targets', targetHash, '.autoprompt')
  const marker = markerFor('sidecar', providerId, targetIdentity)
  const binding = claimRoot(rootPath, marker, privateBase)
  return Object.freeze({
    kind: 'sidecar', rootPath, binding, targetPath: targetPath || null, targetIdentity, targetIdentitySha256: targetHash,
    providerId, projectRejection: eligibility.reason, ownerFile: path.join(rootPath, OWNER_FILE),
  })
}

function assertNoPrivatePackagePaths(selection, files) {
  const list = Array.isArray(files) ? files : []
  const privatePaths = list.map(item => typeof item === 'string' ? item : item && (item.path || item.name)).filter(Boolean)
    .filter(item => item.replace(/\\/g, '/').toLowerCase().split('/').includes('.autoprompt'))
  if (privatePaths.length) throw new RunRecordError('RUN_RECORD_UNSAFE', 'Private run records entered a package or archive boundary', { privatePaths })
  return { checked: true, privatePaths: [] }
}

function assertNpmPackExcludesRunRecords(selection, options = {}) {
  const packageCandidate = options.packageRoot || selection.targetPath
  if (!packageCandidate) return { checked: false, files: [] }
  const packageRoot = path.resolve(packageCandidate)
  if (!fs.existsSync(path.join(packageRoot, 'package.json'))) return { checked: false, files: [] }
  const npmCommand = options.npmCommand || 'npm'
  const command = process.platform === 'win32' ? (process.env.ComSpec || 'cmd.exe') : npmCommand
  const args = process.platform === 'win32'
    ? ['/d', '/s', '/c', options.npmCommand || 'npm.cmd', 'pack', '--dry-run', '--json', '--ignore-scripts']
    : ['pack', '--dry-run', '--json', '--ignore-scripts']
  // A fixed cache under the shared OS temp directory can belong to a previous
  // caller. Own only a fresh per-check directory; explicit caches stay owned
  // by the caller and are never removed here.
  const privateCache = options.npmCache ? null : fs.mkdtempSync(path.join(os.tmpdir(), 'autoprompt-npm-pack-cache-'))
  try {
    const environment = Object.fromEntries(Object.entries(process.env)
      .filter(([key]) => key.toLowerCase() !== 'npm_config_cache'))
    environment.npm_config_cache = options.npmCache || privateCache
    const result = spawnSync(command, args, {
      cwd: packageRoot,
      encoding: 'utf8',
      windowsHide: true,
      env: environment,
    })
    if (result.status !== 0) throw new RunRecordError('RUN_RECORD_FAILURE', 'Cannot prove the npm package boundary excludes run records', {
      status: result.status,
      cause: result.error && (result.error.code || result.error.message),
      stderr: result.stderr && result.stderr.trim(),
      stdout: result.stdout && result.stdout.trim(),
    })
    let reports
    try { reports = JSON.parse(result.stdout) } catch { throw new RunRecordError('RUN_RECORD_FAILURE', 'npm pack did not return its machine-readable file list') }
    const files = reports.flatMap(report => report.files || [])
    assertNoPrivatePackagePaths(selection, files)
    return { checked: true, files }
  } finally {
    if (privateCache) fs.rmSync(privateCache, { recursive: true, force: true })
  }
}

function assertRunRecordBoundary(selection, options = {}) {
  assertDirectoryBinding(selection.binding)
  assertProjectRecordUntracked(selection)
  assertNoPrivatePackagePaths(selection, options.packageFiles || options.archiveFiles || [])
  const pack = options.runNpmPack === false ? { checked: false, files: [] } : assertNpmPackExcludesRunRecords(selection, options)
  return { phase: options.phase || 'unspecified', localOnly: true, pack }
}

function validRunId(value) {
  return typeof value === 'string' && value !== '.' && value !== '..' && /^[A-Za-z0-9][A-Za-z0-9._-]{7,127}$/.test(value)
}

function generatedRunId(now = new Date()) {
  return `${now.toISOString().replace(/[-:]/g, '').replace(/\.\d{3}Z$/, 'Z')}-${crypto.randomBytes(8).toString('hex')}`
}

function allocateRunDirectory(selection, options = {}) {
  assertDirectoryBinding(selection.binding)
  const runsPath = path.join(selection.rootPath, 'runs')
  ensureDirectoryNoFollow(runsPath, selection.rootPath)
  const supplied = options.runId
  if (supplied !== undefined && !validRunId(supplied)) throw new RunRecordError('RUN_RECORD_FAILURE', `Invalid run id: ${supplied}`)

  const attempts = supplied === undefined ? 16 : 1
  for (let attempt = 0; attempt < attempts; attempt++) {
    const runId = supplied || generatedRunId(options.now)
    const runPath = path.join(runsPath, runId)
    if (!pathIsInside(runsPath, runPath)) throw new RunRecordError('RUN_RECORD_UNSAFE', `Run id escapes the runs directory: ${runId}`)
    try {
      fs.mkdirSync(runPath, { mode: DIRECTORY_MODE })
      chmodPrivate(runPath, DIRECTORY_MODE)
      ensureWindowsPrivateAcl(runPath)
      const inspected = inspectPathNoFollow(runPath)
      assertDirectoryBinding(selection.binding)
      return Object.freeze({ runId, runPath, binding: { path: runPath, identity: inspected.identity, realpath: inspected.realpath } })
    } catch (error) {
      if (error.code !== 'EEXIST') throw error
      if (supplied !== undefined) {
        throw new RunRecordError('RUN_ID_COLLISION', `Run id is already allocated: ${runId}`, { runId, runPath })
      }
    }
  }
  throw new RunRecordError('RUN_RECORD_FAILURE', 'Could not allocate a unique run directory')
}

function assertProjectRecordUntracked(selection) {
  if (selection.kind !== 'project') return { checked: false, tracked: [] }
  const result = spawnSync('git', ['-C', selection.targetPath, 'ls-files', '--cached', '--', '.autoprompt'], { encoding: 'utf8', windowsHide: true })
  if (result.status !== 0) throw new RunRecordError('RUN_RECORD_FAILURE', `Cannot prove project run records are untracked: ${result.stderr.trim()}`)
  const tracked = result.stdout.split(/\r?\n/).filter(Boolean)
  if (tracked.length) throw new RunRecordError('RUN_RECORD_UNSAFE', 'Project run records are tracked or staged', { tracked })
  return { checked: true, tracked: [] }
}

module.exports = {
  OWNER_FILE,
  OWNER_SCHEMA,
  DIRECTORY_MODE,
  FILE_MODE,
  RunRecordError,
  sha256,
  pathIsInside,
  inspectPathNoFollow,
  readFileNoFollow,
  ensureDirectoryNoFollow,
  assertDirectoryBinding,
  canonicalTargetIdentity,
  verifyRootOwnership,
  selectSafeRunRoot,
  resolveSafeRunRoot: selectSafeRunRoot,
  allocateRunDirectory,
  assertProjectRecordUntracked,
  assertNoPrivatePackagePaths,
  assertNpmPackExcludesRunRecords,
  assertRunRecordBoundary,
  ensureWindowsPrivateAcl,
  ensureWindowsDefaultTokenOwner,
  createWindowsCompilerDirectory,
  windowsControllerEnvironment,
  validateWindowsAclSnapshot,
  auditPrivatePermissions,
  withOwnedLock,
}
