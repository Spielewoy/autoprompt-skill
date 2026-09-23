#define _DARWIN_C_SOURCE

#include <bsm/audit.h>
#include <dlfcn.h>
#include <errno.h>
#include <inttypes.h>
#include <libproc.h>
#include <limits.h>
#include <signal.h>
#include <stdbool.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/sysctl.h>
#include <sys/types.h>
#include <unistd.h>

/* Private proc_info flavors have a stable XNU ABI but no public SDK symbols. */
#define AP_PROC_PIDUNIQIDENTIFIERINFO 17
#define AP_PROC_PIDCOALITIONINFO 20
#define AP_COALITION_TYPE_RESOURCE 0
#define AP_MAX_UID_PIDS 65536
#define AP_INITIAL_UID_PIDS 1024

struct ap_proc_uniqidentifierinfo {
    uint8_t executable_uuid[16];
    uint64_t unique_id;
    uint64_t parent_unique_id;
    int32_t pid_version;
    uint32_t reserved2;
    uint64_t reserved3;
    uint64_t reserved4;
};

struct ap_proc_pidcoalitioninfo {
    uint64_t coalition_id[2];
    uint64_t reserved1;
    uint64_t reserved2;
    uint64_t reserved3;
};

struct ap_bound_process {
    pid_t pid;
    uid_t uid;
    int32_t pid_version;
    audit_token_t token;
};

struct ap_member {
    pid_t pid;
    int32_t pid_version;
};

struct ap_attempt {
    pid_t pid;
    int32_t pid_version;
    int signal_result;
    int signal_errno;
};

struct ap_process_error {
    pid_t pid;
    const char *phase;
    int result;
    int error_code;
};

typedef int (*ap_signal_with_audittoken)(audit_token_t *, int);
typedef int (*ap_coalition_info_resource_usage)(uint64_t, void *, size_t);

struct ap_coalition_usage_prefix {
    uint64_t tasks_started;
    uint64_t tasks_exited;
};

_Static_assert(sizeof(struct ap_proc_uniqidentifierinfo) == 56,
               "unexpected unique process info ABI");
_Static_assert(sizeof(struct ap_proc_pidcoalitioninfo) == 40,
               "unexpected coalition info ABI");
_Static_assert(sizeof(audit_token_t) == 32,
               "unexpected audit token ABI");
_Static_assert(sizeof(struct ap_coalition_usage_prefix) == 16,
               "unexpected coalition usage prefix ABI");

static char boot_uuid[37];

static void json_string(const char *value) {
    putchar('"');
    for (const unsigned char *cursor = (const unsigned char *)value;
         *cursor != '\0'; cursor++) {
        unsigned char character = *cursor;
        if (character == '"' || character == '\\') {
            putchar('\\');
            putchar(character);
        } else if (character >= 0x20 && character <= 0x7e) {
            putchar(character);
        } else {
            printf("\\u%04x", character);
        }
    }
    putchar('"');
}

static int emit_error(const char *code, const char *message, int error_code,
                      int exit_code) {
    printf("{\"schemaVersion\":1,\"ok\":false,\"bootUuid\":");
    if (boot_uuid[0] == '\0') {
        printf("null");
    } else {
        json_string(boot_uuid);
    }
    printf(",\"error\":{\"code\":");
    json_string(code);
    printf(",\"message\":");
    json_string(message);
    printf(",\"errno\":%d}}\n", error_code);
    return exit_code;
}

static bool hexadecimal(char character) {
    return (character >= '0' && character <= '9') ||
           (character >= 'a' && character <= 'f') ||
           (character >= 'A' && character <= 'F');
}

static int read_boot_uuid(void) {
    char value[64];
    size_t size = sizeof(value);
    memset(value, 0, sizeof(value));
    errno = 0;
    if (sysctlbyname("kern.bootsessionuuid", value, &size, NULL, 0) != 0) {
        return errno == 0 ? EIO : errno;
    }
    if (size != 37 || value[36] != '\0') {
        return EPROTO;
    }
    for (size_t index = 0; index < 36; index++) {
        bool separator = index == 8 || index == 13 || index == 18 || index == 23;
        if ((separator && value[index] != '-') ||
            (!separator && !hexadecimal(value[index]))) {
            return EPROTO;
        }
    }
    memcpy(boot_uuid, value, sizeof(boot_uuid));
    return 0;
}

