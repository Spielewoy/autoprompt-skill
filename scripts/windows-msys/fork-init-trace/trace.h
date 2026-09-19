#ifndef AUTOPROMPT_DIAGNOSTIC_FORK_TRACE_H
#define AUTOPROMPT_DIAGNOSTIC_FORK_TRACE_H
// Diagnostic variant only. Never compile into or export the candidate runtime.
// Uses no heap, CRT, autoload thunk, global mutable state or standard handles.
namespace autoprompt_fork_trace {
static inline WCHAR ascii_upper(WCHAR c) { return c >= 'a' && c <= 'z' ? c - 32 : c; }
static inline bool key_equal(const WCHAR *p, unsigned n, const char *key, unsigned len) {
  if (n != len) return false;
  for (unsigned i = 0; i < len; ++i) if (ascii_upper(p[i]) != key[i]) return false;
  return true;
}
static inline HANDLE locator(const WCHAR *env, bool &local) {
  const char key[] = "AUTOPROMPT_DIAGNOSTIC_FORK_TRACE_HANDLE";
  const char profile[] = "LOCALAPPDATA";
  ULONG_PTR value = 0; bool seen = false; local = false;
  if (!env) return NULL;
  for (unsigned pos = 0; pos < 32768;) {
    unsigned begin = pos, equal = 32768;
    while (pos < 32768 && env[pos]) { if (env[pos] == '=' && equal == 32768) equal = pos; ++pos; }
    if (pos == 32768) return NULL;
    if (pos == begin) return seen ? (HANDLE)value : NULL;
    if (equal != 32768) {
      if (key_equal(env + begin, equal - begin, profile, sizeof(profile) - 1)) local = pos > equal + 1;
      if (key_equal(env + begin, equal - begin, key, sizeof(key) - 1)) {
        if (seen || pos - equal - 1 != 16) return NULL;
        seen = true;
        for (unsigned i = equal + 1; i < pos; ++i) {
          WCHAR c = ascii_upper(env[i]); unsigned digit;
          if (c >= '0' && c <= '9') digit = c - '0';
          else if (c >= 'A' && c <= 'F') digit = c - 'A' + 10;
          else return NULL;
          value = (value << 4) | digit;
        }
        if (!value || value == (ULONG_PTR)-1) return NULL;
      }
    }
    ++pos;
  }
  return NULL;
}
static inline void emit(unsigned stage) {
  auto teb = NtCurrentTeb();
  ULONG saved_error = teb->LastErrorValue, saved_status = teb->LastStatusValue;
  do {
    if (!teb->Peb || !teb->Peb->ProcessParameters) break;
    bool local = false;
    HANDLE handle = locator((const WCHAR *)teb->Peb->ProcessParameters->Environment, local);
    if (!handle) break;
    OBJECT_BASIC_INFORMATION basic;
    if (NtQueryObject(handle, ObjectBasicInformation, &basic, sizeof(basic), NULL) != 0
        || !(basic.GrantedAccess & FILE_WRITE_DATA)) break;
    IO_STATUS_BLOCK iosb;
    FILE_MODE_INFORMATION mode;
    if (NtQueryInformationFile(handle, &iosb, &mode, sizeof(mode), FileModeInformation) != 0
        || !(mode.Mode & (FILE_SYNCHRONOUS_IO_ALERT | FILE_SYNCHRONOUS_IO_NONALERT))) break;
    FILE_PIPE_LOCAL_INFORMATION pipe;
    if (NtQueryInformationFile(handle, &iosb, &pipe, sizeof(pipe), FilePipeLocalInformation) != 0) break;
    char record[19]; const char digits[] = "0123456789abcdef";
    record[0]='A'; record[1]='T'; record[2]=':';
    ULONG pid = (ULONG)(ULONG_PTR)teb->ClientId.UniqueProcess;
    for (unsigned i=0; i<8; ++i) record[3+i]=digits[(pid >> ((7-i)*4)) & 15];
    record[11]=':';
    for (unsigned i=0; i<4; ++i) record[12+i]=digits[(stage >> ((3-i)*4)) & 15];
    record[16]=':'; record[17]=local?'1':'0'; record[18]='\n';
    // Owned synchronous pipe is drained concurrently by the controller.
    // A pending asynchronous request would retain stack memory, hence mode check.
    NtWriteFile(handle, NULL, NULL, NULL, &iosb, record, sizeof(record), NULL, NULL);
  } while (false);
  teb->LastErrorValue = saved_error; teb->LastStatusValue = saved_status;
}
}
#endif
