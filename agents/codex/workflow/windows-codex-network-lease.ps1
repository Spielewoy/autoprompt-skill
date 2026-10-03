# Persistent, activation-owned Windows Codex offline account/network lease.
# ABI/constants: microsoft/windows-rs tag 0.58.0, WindowsFilteringPlatform/mod.rs.
# ALE_USER_ID descriptor construction follows openai/codex 0.148.0 windows-sandbox/src/wfp.rs.
[CmdletBinding()]
param(
  [Parameter(Mandatory=$true)][ValidateSet('Install','Verify','Remove','AccountCreate','AccountVerify','AccountDisable','AccountDelete')][string]$Mode,
  [Parameter(Mandatory=$true)][string]$AccountName,
  [string]$Sid,
  [Parameter(Mandatory=$true)][string]$ActivationId,
  [Parameter(Mandatory=$true)][string]$JournalPath,
  [switch]$WorkerDrained,
  [string]$AccountJournalPath,
  [string]$UsersPath,
  [string]$TargetPath
)
$ErrorActionPreference = 'Stop'
if ([Environment]::OSVersion.Platform -ne [PlatformID]::Win32NT) { throw 'Windows only' }
$principal = [Security.Principal.WindowsPrincipal]::new([Security.Principal.WindowsIdentity]::GetCurrent())
if (-not $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) { throw 'An administrator controller is required; automatic elevation is unavailable' }
if ($AccountName -cnotmatch '^apcodex_[a-f0-9]{12}$' -or $ActivationId -cnotmatch '^[a-f0-9]{32}$' -or ($Mode -ne 'AccountCreate' -and $Sid -notmatch '^S-1-5-21-[0-9]+-[0-9]+-[0-9]+-[0-9]+$')) { throw 'Fresh activation account identity required' }
$account = New-Object System.Security.Principal.NTAccount([Environment]::MachineName, $AccountName)
if ($Mode -eq 'Install' -or $Mode -eq 'Verify') {
  if ($account.Translate([System.Security.Principal.SecurityIdentifier]).Value -cne $Sid) { throw 'Fresh account SID mismatch' }
}
if (-not [IO.Path]::IsPathRooted($JournalPath) -or $JournalPath.StartsWith('\\')) { throw 'Local absolute journal required' }
$JournalPath = [IO.Path]::GetFullPath($JournalPath)
$parent = Get-Item -LiteralPath ([IO.Path]::GetDirectoryName($JournalPath))
if (-not $parent.PSIsContainer -or ($parent.Attributes -band [IO.FileAttributes]::ReparsePoint)) { throw 'Physical private journal parent required' }
if ($Mode -eq 'Remove' -and -not $WorkerDrained) { throw 'Removal requires controller-confirmed worker drain' }
Add-Type -TypeDefinition @'
using System;
using System.IO;
using System.Runtime.InteropServices;
using System.Security.AccessControl;
using System.Security.Principal;
using System.Text;
using System.Collections.Generic;
public static class CodexNetworkLease {
 [StructLayout(LayoutKind.Sequential,CharSet=CharSet.Unicode)] public struct Display { [MarshalAs(UnmanagedType.LPWStr)] public string name; [MarshalAs(UnmanagedType.LPWStr)] public string description; }
 [StructLayout(LayoutKind.Sequential)] public struct Blob { public uint size; public IntPtr data; }
 [StructLayout(LayoutKind.Sequential)] public struct Value { public int type; public IntPtr data; }
 [StructLayout(LayoutKind.Sequential)] public struct Action { public uint type; public Guid key; }
 [StructLayout(LayoutKind.Explicit,Size=16)] public struct Context { [FieldOffset(0)] public ulong rawContext; [FieldOffset(0)] public Guid providerContextKey; }
 [StructLayout(LayoutKind.Sequential)] public struct Condition { public Guid fieldKey; public uint matchType; public Value value; }
 [StructLayout(LayoutKind.Sequential)] public struct Filter { public Guid key; public Display display; public uint flags; public IntPtr providerKey; public Blob providerData; public Guid layer; public Guid sublayer; public Value weight; public uint count; public IntPtr conditions; public Action action; public Context context; public IntPtr reserved; public ulong id; public Value effectiveWeight; }
 [StructLayout(LayoutKind.Sequential,CharSet=CharSet.Unicode)] public struct Provider { public Guid key; public Display display; public uint flags; public Blob data; [MarshalAs(UnmanagedType.LPWStr)] public string service; }
 [StructLayout(LayoutKind.Sequential)] public struct Sublayer { public Guid key; public Display display; public uint flags; public IntPtr providerKey; public Blob data; public ushort weight; }
 [StructLayout(LayoutKind.Sequential,CharSet=CharSet.Unicode)] public struct Session { public Guid key; public Display display; public uint flags; public uint timeout; public uint processId; public IntPtr sid; [MarshalAs(UnmanagedType.LPWStr)] public string username; public int kernelMode; }
 [DllImport("fwpuclnt.dll",CharSet=CharSet.Unicode)] static extern uint FwpmEngineOpen0(string server,uint auth,IntPtr identity,ref Session session,out IntPtr engine);
 [DllImport("fwpuclnt.dll")] static extern uint FwpmEngineClose0(IntPtr engine);
 [DllImport("fwpuclnt.dll")] static extern uint FwpmTransactionBegin0(IntPtr engine,uint flags);
 [DllImport("fwpuclnt.dll")] static extern uint FwpmTransactionCommit0(IntPtr engine);
 [DllImport("fwpuclnt.dll")] static extern uint FwpmTransactionAbort0(IntPtr engine);
 [DllImport("fwpuclnt.dll")] static extern uint FwpmProviderAdd0(IntPtr engine,ref Provider provider,IntPtr sd);
 [DllImport("fwpuclnt.dll")] static extern uint FwpmSubLayerAdd0(IntPtr engine,ref Sublayer sublayer,IntPtr sd);
 [DllImport("fwpuclnt.dll")] static extern uint FwpmFilterAdd0(IntPtr engine,ref Filter filter,IntPtr sd,out ulong id);
 [DllImport("fwpuclnt.dll")] static extern uint FwpmProviderGetByKey0(IntPtr engine,ref Guid key,out IntPtr value);
 [DllImport("fwpuclnt.dll")] static extern uint FwpmSubLayerGetByKey0(IntPtr engine,ref Guid key,out IntPtr value);
 [DllImport("fwpuclnt.dll")] static extern uint FwpmFilterGetByKey0(IntPtr engine,ref Guid key,out IntPtr value);
 [DllImport("fwpuclnt.dll")] static extern uint FwpmFilterDeleteByKey0(IntPtr engine,ref Guid key);
 [DllImport("fwpuclnt.dll")] static extern uint FwpmSubLayerDeleteByKey0(IntPtr engine,ref Guid key);
 [DllImport("fwpuclnt.dll")] static extern uint FwpmProviderDeleteByKey0(IntPtr engine,ref Guid key);
 [DllImport("fwpuclnt.dll")] static extern void FwpmFreeMemory0(ref IntPtr value);
 [DllImport("netapi32.dll",CharSet=CharSet.Unicode)] static extern uint NetUserGetInfo(string server,string user,uint level,out IntPtr value);
 [DllImport("netapi32.dll")] static extern uint NetApiBufferFree(IntPtr value);
 [DllImport("advapi32.dll",CharSet=CharSet.Unicode,SetLastError=true)] [return:MarshalAs(UnmanagedType.Bool)] static extern bool LookupAccountSidW(string system,byte[] sid,IntPtr name,ref uint nameLength,IntPtr domain,ref uint domainLength,out uint use);
 public static void AccountAbsent(string account,string sid) {
  IntPtr user; uint result=NetUserGetInfo(null,account,0,out user); if(user!=IntPtr.Zero)NetApiBufferFree(user);
  Need(result==2221,"account-name-not-proven-absent:"+result);
  var value=new SecurityIdentifier(sid); byte[] bytes=new byte[value.BinaryLength]; value.GetBinaryForm(bytes,0);
  uint nameLength=0,domainLength=0,use;
  bool mapped=LookupAccountSidW(null,bytes,IntPtr.Zero,ref nameLength,IntPtr.Zero,ref domainLength,out use);
  int error=Marshal.GetLastWin32Error(); Need(!mapped&&error==1332,"account-sid-not-proven-absent:"+error);
 }
 static readonly Guid User = new Guid("af043a0a-b34d-4f86-979c-c90371af6e66");
 static readonly Guid[] Layers = {new Guid("c38d57d1-05a7-4c33-904f-7fbceee60e82"),new Guid("4a72393b-319f-44bc-84c3-ba54dcb3b6b4")};
 static string B(string key,bool value) { return "\""+key+"\":"+(value?"true":"false"); }
 static string N(string key,ulong value) { return "\""+key+"\":"+value; }
 static string G(string key,Guid value) { return "\""+key+"\":\""+value.ToString()+"\""; }
 static void Trace(string stage,params string[] fields) { Console.Error.WriteLine("{\"kind\":\"codex-wfp-semantic-readback\",\"stage\":\""+stage+"\","+String.Join(",",fields)+"}"); }
 static void Need(bool value,string label) { if(!value) throw new InvalidOperationException(label); }
 static void Check(uint status,string label) { if(status!=0) throw new InvalidOperationException(label+":0x"+status.ToString("x8")); }
 static IntPtr Put<T>(T value) { IntPtr p=Marshal.AllocHGlobal(Marshal.SizeOf(typeof(T))); Marshal.StructureToPtr(value,p,false); return p; }
 static T Read<T>(IntPtr p) { Need(p!=IntPtr.Zero,"null-readback"); return (T)Marshal.PtrToStructure(p,typeof(T)); }
 static byte[] Bytes(Blob b) { Need(b.size<=65536 && (b.size==0||b.data!=IntPtr.Zero),"blob-bound"); byte[] bytes=new byte[b.size]; if(bytes.Length>0) Marshal.Copy(b.data,bytes,0,bytes.Length); return bytes; }
 static bool Equal(byte[] a,byte[] b) { if(a.Length!=b.Length)return false; for(int i=0;i<a.Length;i++)if(a[i]!=b[i])return false; return true; }
 public static void Durable(string path,string text) { using(var f=new FileStream(path,FileMode.CreateNew,FileAccess.Write,FileShare.Read,4096,FileOptions.WriteThrough)) { byte[] b=new UTF8Encoding(false).GetBytes(text+"\n"); f.Write(b,0,b.Length); f.Flush(true); } }
 public static string Run(bool remove,bool install,string sid,string activation,string provider,string sublayer,string session,string ipv4,string ipv6,int expectedWeight) {
  Need(install ? expectedWeight==-1 : expectedWeight>=0&&expectedWeight<=65535,"sublayer-weight-authority");
  ushort observedWeight=0;
  // All declared pointer-containing structures are the SDK's native x64 ABI.
  Need(IntPtr.Size==8,"64-bit-controller-required");
  Trace("abi",N("providerSize",(ulong)Marshal.SizeOf(typeof(Provider))),N("sublayerSize",(ulong)Marshal.SizeOf(typeof(Sublayer))),N("filterSize",(ulong)Marshal.SizeOf(typeof(Filter))),N("sublayerFlagsOffset",(ulong)Marshal.OffsetOf(typeof(Sublayer),"flags").ToInt64()),N("sublayerWeightOffset",(ulong)Marshal.OffsetOf(typeof(Sublayer),"weight").ToInt64()));
  Need(Marshal.SizeOf(typeof(Value))==16 && Marshal.SizeOf(typeof(Condition))==40 && Marshal.SizeOf(typeof(Filter))==200,"sdk-abi-mismatch");
  Guid pk=new Guid(provider),sk=new Guid(sublayer); Guid[] keys={new Guid(ipv4),new Guid(ipv6)};
  string name="Autoprompt activation WFP "+activation;
  byte[] sd; var descriptor=new RawSecurityDescriptor("D:(A;;0x1;;;"+sid+")"); sd=new byte[descriptor.BinaryLength]; descriptor.GetBinaryForm(sd,0);
  IntPtr sdBytes=Marshal.AllocHGlobal(sd.Length),providerPointer=Put(pk),blobPointer=IntPtr.Zero,conditionPointer=IntPtr.Zero,engine=IntPtr.Zero;
  bool transaction=false;
  try {
   Marshal.Copy(sd,0,sdBytes,sd.Length); blobPointer=Put(new Blob{size=(uint)sd.Length,data=sdBytes});
   conditionPointer=Put(new Condition{fieldKey=User,matchType=0,value=new Value{type=14,data=blobPointer}});
   var se=new Session{key=new Guid(session),display=new Display{name=name,description=sid},timeout=30000};
   Check(FwpmEngineOpen0(null,0xffffffff,IntPtr.Zero,ref se,out engine),"engine-open");
   Check(FwpmTransactionBegin0(engine,0),"transaction-begin"); transaction=true;
   if(install) {
    var p=new Provider{key=pk,display=new Display{name=name,description=sid},flags=1}; Check(FwpmProviderAdd0(engine,ref p,IntPtr.Zero),"provider-add");
    var s=new Sublayer{key=sk,display=new Display{name=name,description=sid},flags=1,providerKey=providerPointer,weight=0x8000}; Check(FwpmSubLayerAdd0(engine,ref s,IntPtr.Zero),"sublayer-add");
    for(int i=0;i<2;i++) { var f=new Filter{key=keys[i],display=new Display{name=name,description=sid},flags=1,providerKey=providerPointer,layer=Layers[i],sublayer=sk,count=1,conditions=conditionPointer,action=new Action{type=4097}}; ulong id; Check(FwpmFilterAdd0(engine,ref f,IntPtr.Zero,out id),"filter-add"); }
   }
   if(install) { Check(FwpmTransactionCommit0(engine),"install-commit"); transaction=false; }
   // Check the exact persisted closure before exposing a successful diagnostic
   // or deleting anything. No broad enumeration or default Codex GUID exists.
   IntPtr got=IntPtr.Zero;
   var failures=new List<string>();
   try {
    uint status=FwpmProviderGetByKey0(engine,ref pk,out got); Trace("provider-api",N("status",status)); Check(status,"provider-read");
    var p=Read<Provider>(got);
    bool ok=p.key==pk&&p.flags==1&&p.display.name==name&&p.display.description==sid&&p.data.size==0&&p.service==null;
    Trace("provider",G("key",p.key),N("flags",p.flags),N("dataSize",p.data.size),B("keyEqual",p.key==pk),B("nameEqual",p.display.name==name),B("sidEqual",p.display.description==sid),B("serviceNull",p.service==null),B("semanticEqual",ok));
    if(!ok)failures.Add("provider-semantic");
   } catch(Exception e) { Trace("provider-error",N("hresult",unchecked((uint)e.HResult))); failures.Add("provider-read"); } finally { if(got!=IntPtr.Zero)FwpmFreeMemory0(ref got); }
   try {
    uint status=FwpmSubLayerGetByKey0(engine,ref sk,out got); Trace("sublayer-api",N("status",status)); Check(status,"sublayer-read");
    var sub=Read<Sublayer>(got); observedWeight=sub.weight; Guid actualProvider=Read<Guid>(sub.providerKey);
    // BFE assigns the closest available sublayer weight. Record it once on
    // installation; later deletion must match that durable installation receipt.
    // MicrosoftDocs/win32: desktop-src/FWP/installing-a-provider.md
    bool ok=sub.key==sk&&sub.flags==1&&actualProvider==pk&&(install ? true : sub.weight==expectedWeight)&&sub.display.name==name&&sub.display.description==sid&&sub.data.size==0;
    Trace("sublayer",G("key",sub.key),G("providerKey",actualProvider),N("flags",sub.flags),N("weight",sub.weight),N("dataSize",sub.data.size),B("keyEqual",sub.key==sk),B("providerEqual",actualProvider==pk),B("nameEqual",sub.display.name==name),B("sidEqual",sub.display.description==sid),B("weightEqual",install||sub.weight==expectedWeight),B("semanticEqual",ok));
    if(!ok)failures.Add("sublayer-semantic");
   } catch(Exception e) { Trace("sublayer-error",N("hresult",unchecked((uint)e.HResult))); failures.Add("sublayer-read"); } finally { if(got!=IntPtr.Zero)FwpmFreeMemory0(ref got); }
   ulong[] ids=new ulong[2];
   for(int i=0;i<2;i++)try {
    string stage="filter-v"+(i==0?"4":"6");
    uint status=FwpmFilterGetByKey0(engine,ref keys[i],out got); Trace(stage+"-api",N("status",status)); Check(status,"filter-read"); var f=Read<Filter>(got); Guid actualProvider=Read<Guid>(f.providerKey);
    bool ok=f.key==keys[i]&&f.flags==1&&actualProvider==pk&&f.layer==Layers[i]&&f.sublayer==sk&&f.count==1&&f.action.type==4097&&f.action.key==Guid.Empty&&f.context.providerContextKey==Guid.Empty&&f.reserved==IntPtr.Zero&&f.display.name==name&&f.display.description==sid&&f.providerData.size==0&&f.weight.type==0&&f.id!=0;
    Trace(stage,G("key",f.key),G("providerKey",actualProvider),G("layerKey",f.layer),G("sublayerKey",f.sublayer),N("flags",f.flags),N("conditionCount",f.count),N("action",f.action.type),N("weightType",unchecked((uint)f.weight.type)),N("filterId",f.id),N("dataSize",f.providerData.size),B("keyEqual",f.key==keys[i]),B("providerEqual",actualProvider==pk),B("layerEqual",f.layer==Layers[i]),B("sublayerEqual",f.sublayer==sk),B("actionKeyEmpty",f.action.key==Guid.Empty),B("contextEmpty",f.context.providerContextKey==Guid.Empty),B("reservedNull",f.reserved==IntPtr.Zero),B("nameEqual",f.display.name==name),B("sidEqual",f.display.description==sid),B("semanticEqual",ok));
    if(!ok)failures.Add(stage+"-semantic");
    if(f.count==1) {
     var condition=Read<Condition>(f.conditions); bool sdEqual=false;
     if(condition.value.type==14)sdEqual=Equal(Bytes(Read<Blob>(condition.value.data)),sd);
     bool conditionOk=condition.fieldKey==User&&condition.matchType==0&&condition.value.type==14&&sdEqual;
     Trace(stage+"-condition",G("fieldKey",condition.fieldKey),N("matchType",condition.matchType),N("valueType",unchecked((uint)condition.value.type)),B("fieldEqual",condition.fieldKey==User),B("descriptorBytesEqual",sdEqual),B("semanticEqual",conditionOk));
     if(!conditionOk)failures.Add(stage+"-unique-user-condition-semantic");
    } else failures.Add(stage+"-condition-count");
    ids[i]=f.id;
   } catch(Exception e) { Trace("filter-v"+(i==0?"4":"6")+"-error",N("hresult",unchecked((uint)e.HResult))); failures.Add("filter-v"+(i==0?"4":"6")+"-read"); } finally { if(got!=IntPtr.Zero)FwpmFreeMemory0(ref got); }
   Need(failures.Count==0,"wfp-semantic-closure:"+String.Join(",",failures));
   if(remove) { for(int i=0;i<2;i++)Check(FwpmFilterDeleteByKey0(engine,ref keys[i]),"filter-delete"); Check(FwpmSubLayerDeleteByKey0(engine,ref sk),"sublayer-delete"); Check(FwpmProviderDeleteByKey0(engine,ref pk),"provider-delete"); }
   if(remove) { Check(FwpmTransactionCommit0(engine),"remove-commit"); transaction=false; }
   return "{\"verified\":true,\"removed\":"+(remove?"true":"false")+",\"sublayerWeight\":"+observedWeight+",\"filterIds\":["+ids[0]+","+ids[1]+"]}";
  } finally { if(transaction)FwpmTransactionAbort0(engine); if(engine!=IntPtr.Zero)FwpmEngineClose0(engine); if(conditionPointer!=IntPtr.Zero)Marshal.FreeHGlobal(conditionPointer); if(blobPointer!=IntPtr.Zero)Marshal.FreeHGlobal(blobPointer); Marshal.FreeHGlobal(providerPointer); Marshal.FreeHGlobal(sdBytes); }
 }
}
'@
if ($Mode.StartsWith('Account')) {
 [Environment]::SetEnvironmentVariable('PSModulePath',[IO.Path]::Combine($PSHOME,'Modules'),'Process')
 Add-Type -AssemblyName System.Security
 foreach($p in @($AccountJournalPath,$UsersPath,$TargetPath)) { if(-not [IO.Path]::IsPathRooted($p) -or $p.StartsWith('\\')){throw 'Local absolute account paths required'} }
 $file=Get-Item -LiteralPath $AccountJournalPath
 if($file.PSIsContainer -or ($file.Attributes -band [IO.FileAttributes]::ReparsePoint) -or $file.Length -gt 16384){throw 'Invalid account journal'}
 $j=Get-Content -LiteralPath $AccountJournalPath -Raw|ConvertFrom-Json
 if($j.schemaVersion -ne 1 -or $j.accountName -cne $AccountName -or $j.leaseId -cne $ActivationId -or $j.usersPath -cne $UsersPath -or $j.targetPath -cne $TargetPath){throw 'Foreign account journal'}
 $me=[Security.Principal.WindowsIdentity]::GetCurrent().User
 if($j.ownerSid -and $j.ownerSid -cne $me.Value){throw 'Account controller identity changed'}
 function SaveAccount($state){$j.state=$state;$bytes=[Text.Encoding]::UTF8.GetBytes(($j|ConvertTo-Json -Compress -Depth 6));$f=[IO.File]::Open($AccountJournalPath,'Open','Write','Read');try{$f.SetLength(0);$f.Write($bytes,0,$bytes.Length);$f.Flush($true)}finally{$f.Dispose()}}
 function BoundAccount(){ $a=Get-LocalUser -Name $AccountName -ErrorAction Stop;if($a.SID.Value -cne $Sid -or $j.sid -cne $Sid){throw 'Account SID changed'};return $a }
 function TargetRule(){return [Security.AccessControl.FileSystemAccessRule]::new([Security.Principal.SecurityIdentifier]::new($j.sid),'ReadAndExecute','ContainerInherit,ObjectInherit','None','Allow')}
 function TargetAcl(){ $item=Get-Item -LiteralPath $TargetPath -Force;if(-not $item.PSIsContainer -or ($item.Attributes -band [IO.FileAttributes]::ReparsePoint)){throw 'Physical target required'};return Get-Acl -LiteralPath $TargetPath }
 function Groups($a){return @((Get-LocalGroup -ErrorAction Stop|ForEach-Object{$g=$_;if(Get-LocalGroupMember -Group $g -ErrorAction Stop|Where-Object {$_.SID.Value -ceq $a.SID.Value}){$g.SID.Value}})|Sort-Object)}
 function VerifyAccount(){
  $a=BoundAccount
  if(-not $a.Enabled){throw 'Owned account disabled'}
  if((($j.groupSids|Sort-Object) -join ',') -cne ((Groups $a) -join ',')){throw 'Owned account groups changed'}
  $acl=TargetAcl;$rules=@($acl.GetAccessRules($true,$true,[Security.Principal.SecurityIdentifier])|Where-Object {$_.IdentityReference.Value -ceq $Sid})
  $rule=TargetRule
  if($rules.Count -ne 1 -or $rules[0].IsInherited -or $rules[0].FileSystemRights -ne $rule.FileSystemRights -or $rules[0].InheritanceFlags -ne $rule.InheritanceFlags -or $rules[0].PropagationFlags -ne $rule.PropagationFlags -or $rules[0].AccessControlType -ne $rule.AccessControlType){throw 'Owned target read grant changed'}
  $u=Get-Content -LiteralPath $UsersPath -Raw|ConvertFrom-Json
  if($u.offline.username -cne $AccountName -or -not $u.offline.password){throw 'Owned offline credential changed'}
  $acl=Get-Acl -LiteralPath $UsersPath
  $rights=[Security.AccessControl.FileSystemRights]([int][Security.AccessControl.FileSystemRights]::Read -bor [int][Security.AccessControl.FileSystemRights]::ChangePermissions)
  $ownerRule=[Security.AccessControl.FileSystemAccessRule]::new($me,$rights,'Allow')
  $systemRule=[Security.AccessControl.FileSystemAccessRule]::new([Security.Principal.SecurityIdentifier]::new('S-1-5-18'),'Read','Allow')
  $rules=@($acl.GetAccessRules($true,$true,[Security.Principal.SecurityIdentifier]))
  if(-not $acl.AreAccessRulesProtected -or $acl.GetOwner([Security.Principal.SecurityIdentifier]).Value -cne $me.Value -or $rules.Count -ne 2){throw 'Credential seal changed'}
  foreach($r in $rules){if($r.IsInherited -or $r.AccessControlType -ne 'Allow' -or $r.InheritanceFlags -ne 'None' -or $r.PropagationFlags -ne 'None'){throw 'Credential rule changed'};if($r.IdentityReference.Value -ceq $me.Value){if($r.FileSystemRights -ne $ownerRule.FileSystemRights){throw 'Controller credential rights changed'}}elseif($r.IdentityReference.Value -ceq 'S-1-5-18'){if($r.FileSystemRights -ne $systemRule.FileSystemRights){throw 'System credential rights changed'}}else{throw 'Foreign credential rule'}}
 }
 switch($Mode){
  'AccountCreate'{
   if($j.state -cne 'PLANNED' -or $j.sid){throw 'Account creation is not fresh'}
   if(Get-LocalUser -ErrorAction Stop|Where-Object {$_.Name -ieq $AccountName}){throw 'Fresh account already exists'}
   $j.ownerSid=$me.Value;SaveAccount 'CREATING'
   $bytes=New-Object byte[] 48;$rng=[Security.Cryptography.RandomNumberGenerator]::Create();try{$rng.GetBytes($bytes)}finally{$rng.Dispose()}
   $password='aA1!'+[Convert]::ToBase64String($bytes)
   $a=New-LocalUser -Name $AccountName -Password (ConvertTo-SecureString $password -AsPlainText -Force) -AccountNeverExpires -PasswordNeverExpires -UserMayNotChangePassword -ErrorAction Stop
   $j.sid=$a.SID.Value;$Sid=$j.sid;SaveAccount 'CREATED'
   $usersGroup=Get-LocalGroup -SID 'S-1-5-32-545' -ErrorAction Stop
   $sandboxGroup=Get-LocalGroup -Name 'CodexSandboxUsers' -ErrorAction Stop
   foreach($g in @($usersGroup,$sandboxGroup)){if(-not(Get-LocalGroupMember -Group $g -ErrorAction Stop|Where-Object {$_.SID.Value -ceq $Sid})){Add-LocalGroupMember -Group $g -Member $a -ErrorAction Stop}}
   $j.groupSids=@($usersGroup.SID.Value,$sandboxGroup.SID.Value)|Sort-Object
   if(($j.groupSids -join ',') -cne ((Groups $a) -join ',')){throw 'Fresh account has unexpected groups'}
   SaveAccount 'GROUPED'
   $acl=TargetAcl;$acl.AddAccessRule((TargetRule));[IO.Directory]::SetAccessControl($TargetPath,$acl);SaveAccount 'TARGET_READ_GRANTED'
   $u=Get-Content -LiteralPath $UsersPath -Raw|ConvertFrom-Json
   $u.offline.username=$AccountName
   $blob=[Security.Cryptography.ProtectedData]::Protect([Text.Encoding]::UTF8.GetBytes($password),$null,[Security.Cryptography.DataProtectionScope]::LocalMachine)
   $u.offline.password=[Convert]::ToBase64String($blob)
   $acl=Get-Acl -LiteralPath $UsersPath;$acl.AddAccessRule([Security.AccessControl.FileSystemAccessRule]::new($me,'Write','Allow'));[IO.File]::SetAccessControl($UsersPath,$acl)
   $credentialBytes=[Text.Encoding]::UTF8.GetBytes(($u|ConvertTo-Json -Compress -Depth 6))
   $credentialFile=[IO.File]::Open($UsersPath,'Open','Write','Read')
   try{$credentialFile.SetLength(0);$credentialFile.Write($credentialBytes,0,$credentialBytes.Length);$credentialFile.Flush($true)}finally{$credentialFile.Dispose()}
   $acl=[Security.AccessControl.FileSecurity]::new();$acl.SetAccessRuleProtection($true,$false);$acl.SetOwner($me)
   $rights=[Security.AccessControl.FileSystemRights]([int][Security.AccessControl.FileSystemRights]::Read -bor [int][Security.AccessControl.FileSystemRights]::ChangePermissions)
   $acl.AddAccessRule([Security.AccessControl.FileSystemAccessRule]::new($me,$rights,'Allow'));$acl.AddAccessRule([Security.AccessControl.FileSystemAccessRule]::new([Security.Principal.SecurityIdentifier]::new('S-1-5-18'),'Read','Allow'));[IO.File]::SetAccessControl($UsersPath,$acl)
   SaveAccount 'SEALED';VerifyAccount
  }
  'AccountVerify'{if($j.state -cne 'SEALED'){throw 'Account lease is incomplete'};VerifyAccount}
  'AccountDisable'{ $a=BoundAccount;Disable-LocalUser -InputObject $a -ErrorAction Stop;SaveAccount 'DISABLED' }
  'AccountDelete'{
   if(-not $WorkerDrained){throw 'Account removal requires independently confirmed drain'}
   $a=BoundAccount;Disable-LocalUser -InputObject $a -ErrorAction Stop;SaveAccount 'DISABLED'
   $acl=TargetAcl;$acl.RemoveAccessRuleSpecific((TargetRule));[IO.Directory]::SetAccessControl($TargetPath,$acl);SaveAccount 'TARGET_READ_REMOVED'
   Remove-LocalUser -InputObject $a -ErrorAction Stop
   [CodexNetworkLease]::AccountAbsent($AccountName,$Sid);SaveAccount 'DELETED'
  }
 }
 [pscustomobject]@{sid=$j.sid;state=$j.state;ownerSid=$j.ownerSid;groupSids=$j.groupSids}|ConvertTo-Json -Compress
 return
}