static int parse_pid(const char *text, pid_t *pid) {
    if (text[0] == '\0') {
        return EINVAL;
    }
    for (const char *cursor = text; *cursor != '\0'; cursor++) {
        if (*cursor < '0' || *cursor > '9') {
            return EINVAL;
        }
    }
    char *end = NULL;
    errno = 0;
    unsigned long long value = strtoull(text, &end, 10);
    if (errno != 0 || end == text || *end != '\0' || value == 0 ||
        value > INT_MAX) {
        return EINVAL;
    }
    *pid = (pid_t)value;
    return 0;
}

static int parse_coalition(const char *text, uint64_t *coalition) {
    if (text[0] == '\0') {
        return EINVAL;
    }
    for (const char *cursor = text; *cursor != '\0'; cursor++) {
        if (*cursor < '0' || *cursor > '9') {
            return EINVAL;
        }
    }
    char *end = NULL;
    errno = 0;
    unsigned long long value = strtoull(text, &end, 10);
    if (errno != 0 || end == text || *end != '\0' || value == 0) {
        return EINVAL;
    }
    *coalition = (uint64_t)value;
    return 0;
}

static int bind_process(pid_t pid, struct ap_bound_process *bound,
                        int *query_result, int *query_errno) {
    struct ap_proc_uniqidentifierinfo unique;
    memset(&unique, 0, sizeof(unique));
    errno = 0;
    *query_result = proc_pidinfo(pid, AP_PROC_PIDUNIQIDENTIFIERINFO, 0,
                                 &unique, (int)sizeof(unique));
    *query_errno = errno;
    if (*query_result != (int)sizeof(unique)) {
        return -1;
    }

    struct proc_bsdinfo identity;
    memset(&identity, 0, sizeof(identity));
    errno = 0;
    *query_result = proc_pidinfo(pid, PROC_PIDTBSDINFO, 0, &identity,
                                 (int)sizeof(identity));
    *query_errno = errno;
    if (*query_result != (int)sizeof(identity)) {
        return -1;
    }

    memset(bound, 0, sizeof(*bound));
    bound->pid = pid;
    bound->uid = identity.pbi_uid;
    bound->pid_version = unique.pid_version;
    bound->token.val[0] = identity.pbi_uid;
    bound->token.val[1] = identity.pbi_uid;
    bound->token.val[2] = identity.pbi_gid;
    bound->token.val[3] = identity.pbi_ruid;
    bound->token.val[4] = identity.pbi_rgid;
    bound->token.val[5] = (uint32_t)pid;
    bound->token.val[6] = 0;
    bound->token.val[7] = (uint32_t)unique.pid_version;
    return 0;
}

static bool vanished_snapshot(int result, int error_code) {
    // Accept only failed lookups with an explicit disappearance errno, never
    // a positive (possibly truncated) structure result.
    return (result == 0 || result == -1) &&
           (error_code == ESRCH || error_code == ENOENT);
}

static int coalition_info(pid_t pid, uint64_t *resource_coalition,
                          int *query_result, int *query_errno) {
    struct ap_proc_pidcoalitioninfo information;
    memset(&information, 0, sizeof(information));
    errno = 0;
    *query_result = proc_pidinfo(pid, AP_PROC_PIDCOALITIONINFO, 0,
                                 &information, (int)sizeof(information));
    *query_errno = errno;
    if (*query_result != (int)sizeof(information)) {
        return -1;
    }
    *resource_coalition =
        information.coalition_id[AP_COALITION_TYPE_RESOURCE];
    return 0;
}

static bool same_binding(const struct ap_bound_process *left,
                         const struct ap_bound_process *right) {
    return left->pid == right->pid && left->uid == right->uid &&
           left->pid_version == right->pid_version;
}

