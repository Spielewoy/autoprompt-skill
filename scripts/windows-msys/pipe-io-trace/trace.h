#ifndef AUTOPROMPT_PIPE_IO_TRACE_H
#define AUTOPROMPT_PIPE_IO_TRACE_H
// Diagnostic only. Separate counters in the two instrumented translation units
// are excluded from fork copying. No logging API may change the caller's errors.
static volatile LONG autoprompt_pipe_trace_count NO_COPY;
static inline void
 autoprompt_pipe_trace(const char *stage, HANDLE a, HANDLE b, ULONG x, ULONG y)
{
  auto teb = NtCurrentTeb();
  ULONG error = teb->LastErrorValue, status = teb->LastStatusValue;
  if (InterlockedIncrement(&autoprompt_pipe_trace_count) <= 128)
    {
      OBJECT_BASIC_INFORMATION aa = {}, bb = {};
      NTSTATUS as = NtQueryObject(a, ObjectBasicInformation, &aa, sizeof aa, NULL);
      NTSTATUS bs = NtQueryObject(b, ObjectBasicInformation, &bb, sizeof bb, NULL);
      system_printf("APIO p%u t%u %s a%p/%08x/%08x b%p/%08x/%08x x%08x y%08x e%08x s%08x",
                    GetCurrentProcessId(), GetCurrentThreadId(), stage,
                    a, (ULONG)as, (ULONG)aa.GrantedAccess,
                    b, (ULONG)bs, (ULONG)bb.GrantedAccess,
                    x, y, error, status);
    }
  teb->LastErrorValue = error;
  teb->LastStatusValue = status;
}
#endif
