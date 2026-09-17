#include <cstdint>
#include <cstdio>
#include <cstdlib>
#include <cstddef>
#include <initializer_list>
using DWORD = uint32_t;
using BOOL = int;
constexpr BOOL FALSE = 0, TRUE = 1;
struct SECURITY_ATTRIBUTES { DWORD marker; };
using LPSECURITY_ATTRIBUTES = SECURITY_ATTRIBUTES *;
static DWORD last_error, prepare_error, native_error = 5, current_package;
static bool container, native_success;
static int prepared, destroyed, native_calls, live;
static LPSECURITY_ATTRIBUTES expected_source;
static SECURITY_ATTRIBUTES owned;
static DWORD GetLastError () { return last_error; }
static void SetLastError (DWORD value) { last_error = value; }
static void require (bool value) { if (!value) std::abort (); }
class appcontainer_pipe_security {
  LPSECURITY_ATTRIBUTES result_ = nullptr;
public:
  appcontainer_pipe_security () { ++live; }
  ~appcontainer_pipe_security () { --live; ++destroyed; SetLastError (9999); }
  DWORD prepare (LPSECURITY_ATTRIBUTES source) {
    ++prepared; require (source == expected_source);
    if (prepare_error) return prepare_error;
    owned.marker = current_package;
    result_ = container ? &owned : source;
    return 0;
  }
  LPSECURITY_ATTRIBUTES get () const { return result_; }
};
/* EXACT_ADAPTER */

static wchar_t image[] = L"child.exe", command[] = L"child.exe input";
static wchar_t *forking_progname = image, *runpath = image, *wcmd = command;
static void *envblock = &native_calls;
static DWORD c_flags = 0x123456;
static int si, pi;
static wchar_t *GetCommandLineW () { return command; }
static struct { wchar_t *wcs (wchar_t *buffer) { require (buffer == command); return buffer; } } cmd;
static bool fork_call;
static BOOL CreateProcessW (wchar_t *image_arg, wchar_t *command_arg,
                            LPSECURITY_ATTRIBUTES process, LPSECURITY_ATTRIBUTES thread,
                            BOOL inherit, DWORD flags, void *environment,
                            void *cwd, int *startup, int *process_info) {
  ++native_calls;
  require (live == 1 && process == thread);
  require (process == (container ? &owned : expected_source));
  if (container) require (process->marker == current_package);
  require (image_arg == image && command_arg == command && inherit == TRUE);
  require (flags == c_flags && cwd == nullptr && startup == &si && process_info == &pi);
  require (environment == (fork_call ? nullptr : envblock));
  SetLastError (native_error);
  return native_success;
}
static BOOL fork_create (LPSECURITY_ATTRIBUTES sa) {
  BOOL rc;
  /* EXACT_FORK_CALL */
  return rc;
}
static BOOL spawn_create (LPSECURITY_ATTRIBUTES sa) {
  BOOL rc;
  /* EXACT_SPAWN_CALL */
  return rc;
}
int main () {
  SECURITY_ATTRIBUTES source { 0xabc };
  int cases = 0;
  // Every exact callsite exercises host pointer identity (including NULL),
  // private adaptation, native success/failure, and failure before creation.
  for (bool is_fork : {false, true}) {
    fork_call = is_fork;
    for (bool is_container : {false, true}) {
      container = is_container;
      for (auto original : {&source, static_cast<LPSECURITY_ATTRIBUTES> (nullptr)}) {
        expected_source = original;
        for (bool succeeds : {false, true}) {
          native_success = succeeds; prepare_error = 0;
          native_error = succeeds ? 4321 : 5;
          ++current_package; prepared = destroyed = native_calls = live = 0;
          BOOL result = is_fork ? fork_create (original) : spawn_create (original);
          require (result == succeeds && GetLastError () == native_error);
          require (prepared == 1 && destroyed == 1 && native_calls == 1 && live == 0);
          require (source.marker == 0xabc); ++cases;
        }
        for (DWORD error : {DWORD (5), DWORD (8), DWORD (1338)}) {
          prepare_error = error; prepared = destroyed = native_calls = live = 0;
          BOOL result = is_fork ? fork_create (original) : spawn_create (original);
          require (!result && GetLastError () == error);
          require (prepared == 1 && destroyed == 1 && native_calls == 0 && live == 0);
          require (source.marker == 0xabc); ++cases;
        }
      }
    }
  }
  std::printf ("Child creation: %d exact-source contract cases passed.\n", cases);
}