static int compare_pid(const void *left, const void *right) {
    pid_t a = *(const pid_t *)left;
    pid_t b = *(const pid_t *)right;
    return (a > b) - (a < b);
}

static int list_uid_pids(pid_t **pids, size_t *count, int *list_errno,
                         const char **failure) {
    size_t capacity = AP_INITIAL_UID_PIDS;
    while (capacity <= AP_MAX_UID_PIDS) {
        pid_t *candidate = calloc(capacity, sizeof(*candidate));
        if (candidate == NULL) {
            *list_errno = ENOMEM;
            *failure = "allocation-failed";
            return -1;
        }
        errno = 0;
        int bytes = proc_listpids(PROC_UID_ONLY, (uint32_t)getuid(), candidate,
                                  (int)(capacity * sizeof(*candidate)));
        int saved_errno = errno;
        if (bytes < 0 || bytes % (int)sizeof(*candidate) != 0 ||
            saved_errno != 0) {
            free(candidate);
            *list_errno = saved_errno == 0 ? EIO : saved_errno;
            *failure = "uid-list-query-failed";
            return -1;
        }
        size_t returned = (size_t)bytes / sizeof(*candidate);
        if (returned < capacity) {
            if (returned == 0) {
                free(candidate);
                *list_errno = EPROTO;
                *failure = "uid-list-empty";
                return -1;
            }
            qsort(candidate, returned, sizeof(*candidate), compare_pid);
            size_t unique = 0;
            for (size_t index = 0; index < returned; index++) {
                if (candidate[index] <= 0 ||
                    (unique > 0 && candidate[index] == candidate[unique - 1])) {
                    continue;
                }
                candidate[unique++] = candidate[index];
            }
            if (unique == 0) {
                free(candidate);
                *list_errno = EPROTO;
                *failure = "uid-list-empty";
                return -1;
            }
            *pids = candidate;
            *count = unique;
            *list_errno = 0;
            *failure = NULL;
            return 0;
        }
        free(candidate);
        if (capacity == AP_MAX_UID_PIDS) {
            break;
        }
        capacity *= 2;
        if (capacity > AP_MAX_UID_PIDS) {
            capacity = AP_MAX_UID_PIDS;
        }
    }
    *list_errno = EOVERFLOW;
    *failure = "uid-list-truncated";
    return -1;
}

static int inspect_command(const char *pid_text) {
    pid_t pid = 0;
    if (parse_pid(pid_text, &pid) != 0) {
        return emit_error("ARGUMENT_INVALID", "PID must be a positive decimal integer",
                          EINVAL, 64);
    }
    struct ap_bound_process before;
    int query_result = 0;
    int query_errno = 0;
    if (bind_process(pid, &before, &query_result, &query_errno) != 0) {
        return emit_error("PROCESS_IDENTITY_UNAVAILABLE",
                          "Cannot bind the requested process identity",
                          query_errno, 74);
    }
    uint64_t coalition = 0;
    if (coalition_info(pid, &coalition, &query_result, &query_errno) != 0) {
        return emit_error("COALITION_QUERY_FAILED",
                          "Cannot query the requested process coalition",
                          query_errno, 74);
    }
    struct ap_bound_process after;
    if (bind_process(pid, &after, &query_result, &query_errno) != 0 ||
        !same_binding(&before, &after)) {
        return emit_error("PROCESS_IDENTITY_CHANGED",
                          "Process identity changed during inspection",
                          query_errno == 0 ? ESRCH : query_errno, 74);
    }
    printf("{\"schemaVersion\":1,\"ok\":true,\"bootUuid\":");
    json_string(boot_uuid);
    printf(",\"command\":\"inspect\",\"uid\":%u,\"pid\":%d,"
           "\"pidVersion\":%d,\"resourceCoalitionId\":\"%" PRIu64
           "\"}\n",
           (unsigned int)before.uid, before.pid, before.pid_version, coalition);
    return 0;
}

