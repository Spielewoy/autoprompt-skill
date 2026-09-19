// Calls the actual production byte/multiplicity transformation. No NTFS or
// AppContainer behavior is simulated or claimed by this portable contract.
using System;
using System.Linq;
using System.Reflection;
public static class InheritanceProvenanceContract {
 static int cases;
 static readonly string inherited="ABMUAP8BHwABAQAAAAAABRIAAAA=",flat="AAMUAP8BHwABAQAAAAAABRIAAAA=";
 static string[] Restore(string[] current,string[] oldInherited,string[] oldExplicit){try{return (string[])typeof(WindowsAppContainerResourcesNative).GetMethod("RestoreInheritanceAces",BindingFlags.Static|BindingFlags.NonPublic).Invoke(null,new object[]{current,oldInherited,oldExplicit});}catch(TargetInvocationException error){throw error.InnerException;}}
 static void Need(bool condition){if(!condition)throw new InvalidOperationException("inheritance-contract");}
 static void Refuses(string code,Action action){try{action();}catch(WindowsAppContainerResourcesNative.Refusal error){Need(error.Code==code);cases++;return;}throw new InvalidOperationException("accepted:"+code);}
 static void Equal(string[] actual,params string[] expected){Need(actual.SequenceEqual(expected));cases++;}
 public static int Run(){
  string[] empty=new string[0],one={flat},saved=(string[])one.Clone();Equal(Restore(one,new[]{inherited},empty),inherited);Need(one.SequenceEqual(saved));
  Equal(Restore(new[]{flat,flat},new[]{inherited,inherited},empty),inherited,inherited);
  Equal(Restore(new[]{flat,flat},new[]{inherited},new[]{flat}),flat,inherited);
  Equal(Restore(new[]{flat,flat,flat},new[]{inherited},new[]{flat}),flat,flat,inherited);
  byte[] changedBytes=Convert.FromBase64String(flat);changedBytes[4]^=2;string changed=Convert.ToBase64String(changedBytes);
  Equal(Restore(new[]{changed,flat},new[]{inherited},empty),changed,inherited);
  Equal(Restore(new[]{flat,changed},empty,empty),flat,changed);
  Refuses("WINDOWS_ACL_INHERITANCE_CHANGED",()=>Restore(new[]{changed},new[]{inherited},empty));
  foreach(int offset in new[]{0,1,19}){byte[] altered=Convert.FromBase64String(flat);altered[offset]^=1;Refuses("WINDOWS_ACL_INHERITANCE_CHANGED",()=>Restore(new[]{Convert.ToBase64String(altered)},new[]{inherited},empty));}
  Refuses("WINDOWS_ACL_INHERITANCE_CHANGED",()=>Restore(empty,new[]{inherited},empty));
  Refuses("WINDOWS_ACL_INHERITANCE_CHANGED",()=>Restore(one,new[]{inherited},new[]{flat}));
  Refuses("WINDOWS_ACL_INHERITANCE_CHANGED",()=>Restore(new[]{inherited},new[]{inherited},empty));
  Refuses("WINDOWS_RESOURCE_INVALID",()=>Restore(one,new[]{"invalid-base64"},empty));
  Refuses("WINDOWS_RESOURCE_INVALID",()=>Restore(one,new[]{flat},empty));
  Refuses("WINDOWS_RESOURCE_INVALID",()=>Restore(one,new[]{inherited},new[]{inherited}));
  Refuses("WINDOWS_RESOURCE_INVALID",()=>Restore(one,new[]{inherited},new[]{changed}));
  Refuses("WINDOWS_RESOURCE_INVALID",()=>Restore(null,new[]{inherited},empty));
  Refuses("WINDOWS_RESOURCE_INVALID",()=>Restore(one,null,empty));
  Refuses("WINDOWS_RESOURCE_INVALID",()=>Restore(one,new[]{inherited},null));
  byte[] malformed=Convert.FromBase64String(inherited);malformed[2]--;Refuses("WINDOWS_RESOURCE_INVALID",()=>Restore(one,new[]{Convert.ToBase64String(malformed)},empty));
  Refuses("WINDOWS_RESOURCE_INVALID",()=>Restore(Enumerable.Repeat(flat,8193).ToArray(),new[]{inherited},empty));
  Refuses("WINDOWS_RESOURCE_INVALID",()=>Restore(one,Enumerable.Repeat(inherited,8193).ToArray(),empty));
  return cases;
 }
}
