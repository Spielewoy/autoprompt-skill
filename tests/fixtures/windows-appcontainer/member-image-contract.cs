// Exact production reconciliation method with only its native wait boundary
// substituted by the test loader. These are lifetime/budget logic tests.
using System;
using System.ComponentModel;
using System.Diagnostics;
using System.Reflection;
using System.Collections.Generic;
using System.Threading;
public static class MemberImageWaitMock {
 public static Queue<UInt32> Results=new Queue<UInt32>();
 public static List<UInt32> Requests=new List<UInt32>();
 public static UInt32 Wait(IntPtr process,UInt32 milliseconds){Requests.Add(milliseconds);if(Results.Count==0)throw new InvalidOperationException("unexpected-wait");return Results.Dequeue();}
 public static void Set(params UInt32[] results){Results=new Queue<UInt32>(results);Requests.Clear();}
}
public static class MemberImageContract {
 delegate void Reconcile(IntPtr process,Int32 error,Stopwatch clock,Int32 deadline,ref Int32 budget);
 static Reconcile Method=(Reconcile)Delegate.CreateDelegate(typeof(Reconcile),typeof(WindowsAppContainerNative).GetMethod("ReconcileMemberImageFailure",BindingFlags.NonPublic|BindingFlags.Static));
 static void Need(Boolean value,String code){if(!value)throw new InvalidOperationException(code);}
 static Win32Exception Failure(Int32 error,Stopwatch clock,Int32 deadline,ref Int32 budget){try{Method(new IntPtr(123),error,clock,deadline,ref budget);}catch(Win32Exception failure){if(error==5)Need(failure.Message.Length<=80&&System.Text.RegularExpressions.Regex.IsMatch(failure.Message,@"\Await:[0-9]+\.-?[0-9]+:[0-9]+\.-?[0-9]+ grace:[0-9]+\.[0-9]+\z"),"closed-wrapper-compatible-diagnostic");return failure;}throw new InvalidOperationException("expected-refusal");}
 public static void Run(){Int32 count=0,budget;
  MemberImageWaitMock.Set(0);budget=25;Method(new IntPtr(123),5,Stopwatch.StartNew(),1000,ref budget);Need(budget==25&&MemberImageWaitMock.Requests.Count==1,"already-exited");count++;
  MemberImageWaitMock.Set(258,0);budget=25;Method(new IntPtr(123),5,Stopwatch.StartNew(),1000,ref budget);Need(budget==0&&MemberImageWaitMock.Requests[1]==25,"late-signaled");count++;
  MemberImageWaitMock.Set(258,258);budget=25;var failure=Failure(5,Stopwatch.StartNew(),1000,ref budget);Need(failure.NativeErrorCode==5&&failure.Message.Contains(":258.0 grace:")&&budget==0,"live-refuses");count++;
  MemberImageWaitMock.Set(258);failure=Failure(5,Stopwatch.StartNew(),1000,ref budget);Need(MemberImageWaitMock.Requests.Count==1&&budget==0,"shared-budget-exhausted");count++;
  MemberImageWaitMock.Set(258);budget=25;failure=Failure(5,Stopwatch.StartNew(),0,ref budget);Need(MemberImageWaitMock.Requests.Count==1&&budget==25,"deadline-exhausted");count++;
  MemberImageWaitMock.Set(258,258);budget=25;failure=Failure(5,new Stopwatch(),5,ref budget);Need(MemberImageWaitMock.Requests[1]<=5&&MemberImageWaitMock.Requests[1]>0,"remaining-deadline-clamp");count++;
  MemberImageWaitMock.Set(UInt32.MaxValue);budget=25;failure=Failure(5,Stopwatch.StartNew(),1000,ref budget);Need(MemberImageWaitMock.Requests.Count==1&&failure.Message.Contains("wait:4294967295."),"initial-wait-failed");count++;
  MemberImageWaitMock.Set(128);budget=25;failure=Failure(5,Stopwatch.StartNew(),1000,ref budget);Need(MemberImageWaitMock.Requests.Count==1,"unknown-wait-refuses");count++;
  MemberImageWaitMock.Set(258,UInt32.MaxValue);budget=25;failure=Failure(5,Stopwatch.StartNew(),1000,ref budget);Need(failure.Message.Contains(":4294967295."),"final-wait-failed");count++;
  MemberImageWaitMock.Set();budget=25;failure=Failure(87,Stopwatch.StartNew(),1000,ref budget);Need(failure.NativeErrorCode==87&&MemberImageWaitMock.Requests.Count==0,"non-access-denial-refuses");count++;
  Console.Write("{\"contractCases\":"+count+"}");
 }
}
