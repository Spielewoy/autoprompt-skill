// Diagnostic-only probe for an inherited command-substitution stdout handle.
// Build on Windows with: cl /nologo /std:c++17 /EHsc /MT /O2 pipe-write-probe.cpp /link /INCREMENTAL:NO
// argv[1] must be an absolute, private witness path.  The program never writes
// diagnostics to stdout; its only stdout write is the five literal bytes "child".

#define WIN32_LEAN_AND_MEAN
#include <windows.h>

#include <cstdarg>
#include <cstdint>
#include <cstdio>
#include <cstring>

namespace {

using NTSTATUS = LONG;
constexpr NTSTATUS kStatusPending = static_cast<NTSTATUS>(0x00000103L);
constexpr NTSTATUS kStatusInvalidHandle = static_cast<NTSTATUS>(0xC0000008L);
constexpr ULONG kObjectBasicInformation = 0;
constexpr DWORD kProbeWaitMilliseconds = 5000;
constexpr char kChildBytes[] = "child";

// Matches the stable leading layout returned for ObjectBasicInformation on
// supported Windows targets.  Only GrantedAccess is interpreted by this probe.
struct ObjectBasicInformation {
  ULONG Attributes;
  ACCESS_MASK GrantedAccess;
  ULONG HandleCount;
  ULONG PointerCount;
  ULONG PagedPoolUsage;
  ULONG NonPagedPoolUsage;
  ULONG Reserved[3];
  ULONG NameInformationLength;
  ULONG TypeInformationLength;
  ULONG SecurityDescriptorLength;
  LARGE_INTEGER CreateTime;
};

static_assert(sizeof(ObjectBasicInformation) == 56,
              "ObjectBasicInformation must match the Windows 64-bit ABI");

struct IoStatusBlock {
  union {
    NTSTATUS Status;
    PVOID Pointer;
  } u;
  ULONG_PTR Information;
};

using NtQueryObjectFn = NTSTATUS(NTAPI *)(HANDLE, ULONG, PVOID, ULONG, PULONG);
using NtWriteFileFn = NTSTATUS(NTAPI *)(HANDLE, HANDLE, PVOID, PVOID,
                                        IoStatusBlock *, PVOID, ULONG, PVOID,
                                        PULONG);

template <typename Procedure>
Procedure procedure_from_export(FARPROC address) {
  static_assert(sizeof(Procedure) == sizeof(address),
                "Windows function pointers must be representable as FARPROC");
  Procedure procedure = nullptr;
  std::memcpy(&procedure, &address, sizeof(procedure));
  return procedure;
}

HANDLE g_witness = INVALID_HANDLE_VALUE;

bool append_bytes(const char *bytes, DWORD length) {
  while (length != 0) {
    DWORD written = 0;
    if (!WriteFile(g_witness, bytes, length, &written, nullptr) || written == 0)
      return false;
    bytes += written;
    length -= written;
  }
  return FlushFileBuffers(g_witness) != FALSE;
}

void emit_text(const char *text) {
  if (!text)
    return;
  const size_t length = std::strlen(text);
  if (length <= 160)
    (void) append_bytes(text, static_cast<DWORD>(length));
}

void emit_u32(const char *key, ULONG value) {
  char line[96] = {};
  const int length = std::snprintf(line, sizeof(line), "%s=0x%08lX\n", key,
                                   static_cast<unsigned long>(value));
  if (length > 0 && static_cast<size_t>(length) < sizeof(line))
    (void) append_bytes(line, static_cast<DWORD>(length));
}

void emit_u64(const char *key, ULONG_PTR value) {
  char line[112] = {};
  const int length = std::snprintf(line, sizeof(line), "%s=0x%llX\n", key,
                                   static_cast<unsigned long long>(value));
  if (length > 0 && static_cast<size_t>(length) < sizeof(line))
    (void) append_bytes(line, static_cast<DWORD>(length));
}

bool is_absolute_windows_path(const char *path) {
  if (!path || !*path)
    return false;
  // Drive-rooted (C:\... or C:/...) and UNC paths are accepted.  Relative,
  // drive-relative, and POSIX-shaped inputs are deliberately rejected.
  if (((path[0] >= 'A' && path[0] <= 'Z') ||
       (path[0] >= 'a' && path[0] <= 'z')) &&
      path[1] == ':' && (path[2] == '\\' || path[2] == '/'))
    return true;
  return path[0] == '\\' && path[1] == '\\' && path[2] != '\0';
}

[[noreturn]] void exit_after_pending(DWORD code) {
  if (g_witness != INVALID_HANDLE_VALUE)
    (void) FlushFileBuffers(g_witness);
  // The pending I/O still refers to the static child buffer and this active
  // stack frame.  Do not close handles or return through C++ destructors.
  ExitProcess(code);
}

}  // namespace