static void print_members(const struct ap_member *members, size_t count) {
    putchar('[');
    for (size_t index = 0; index < count; index++) {
        printf("%s{\"pid\":%d,\"pidVersion\":%d}", index == 0 ? "" : ",",
               members[index].pid, members[index].pid_version);
    }
    putchar(']');
}

static void print_errors(const struct ap_process_error *errors, size_t count) {
    putchar('[');
    for (size_t index = 0; index < count; index++) {
        printf("%s{\"pid\":%d,\"phase\":", index == 0 ? "" : ",",
               errors[index].pid);
        json_string(errors[index].phase);
        printf(",\"result\":%d,\"errno\":%d}", errors[index].result,
               errors[index].error_code);
    }
    putchar(']');
}

static int census_command(const char *coalition_text) {
    uint64_t target = 0;
    if (parse_coalition(coalition_text, &target) != 0) {
        return emit_error("ARGUMENT_INVALID",
                          "Coalition must be a positive decimal uint64",
                          EINVAL, 64);
    }
    pid_t *pids = NULL;
    size_t count = 0;
    int list_errno = 0;
    const char *list_failure = NULL;
    if (list_uid_pids(&pids, &count, &list_errno, &list_failure) != 0) {
        return emit_error("CENSUS_INCOMPLETE", list_failure, list_errno, 74);
    }
    struct ap_member *members = calloc(count, sizeof(*members));
    struct ap_process_error *errors = calloc(count, sizeof(*errors));
    if (members == NULL || errors == NULL) {
        free(pids);
        free(members);
        free(errors);
        return emit_error("ALLOCATION_FAILED", "Cannot allocate census results",
                          ENOMEM, 70);
    }
    size_t member_count = 0;
    size_t error_count = 0;
    for (size_t index = 0; index < count; index++) {
        struct ap_bound_process before;
        int result = 0;
        int error_code = 0;
        if (bind_process(pids[index], &before, &result, &error_code) != 0) {
            // A UID snapshot can retain a PID after the process exits. It is
            // safe to omit that vanished snapshot member; coalition usage
            // counters remain the authority for proving the group drained.
            if (vanished_snapshot(result, error_code))
                continue;
            errors[error_count++] = (struct ap_process_error){
                pids[index], "bind-before", result, error_code};
            continue;
        }
        uint64_t coalition = 0;
        if (coalition_info(pids[index], &coalition, &result, &error_code) != 0) {
            errors[error_count++] = (struct ap_process_error){
                pids[index], "coalition-query", result, error_code};
            continue;
        }
        struct ap_bound_process after;
        if (bind_process(pids[index], &after, &result, &error_code) != 0) {
            if (vanished_snapshot(result, error_code))
                continue;
            errors[error_count++] = (struct ap_process_error){
                pids[index], "bind-after", result,
                error_code == 0 ? ESRCH : error_code};
            continue;
        }
        if (!same_binding(&before, &after)) {
            errors[error_count++] = (struct ap_process_error){
                pids[index], "bind-after", result, ESRCH};
            continue;
        }
        if (before.uid != getuid()) {
            errors[error_count++] = (struct ap_process_error){
                pids[index], "uid-mismatch", 0, EPERM};
            continue;
        }
        if (coalition == target) {
            members[member_count++] = (struct ap_member){
                before.pid, before.pid_version};
        }
    }
    bool complete = error_count == 0;
    printf("{\"schemaVersion\":1,\"ok\":%s,\"bootUuid\":",
           complete ? "true" : "false");
    json_string(boot_uuid);
    printf(",\"command\":\"census\",\"resourceCoalitionId\":\"%" PRIu64
           "\",\"complete\":%s,\"scanned\":%zu,\"members\":",
           target, complete ? "true" : "false", count);
    print_members(members, member_count);
    printf(",\"errors\":");
    print_errors(errors, error_count);
    printf("}\n");
    free(pids);
    free(members);
    free(errors);
    return complete ? 0 : 74;
}

