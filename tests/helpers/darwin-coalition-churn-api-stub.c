/* Test only: execute the packaged helper's actual census/signal control flow with
 * deterministic kernel-query outcomes. The separately built candidate uses
 * the real SDK and kernel; these injected results cannot certify ownership. */
#define _DARWIN_C_SOURCE
#include <stdint.h>
#include <sys/types.h>
#include <libproc.h>
#include <dlfcn.h>
#include <sys/sysctl.h>
static int ap_test_pidinfo(int, int, uint64_t, void *, int);
static int ap_test_listpids(uint32_t, uint32_t, void *, int);
static void *ap_test_dlsym(void *, const char *);
static int ap_test_sysctlbyname(const char *, void *, size_t *, void *, size_t);
#define proc_pidinfo ap_test_pidinfo
#define proc_listpids ap_test_listpids
#define dlsym ap_test_dlsym
#define sysctlbyname ap_test_sysctlbyname
#define main ap_candidate_main
#include "../../agents/codex/workflow/darwin-coalition-helper.c"
#undef main

static const pid_t transient_pid = 42420, held_pid = 42421;
static const char *scenario;
static int transient_binds;
static int missing_result;
static int missing_errno;
static int ap_test_sysctlbyname(const char *name, void *old, size_t *oldlen,
                                void *new_value, size_t newlen) {
    (void)name; (void)old; (void)oldlen; (void)new_value; (void)newlen;
    errno = ENOENT; return -1;
}
static int ap_test_listpids(uint32_t type, uint32_t uid, void *buffer, int size) {
    (void)type; (void)uid;
    if (size < (int)(2 * sizeof(pid_t))) { errno = EINVAL; return -1; }
    pid_t values[] = { transient_pid, held_pid };
    memcpy(buffer, values, sizeof(values)); errno = 0; return (int)sizeof(values);
}
static int ap_test_pidinfo(int pid, int flavor, uint64_t arg, void *buffer, int size) {
    (void)arg; (void)size; errno = 0;
    if (flavor == AP_PROC_PIDUNIQIDENTIFIERINFO) {
        if (pid == transient_pid) {
            transient_binds++;
            if ((!strcmp(scenario, "before") && transient_binds == 1) ||
                (!strcmp(scenario, "after") && transient_binds == 2)) {
                errno = missing_errno; return missing_result;
            }
        }
        struct ap_proc_uniqidentifierinfo value = {0}; value.pid_version = 9;
        if (pid == transient_pid && !strcmp(scenario, "identity") && transient_binds == 2) value.pid_version = 10;
        memcpy(buffer, &value, sizeof(value)); return (int)sizeof(value);
    }
    if (flavor == PROC_PIDTBSDINFO) {
        struct proc_bsdinfo value = {0}; value.pbi_uid = getuid(); value.pbi_ruid = getuid();
        value.pbi_gid = getgid(); value.pbi_rgid = getgid();
        if (pid == transient_pid && !strcmp(scenario, "uid")) value.pbi_uid++;
        memcpy(buffer, &value, sizeof(value)); return (int)sizeof(value);
    }
    if (flavor == AP_PROC_PIDCOALITIONINFO) {
        if (pid == transient_pid && !strcmp(scenario, "coalition")) { errno = missing_errno; return missing_result; }
        struct ap_proc_pidcoalitioninfo value = {0};
        value.coalition_id[0] = pid == getpid() ? 456 : 123;
        memcpy(buffer, &value, sizeof(value)); return (int)sizeof(value);
    }
    errno = EINVAL; return 0;
}
static int ap_test_signal(audit_token_t *token, int number) {
    (void)number;
    if ((pid_t)token->val[5] == transient_pid && !strcmp(scenario, "audit")) { errno = missing_errno; return -1; }
    errno = 0; return 0;
}
static void *ap_test_dlsym(void *handle, const char *name) {
    (void)handle;
    return !strcmp(name, "proc_signal_with_audittoken") ? (void *)ap_test_signal : NULL;
}
int main(int argc, char **argv) {
    if (argc != 5) return 64;
    scenario = argv[2]; missing_result = atoi(argv[3]); missing_errno = atoi(argv[4]);
    memcpy(boot_uuid, "12345678-1234-1234-1234-123456789abc", sizeof(boot_uuid));
    if (!strcmp(argv[1], "census")) return census_command("123");
    if (!strcmp(argv[1], "signal")) return signal_command("123", "TERM");
    return 64;
}