if ($Mode -eq 'Remove') { [CodexNetworkLease]::AccountAbsent($AccountName,$Sid) }
if ($Mode -eq 'Install') {
  $record = [ordered]@{ schemaVersion=1; purpose='activation-owned-fresh-account-network-deny'; accountName=$AccountName; sid=$Sid; activationId=$ActivationId; providerKey=[guid]::NewGuid().ToString(); sublayerKey=[guid]::NewGuid().ToString(); sessionKey=[guid]::NewGuid().ToString(); ipv4FilterKey=[guid]::NewGuid().ToString(); ipv6FilterKey=[guid]::NewGuid().ToString(); persistent=$true; helperSha256=(Get-FileHash -LiteralPath $PSCommandPath -Algorithm SHA256).Hash.ToLowerInvariant() }
  [CodexNetworkLease]::Durable($JournalPath, ($record | ConvertTo-Json -Compress))
} else {
  $file = Get-Item -LiteralPath $JournalPath
  if ($file.PSIsContainer -or ($file.Attributes -band [IO.FileAttributes]::ReparsePoint) -or $file.Length -gt 8192) { throw 'Invalid WFP journal' }
  $record = Get-Content -LiteralPath $JournalPath -Raw | ConvertFrom-Json
  if ($record.schemaVersion -ne 1 -or $record.purpose -cne 'activation-owned-fresh-account-network-deny' -or $record.accountName -cne $AccountName -or $record.sid -cne $Sid -or $record.activationId -cne $ActivationId -or $record.persistent -ne $true -or $record.helperSha256 -cne (Get-FileHash -LiteralPath $PSCommandPath -Algorithm SHA256).Hash.ToLowerInvariant()) { throw 'Foreign WFP journal' }
}
$expectedWeight = -1
if ($Mode -ne 'Install') {
  $receiptFile = Get-Item -LiteralPath ($JournalPath + '.install')
  if ($receiptFile.PSIsContainer -or ($receiptFile.Attributes -band [IO.FileAttributes]::ReparsePoint) -or $receiptFile.Length -gt 8192) { throw 'Invalid WFP installation receipt' }
  $receipt = Get-Content -LiteralPath $receiptFile.FullName -Raw | ConvertFrom-Json
  $journalHash = (Get-FileHash -LiteralPath $JournalPath -Algorithm SHA256).Hash.ToLowerInvariant()
  if ($receipt.verified -ne $true -or $receipt.removed -ne $false -or $receipt.journalSha256 -cne $journalHash -or ($receipt.sublayerWeight -isnot [long] -and $receipt.sublayerWeight -isnot [int]) -or $receipt.sublayerWeight -lt 0 -or $receipt.sublayerWeight -gt 65535) { throw 'Foreign WFP installation receipt' }
  $expectedWeight = [int]$receipt.sublayerWeight
}
$result = [CodexNetworkLease]::Run(($Mode -eq 'Remove'),($Mode -eq 'Install'),$Sid,$ActivationId,$record.providerKey,$record.sublayerKey,$record.sessionKey,$record.ipv4FilterKey,$record.ipv6FilterKey,$expectedWeight)
$receiptResult = $result | ConvertFrom-Json
$receiptResult | Add-Member -NotePropertyName journalSha256 -NotePropertyValue (Get-FileHash -LiteralPath $JournalPath -Algorithm SHA256).Hash.ToLowerInvariant()
$result = $receiptResult | ConvertTo-Json -Compress
if ($Mode -ne 'Verify') { [CodexNetworkLease]::Durable(($JournalPath + '.' + $Mode.ToLowerInvariant()), $result) }
Write-Output $result