static void print_attempts(const struct ap_attempt *attempts, size_t count) {
    putchar('[');
    for (size_t index = 0; index < count; index++) {
        printf("%s{\"pid\":%d,\"pidVersion\":%d,\"result\":%d,"
               "\"errno\":%d}",
               index == 0 ? "" : ",", attempts[index].pid,
               attempts[index].pid_version, attempts[index].signal_result,
               attempts[index].signal_errno);
    }
    putchar(']');
}

static int signal_command(const char *coalition_text, const char *signal_text) {
    uint64_t target = 0;
    if (parse_coalition(coalition_text, &target) != 0) {
        return emit_error("ARGUMENT_INVALID",
                          "Coalition must be a positive decimal uint64",
                          EINVAL, 64);
    }
    int signal_number = 0;
    if (strcmp(signal_text, "TERM") == 0) {
        signal_number = SIGTERM;
    } else if (strcmp(signal_text, "KILL") == 0) {
        signal_number = SIGKILL;
    } else {
        return emit_error("ARGUMENT_INVALID", "Signal must be TERM or KILL",
                          EINVAL, 64);
    }
    int query_result = 0;
    int query_errno = 0;
    uint64_t own_coalition = 0;
    if (coalition_info(getpid(), &own_coalition, &query_result,
                       &query_errno) != 0) {
        return emit_error("CONTROLLER_DOMAIN_UNAVAILABLE",
                          "Cannot identify the helper process coalition",
                          query_errno, 74);
    }
    if (own_coalition == target) {
        return emit_error("CONTROLLER_DOMAIN_REFUSED",
                          "Refusing to signal the helper process coalition",
                          EPERM, 77);
    }
    ap_signal_with_audittoken signal_function =
        (ap_signal_with_audittoken)dlsym(RTLD_DEFAULT,
                                         "proc_signal_with_audittoken");
    if (signal_function == NULL) {
        return emit_error("AUDIT_SIGNAL_UNAVAILABLE",
                          "proc_signal_with_audittoken is unavailable",
                          ENOSYS, 69);
    }
    pid_t *pids = NULL;
    size_t count = 0;
    int list_errno = 0;
    const char *list_failure = NULL;
    if (list_uid_pids(&pids, &count, &list_errno, &list_failure) != 0) {
        return emit_error("SIGNAL_SCAN_INCOMPLETE", list_failure, list_errno,
                          74);
    }
    struct ap_attempt *attempts = calloc(count, sizeof(*attempts));
    struct ap_process_error *errors = calloc(count, sizeof(*errors));
    if (attempts == NULL || errors == NULL) {
        free(pids);
        free(attempts);
        free(errors);
        return emit_error("ALLOCATION_FAILED", "Cannot allocate signal results",
                          ENOMEM, 70);
    }
    size_t attempt_count = 0;
    size_t error_count = 0;
    for (size_t index = 0; index < count; index++) {
        if (pids[index] == getpid()) {
            continue;
        }
        struct ap_bound_process bound;
        int result = 0;
        int error_code = 0;
        if (bind_process(pids[index], &bound, &result, &error_code) != 0) {
            // The target may have exited between list_uid_pids and this bind.
            // Do not turn that missing snapshot PID into a false helper-wide
            // failure; live coalition tasks are still audited below.
            if (vanished_snapshot(result, error_code))
                continue;
            errors[error_count++] = (struct ap_process_error){
                pids[index], "bind-before", result, error_code};
            continue;
        }
        uint64_t coalition = 0;
        if (coalition_info(pids[index], &coalition, &result, &error_code) != 0) {
            errors[error_count++] = (struct ap_process_error){
                pids[index], "coalition-query", result, error_code};
            continue;
        }
        if (coalition != target) {
            continue;
        }
        errno = 0;
        int signal_result = signal_function(&bound.token, signal_number);
        int signal_errno = errno;
        attempts[attempt_count++] = (struct ap_attempt){
            bound.pid, bound.pid_version, signal_result, signal_errno};
        if (signal_result != 0) {
            errors[error_count++] = (struct ap_process_error){
                bound.pid, "audit-signal", signal_result,
                signal_result > 0 ? signal_result : signal_errno};
        }
    }
    bool complete = error_count == 0;
    printf("{\"schemaVersion\":1,\"ok\":%s,\"bootUuid\":",
           complete ? "true" : "false");
    json_string(boot_uuid);
    printf(",\"command\":\"signal\",\"resourceCoalitionId\":\"%" PRIu64
           "\",\"signal\":",
           target);
    json_string(signal_text);
    printf(",\"complete\":%s,\"scanned\":%zu,\"attempts\":",
           complete ? "true" : "false", count);
    print_attempts(attempts, attempt_count);
    printf(",\"errors\":");
    print_errors(errors, error_count);
    printf("}\n");
    free(pids);
    free(attempts);
    free(errors);
    return complete ? 0 : 74;
}