int main(int argc, char **argv) {
  if (argc != 2 || !is_absolute_windows_path(argv[1]))
    return ERROR_INVALID_PARAMETER;

  char witness_path[MAX_PATH] = {};
  const DWORD full_length = GetFullPathNameA(argv[1], MAX_PATH, witness_path, nullptr);
  if (full_length == 0 || full_length >= MAX_PATH)
    return ERROR_FILENAME_EXCED_RANGE;

  g_witness = CreateFileA(witness_path, GENERIC_WRITE, 0, nullptr, CREATE_NEW,
                          FILE_ATTRIBUTE_NORMAL, nullptr);
  if (g_witness == INVALID_HANDLE_VALUE)
    return static_cast<int>(GetLastError() ? GetLastError() : ERROR_OPEN_FAILED);

  emit_text("probe_version=1\n");
  emit_u32("pid", GetCurrentProcessId());

  SetLastError(ERROR_SUCCESS);
  const HANDLE stdout_handle = GetStdHandle(STD_OUTPUT_HANDLE);
  const DWORD stdout_handle_error = GetLastError();
  emit_u64("stdout_handle", reinterpret_cast<ULONG_PTR>(stdout_handle));
  emit_u32("stdout_handle_error", stdout_handle_error);

  SetLastError(ERROR_SUCCESS);
  const DWORD file_type = GetFileType(stdout_handle);
  const DWORD file_type_error = GetLastError();
  emit_u32("stdout_file_type", file_type);
  emit_u32("stdout_file_type_error", file_type_error);

  HMODULE ntdll = GetModuleHandleW(L"ntdll.dll");
  if (!ntdll)
    ntdll = LoadLibraryW(L"ntdll.dll");
  const auto nt_query_object = ntdll
      ? procedure_from_export<NtQueryObjectFn>(GetProcAddress(ntdll, "NtQueryObject"))
      : nullptr;
  const auto nt_write_file = ntdll
      ? procedure_from_export<NtWriteFileFn>(GetProcAddress(ntdll, "NtWriteFile"))
      : nullptr;
  emit_u32("ntdll_available", ntdll ? 1 : 0);
  emit_u32("ntqueryobject_available", nt_query_object ? 1 : 0);
  emit_u32("ntwritefile_available", nt_write_file ? 1 : 0);

  ObjectBasicInformation basic = {};
  NTSTATUS query_status = kStatusInvalidHandle;
  ULONG query_return_length = 0;
  if (nt_query_object && stdout_handle != nullptr &&
      stdout_handle != INVALID_HANDLE_VALUE)
    query_status = nt_query_object(stdout_handle, kObjectBasicInformation, &basic,
                                   sizeof(basic), &query_return_length);
  emit_u32("stdout_basic_status", static_cast<ULONG>(query_status));
  emit_u32("stdout_basic_return_length", query_return_length);
  const bool basic_valid = query_status == 0 && query_return_length == sizeof(basic);
  emit_u32("stdout_granted_access_valid", basic_valid ? 1 : 0);
  emit_u32("stdout_granted_access", basic_valid ? basic.GrantedAccess : 0);

  SetLastError(ERROR_SUCCESS);
  HANDLE event_handle = CreateEventW(nullptr, FALSE, FALSE, nullptr);
  const DWORD event_error = GetLastError();
  emit_u64("event_handle", reinterpret_cast<ULONG_PTR>(event_handle));
  emit_u32("event_error", event_error);

  IoStatusBlock io = {};
  io.u.Status = static_cast<NTSTATUS>(0xCCCCCCCCL);
  NTSTATUS write_status = kStatusInvalidHandle;
  if (nt_write_file && stdout_handle != nullptr &&
      stdout_handle != INVALID_HANDLE_VALUE) {
    write_status = nt_write_file(stdout_handle,
                                 event_handle == nullptr ? nullptr : event_handle,
                                 nullptr, nullptr, &io,
                                 const_cast<char *>(kChildBytes), 5, nullptr, nullptr);
  }
  emit_u32("ntwrite_immediate_status", static_cast<ULONG>(write_status));
  emit_u32("ntwrite_initial_iosb_status", static_cast<ULONG>(io.u.Status));
  emit_u64("ntwrite_initial_information", io.Information);

  NTSTATUS final_status = write_status;
  if (write_status == kStatusPending) {
    if (!event_handle) {
      emit_text("ntwrite_pending_without_event=1\n");
      exit_after_pending(ERROR_INVALID_HANDLE);
    }
    SetLastError(ERROR_SUCCESS);
    const DWORD wait_result = WaitForSingleObject(event_handle, kProbeWaitMilliseconds);
    const DWORD wait_error = GetLastError();
    emit_u32("ntwrite_wait_result", wait_result);
    emit_u32("ntwrite_wait_error", wait_error);
    if (wait_result != WAIT_OBJECT_0) {
      emit_text("ntwrite_completion=unavailable\n");
      exit_after_pending(wait_result == WAIT_TIMEOUT ? ERROR_TIMEOUT : ERROR_GEN_FAILURE);
    }
    final_status = io.u.Status;
    emit_u32("ntwrite_final_status", static_cast<ULONG>(final_status));
    emit_u64("ntwrite_final_information", io.Information);
  } else {
    emit_u32("ntwrite_final_status", static_cast<ULONG>(write_status));
    emit_u64("ntwrite_final_information", io.Information);
  }

  const bool exact_five_byte_completion = final_status == 0 && io.Information == 5;
  emit_u32("ntwrite_exact_five_byte_completion",
           exact_five_byte_completion ? 1 : 0);
  if (!exact_five_byte_completion) {
    if (event_handle)
      CloseHandle(event_handle);
    (void) FlushFileBuffers(g_witness);
    CloseHandle(g_witness);
    g_witness = INVALID_HANDLE_VALUE;
    return ERROR_WRITE_FAULT;
  }

  // This is deliberately last: an accepted observation contains an explicit
  // end marker which was synchronously flushed to the private witness.
  if (!append_bytes("complete=end\n", 13)) {
    if (event_handle)
      CloseHandle(event_handle);
    CloseHandle(g_witness);
    g_witness = INVALID_HANDLE_VALUE;
    return ERROR_WRITE_FAULT;
  }
  if (event_handle)
    CloseHandle(event_handle);
  CloseHandle(g_witness);
  g_witness = INVALID_HANDLE_VALUE;
  return ERROR_SUCCESS;
}