static int usage_command(const char *coalition_text) {
    uint64_t target = 0;
    if (parse_coalition(coalition_text, &target) != 0) {
        return emit_error("ARGUMENT_INVALID",
                          "Coalition must be a positive decimal uint64",
                          EINVAL, 64);
    }
    ap_coalition_info_resource_usage usage_function =
        (ap_coalition_info_resource_usage)dlsym(
            RTLD_DEFAULT, "coalition_info_resource_usage");
    if (usage_function == NULL) {
        return emit_error("COALITION_USAGE_UNAVAILABLE",
                          "coalition_info_resource_usage is unavailable",
                          ENOSYS, 69);
    }
    struct ap_coalition_usage_prefix usage;
    memset(&usage, 0, sizeof(usage));
    errno = 0;
    int result = usage_function(target, &usage, sizeof(usage));
    int usage_errno = errno;
    if (result != 0) {
        if (result == -1 && usage_errno == ESRCH) {
            printf("{\"schemaVersion\":1,\"ok\":true,\"bootUuid\":");
            json_string(boot_uuid);
            printf(",\"command\":\"usage\",\"resourceCoalitionId\":\"%"
                   PRIu64 "\",\"exists\":false,\"tasksStarted\":\"0\","
                   "\"tasksExited\":\"0\"}\n",
                   target);
            return 0;
        }
        return emit_error("COALITION_USAGE_FAILED",
                          "Cannot read coalition resource usage",
                          usage_errno == 0 ? EIO : usage_errno, 74);
    }
    if (usage.tasks_exited > usage.tasks_started) {
        return emit_error("COALITION_USAGE_INVALID",
                          "Coalition exit count exceeds start count",
                          EPROTO, 74);
    }
    printf("{\"schemaVersion\":1,\"ok\":true,\"bootUuid\":");
    json_string(boot_uuid);
    printf(",\"command\":\"usage\",\"resourceCoalitionId\":\"%" PRIu64
           "\",\"exists\":true,\"tasksStarted\":\"%" PRIu64
           "\",\"tasksExited\":\"%" PRIu64 "\"}\n",
           target, usage.tasks_started, usage.tasks_exited);
    return 0;
}

int main(int argc, char **argv) {
    int boot_error = read_boot_uuid();
    if (boot_error != 0) {
        return emit_error("BOOT_IDENTITY_UNAVAILABLE",
                          "Cannot read kern.bootsessionuuid", boot_error, 74);
    }
    if (argc == 2 && strcmp(argv[1], "boot") == 0) {
        printf("{\"schemaVersion\":1,\"ok\":true,\"bootUuid\":");
        json_string(boot_uuid);
        printf(",\"command\":\"boot\"}\n");
        return 0;
    }
    if (argc == 3 && strcmp(argv[1], "inspect") == 0) {
        return inspect_command(argv[2]);
    }
    if (argc == 3 && strcmp(argv[1], "census") == 0) {
        return census_command(argv[2]);
    }
    if (argc == 3 && strcmp(argv[1], "usage") == 0) {
        return usage_command(argv[2]);
    }
    if (argc == 4 && strcmp(argv[1], "signal") == 0) {
        return signal_command(argv[2], argv[3]);
    }
    return emit_error("USAGE_INVALID",
                      "Usage: boot | inspect PID | census COALITION | usage COALITION | signal COALITION TERM|KILL",
                      EINVAL, 64);
}
