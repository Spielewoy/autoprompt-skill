#define _DARWIN_C_SOURCE 1

#include <crt_externs.h>
#include <dlfcn.h>
#include <errno.h>
#include <inttypes.h>
#include <libproc.h>
#include <limits.h>
#include <signal.h>
#include <spawn.h>
#include <stdbool.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/stat.h>
#include <sys/types.h>
#include <sys/wait.h>
#include <unistd.h>

/*
 * PROC_PIDCOALITIONINFO is an Apple-private proc_pidinfo flavor.  Keep its
 * wire definition local to this diagnostic so production never depends on
 * the private SDK surface.  The values mirror XNU's bsd/sys/proc_info.h.
 */
#define AP_PROC_PIDCOALITIONINFO 20
#define AP_PROC_PIDUNIQIDENTIFIERINFO 17
#define AP_COALITION_TYPE_RESOURCE 0
#define AP_COALITION_TYPE_JETSAM 1

#ifndef POSIX_SPAWN_SETSID
#define POSIX_SPAWN_SETSID 0x0400
#endif

struct ap_proc_pidcoalitioninfo {
    uint64_t coalition_id[2];
    uint64_t reserved1;
    uint64_t reserved2;
    uint64_t reserved3;
};

struct ap_proc_uniqidentifierinfo {
    uint8_t executable_uuid[16];
    uint64_t unique_id;
    uint64_t parent_unique_id;
    int32_t pid_version;
    uint32_t reserved2;
    uint64_t reserved3;
    uint64_t reserved4;
};

_Static_assert(sizeof(struct ap_proc_pidcoalitioninfo) == 40,
               "unexpected coalition info wire size");
_Static_assert(sizeof(struct ap_proc_uniqidentifierinfo) == 56,
               "unexpected unique process info wire size");
_Static_assert(sizeof(audit_token_t) == 32,
               "unexpected audit token wire size");

typedef int (*ap_signal_with_audittoken)(audit_token_t *, int);

static volatile sig_atomic_t stop_requested = 0;

static void request_stop(int signo) {
    (void)signo;
    stop_requested = 1;
}

static int coalition_info(pid_t pid, struct ap_proc_pidcoalitioninfo *info,
                          int *saved_errno) {
    memset(info, 0, sizeof(*info));
    errno = 0;
    int result = proc_pidinfo(pid, AP_PROC_PIDCOALITIONINFO, 0, info,
                              (int)sizeof(*info));
    *saved_errno = errno;
    return result;
}

static int bind_process_token(pid_t pid, bool stale_token,
                              audit_token_t *token, int *query_result,
                              int *query_errno) {
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
    int identity_result = proc_pidinfo(
        pid, PROC_PIDTBSDINFO, 0, &identity, (int)sizeof(identity));
    if (identity_result != (int)sizeof(identity)) {
        *query_result = identity_result;
        *query_errno = errno;
        return -1;
    }
    memset(token, 0, sizeof(*token));
    token->val[0] = identity.pbi_uid;
    token->val[1] = identity.pbi_uid;
    token->val[2] = identity.pbi_gid;
    token->val[3] = identity.pbi_ruid;
    token->val[4] = identity.pbi_rgid;
    token->val[5] = (uint32_t)pid;
    token->val[6] = 0;
    token->val[7] = (uint32_t)unique.pid_version + (stale_token ? 1U : 0U);
    return 0;
}

static int signal_bound_token(audit_token_t *token, int signal_number,
                              int *signal_result, int *signal_errno) {
    ap_signal_with_audittoken signal_function =
        (ap_signal_with_audittoken)dlsym(RTLD_DEFAULT,
                                         "proc_signal_with_audittoken");
    if (signal_function == NULL) {
        *signal_result = -1;
        *signal_errno = ENOSYS;
        return -1;
    }
    errno = 0;
    *signal_result = signal_function(token, signal_number);
    *signal_errno = errno;
    return 0;
}

static int signal_with_bound_token(pid_t pid, int signal_number,
                                   bool stale_token, int *query_result,
                                   int *query_errno, int *signal_result,
                                   int *signal_errno) {
    audit_token_t token;
    if (bind_process_token(pid, stale_token, &token, query_result,
                           query_errno) != 0) {
        return -1;
    }
    return signal_bound_token(&token, signal_number, signal_result,
                              signal_errno);
}

static int write_record(const char *directory, const char *role) {
    char final_path[PATH_MAX];
    char temporary_path[PATH_MAX];
    int final_size = snprintf(final_path, sizeof(final_path), "%s/%s.json",
                              directory, role);
    int temporary_size = snprintf(temporary_path, sizeof(temporary_path),
                                  "%s/.%s.%ld.tmp", directory, role,
                                  (long)getpid());
    if (final_size < 0 || temporary_size < 0 ||
        (size_t)final_size >= sizeof(final_path) ||
        (size_t)temporary_size >= sizeof(temporary_path)) {
        errno = ENAMETOOLONG;
        return -1;
    }

    struct ap_proc_pidcoalitioninfo info;
    int query_errno = 0;
    int query_result = coalition_info(getpid(), &info, &query_errno);
    FILE *stream = fopen(temporary_path, "wx");
    if (stream == NULL) {
        return -1;
    }
    int written = fprintf(
        stream,
        "{\"role\":\"%s\",\"pid\":%ld,\"ppid\":%ld,\"pgid\":%ld,"
        "\"sid\":%ld,\"queryResult\":%d,\"queryErrno\":%d,"
        "\"resourceCoalitionId\":\"%" PRIu64 "\","
        "\"jetsamCoalitionId\":\"%" PRIu64 "\"}\n",
        role, (long)getpid(), (long)getppid(), (long)getpgrp(),
        (long)getsid(0), query_result, query_errno,
        info.coalition_id[AP_COALITION_TYPE_RESOURCE],
        info.coalition_id[AP_COALITION_TYPE_JETSAM]);
    int close_result = fclose(stream);
    if (written < 0 || close_result != 0) {
        unlink(temporary_path);
        return -1;
    }
    if (rename(temporary_path, final_path) != 0) {
        unlink(temporary_path);
        return -1;
    }
    return 0;
}

static int hold_process(const char *role, const char *directory) {
    if (write_record(directory, role) != 0) {
        perror("write_record");
        return 70;
    }
    struct sigaction action;
    memset(&action, 0, sizeof(action));
    action.sa_handler = request_stop;
    sigemptyset(&action.sa_mask);
    if (sigaction(SIGTERM, &action, NULL) != 0 ||
        sigaction(SIGINT, &action, NULL) != 0 ||
        sigaction(SIGALRM, &action, NULL) != 0) {
        perror("sigaction");
        return 71;
    }
    alarm(60);
    while (!stop_requested) {
        pause();
    }
    return 0;
}

static int write_foreign_attempt(const char *directory, bool api_available,
                                 int setter_result, int spawn_result,
                                 pid_t spawned_pid) {
    char final_path[PATH_MAX];
    char temporary_path[PATH_MAX];
    int final_size = snprintf(final_path, sizeof(final_path),
                              "%s/foreign-attempt.json", directory);
    int temporary_size = snprintf(temporary_path, sizeof(temporary_path),
                                  "%s/.foreign-attempt.%ld.tmp", directory,
                                  (long)getpid());
    if (final_size < 0 || temporary_size < 0 ||
        (size_t)final_size >= sizeof(final_path) ||
        (size_t)temporary_size >= sizeof(temporary_path)) {
        errno = ENAMETOOLONG;
        return -1;
    }
    FILE *stream = fopen(temporary_path, "wx");
    if (stream == NULL) {
        return -1;
    }
    int written = fprintf(
        stream,
        "{\"apiAvailable\":%s,\"setterResult\":%d,"
        "\"spawnResult\":%d,\"spawnedPid\":%ld}\n",
        api_available ? "true" : "false", setter_result, spawn_result,
        (long)spawned_pid);
    int close_result = fclose(stream);
    if (written < 0 || close_result != 0) {
        unlink(temporary_path);
        return -1;
    }
    if (rename(temporary_path, final_path) != 0) {
        unlink(temporary_path);
        return -1;
    }
    return 0;
}

static int root_process(const char *self, const char *directory,
                        const char *foreign_coalition_string) {
    if (write_record(directory, "root") != 0) {
        perror("write_record root");
        return 72;
    }

    pid_t forked = fork();
    if (forked < 0) {
        perror("fork");
        return 73;
    }
    if (forked == 0) {
        if (setsid() < 0) {
            perror("setsid");
            _exit(74);
        }
        static char *empty_environment[] = {NULL};
        *_NSGetEnviron() = empty_environment;
        execl(self, self, "hold", "fork-setsid-exec", directory,
              (char *)NULL);
        perror("execl");
        _exit(76);
    }

    posix_spawnattr_t attributes;
    int spawn_error = posix_spawnattr_init(&attributes);
    bool attributes_initialized = spawn_error == 0;
    if (spawn_error == 0) {
        spawn_error = posix_spawnattr_setflags(&attributes,
                                               POSIX_SPAWN_SETSID);
    }
    pid_t spawned = -1;
    char *const arguments[] = {(char *)self, "hold",
                               "posix-spawn-setsid", (char *)directory, NULL};
    char *const empty_environment[] = {NULL};
    if (spawn_error == 0) {
        spawn_error = posix_spawn(&spawned, self, NULL, &attributes,
                                  arguments, empty_environment);
    }
    if (attributes_initialized) {
        posix_spawnattr_destroy(&attributes);
    }
    if (spawn_error != 0) {
        errno = spawn_error;
        perror("posix_spawn");
        kill(forked, SIGTERM);
        waitpid(forked, NULL, 0);
        return 77;
    }

    char *end = NULL;
    errno = 0;
    uint64_t foreign_coalition = strtoull(foreign_coalition_string, &end, 10);
    if (errno != 0 || end == foreign_coalition_string || *end != '\0' ||
        foreign_coalition == 0) {
        fprintf(stderr, "invalid foreign coalition id\n");
        kill(forked, SIGTERM);
        kill(spawned, SIGTERM);
        return 79;
    }
    typedef int (*setcoalition_function)(const posix_spawnattr_t *, uint64_t,
                                         int, int);
    setcoalition_function setcoalition =
        (setcoalition_function)dlsym(RTLD_DEFAULT,
                                     "posix_spawnattr_setcoalition_np");
    bool coalition_api_available = setcoalition != NULL;
    int coalition_setter_result = ENOSYS;
    int coalition_spawn_result = ENOSYS;
    pid_t coalition_spawned = -1;
    posix_spawnattr_t coalition_attributes;
    int coalition_init_result = posix_spawnattr_init(&coalition_attributes);
    if (coalition_api_available && coalition_init_result == 0) {
        coalition_setter_result = setcoalition(
            &coalition_attributes, foreign_coalition,
            AP_COALITION_TYPE_RESOURCE, 0);
        if (coalition_setter_result == 0) {
            char *const coalition_arguments[] = {
                (char *)self, "hold", "foreign-coalition-attempt",
                (char *)directory, NULL};
            coalition_spawn_result = posix_spawn(
                &coalition_spawned, self, NULL, &coalition_attributes,
                coalition_arguments, empty_environment);
        }
    } else if (coalition_init_result != 0) {
        coalition_setter_result = coalition_init_result;
    }
    if (coalition_init_result == 0) {
        posix_spawnattr_destroy(&coalition_attributes);
    }
    if (write_foreign_attempt(directory, coalition_api_available,
                              coalition_setter_result,
                              coalition_spawn_result, coalition_spawned) != 0) {
        perror("write_foreign_attempt");
        kill(forked, SIGTERM);
        kill(spawned, SIGTERM);
        if (coalition_spawned > 0) {
            kill(coalition_spawned, SIGTERM);
        }
        return 80;
    }

    struct sigaction action;
    memset(&action, 0, sizeof(action));
    action.sa_handler = request_stop;
    sigemptyset(&action.sa_mask);
    if (sigaction(SIGTERM, &action, NULL) != 0 ||
        sigaction(SIGINT, &action, NULL) != 0 ||
        sigaction(SIGALRM, &action, NULL) != 0) {
        perror("sigaction");
        kill(forked, SIGTERM);
        kill(spawned, SIGTERM);
        if (coalition_spawned > 0) {
            kill(coalition_spawned, SIGTERM);
        }
        return 78;
    }
    alarm(60);
    while (!stop_requested) {
        pause();
    }
    kill(forked, SIGTERM);
    kill(spawned, SIGTERM);
    if (coalition_spawned > 0) {
        kill(coalition_spawned, SIGTERM);
    }
    waitpid(forked, NULL, 0);
    waitpid(spawned, NULL, 0);
    if (coalition_spawned > 0) {
        waitpid(coalition_spawned, NULL, 0);
    }
    return 0;
}

static int inspect_process(const char *pid_string) {
    char *end = NULL;
    errno = 0;
    long parsed = strtol(pid_string, &end, 10);
    if (errno != 0 || end == pid_string || *end != '\0' || parsed <= 0 ||
        parsed > INT_MAX) {
        fprintf(stderr, "invalid pid\n");
        return 64;
    }
    struct ap_proc_pidcoalitioninfo info;
    int query_errno = 0;
    int result = coalition_info((pid_t)parsed, &info, &query_errno);
    printf(
        "{\"pid\":%ld,\"queryResult\":%d,\"queryErrno\":%d,"
        "\"resourceCoalitionId\":\"%" PRIu64 "\","
        "\"jetsamCoalitionId\":\"%" PRIu64 "\"}\n",
        parsed, result, query_errno,
        info.coalition_id[AP_COALITION_TYPE_RESOURCE],
        info.coalition_id[AP_COALITION_TYPE_JETSAM]);
    return result == (int)sizeof(info) ? 0 : 1;
}

static int census_processes(const char *coalition_string) {
    char *end = NULL;
    errno = 0;
    uint64_t target = strtoull(coalition_string, &end, 10);
    if (errno != 0 || end == coalition_string || *end != '\0' || target == 0) {
        fprintf(stderr, "invalid coalition id\n");
        return 64;
    }

    const int capacity = 65536;
    pid_t *pids = calloc((size_t)capacity, sizeof(*pids));
    if (pids == NULL) {
        perror("calloc");
        return 70;
    }
    errno = 0;
    int bytes = proc_listpids(PROC_UID_ONLY, (uint32_t)getuid(), pids,
                              capacity * (int)sizeof(*pids));
    int list_errno = errno;
    if (bytes < 0 || bytes % (int)sizeof(*pids) != 0) {
        printf("{\"listResult\":%d,\"listErrno\":%d}\n", bytes,
               list_errno);
        free(pids);
        return 1;
    }

    int count = bytes / (int)sizeof(*pids);
    bool complete = list_errno == 0 && count > 0 && count < capacity;
    int queried = 0;
    int denied = 0;
    int vanished = 0;
    int other_errors = 0;
    bool first = true;
    printf("{\"listResult\":%d,\"listErrno\":%d,\"capacity\":%d,"
           "\"complete\":%s,\"matchingPids\":[",
           bytes, list_errno, capacity, complete ? "true" : "false");
    int bounded_count = count < capacity ? count : capacity;
    for (int index = 0; index < bounded_count; index++) {
        if (pids[index] <= 0) {
            continue;
        }
        struct ap_proc_pidcoalitioninfo info;
        int query_errno = 0;
        int result = coalition_info(pids[index], &info, &query_errno);
        if (result == (int)sizeof(info)) {
            queried++;
            if (info.coalition_id[AP_COALITION_TYPE_RESOURCE] == target) {
                printf("%s%d", first ? "" : ",", pids[index]);
                first = false;
            }
        } else if (query_errno == EPERM || query_errno == EACCES) {
            denied++;
        } else if (query_errno == ESRCH) {
            vanished++;
        } else {
            other_errors++;
        }
    }
    printf("],\"sameUidCandidates\":%d,\"queried\":%d,"
           "\"denied\":%d,\"vanished\":%d,\"otherErrors\":%d}\n",
           bounded_count, queried, denied, vanished, other_errors);
    free(pids);
    return 0;
}

static int parse_positive_pid(const char *value, pid_t *pid) {
    char *end = NULL;
    errno = 0;
    long parsed = strtol(value, &end, 10);
    if (errno != 0 || end == value || *end != '\0' || parsed <= 0 ||
        parsed > INT_MAX) {
        return -1;
    }
    *pid = (pid_t)parsed;
    return 0;
}

static int audit_signal_process(const char *pid_string,
                                const char *signal_string,
                                const char *stale_string) {
    pid_t pid = 0;
    if (parse_positive_pid(pid_string, &pid) != 0) {
        fprintf(stderr, "invalid audit-signal arguments\n");
        return 64;
    }
    char *end = NULL;
    errno = 0;
    long parsed_signal = strtol(signal_string, &end, 10);
    int signal_parse_errno = errno;
    if (signal_parse_errno != 0 || end == signal_string || *end != '\0' ||
        parsed_signal < 0 ||
        parsed_signal >= NSIG ||
        (strcmp(stale_string, "fresh") != 0 &&
         strcmp(stale_string, "stale") != 0)) {
        fprintf(stderr, "invalid audit-signal arguments\n");
        return 64;
    }
    int query_result = -1;
    int query_errno = 0;
    int signal_result = -1;
    int signal_errno = 0;
    signal_with_bound_token(pid, (int)parsed_signal,
                            strcmp(stale_string, "stale") == 0,
                            &query_result, &query_errno,
                            &signal_result, &signal_errno);
    printf("{\"pid\":%ld,\"signal\":%ld,\"stale\":%s,"
           "\"queryResult\":%d,\"queryErrno\":%d,"
           "\"signalResult\":%d,\"signalErrno\":%d}\n",
           (long)pid, parsed_signal,
           strcmp(stale_string, "stale") == 0 ? "true" : "false",
           query_result, query_errno, signal_result, signal_errno);
    return 0;
}

static int drain_coalition(const char *coalition_string) {
    char *end = NULL;
    errno = 0;
    uint64_t target = strtoull(coalition_string, &end, 10);
    if (errno != 0 || end == coalition_string || *end != '\0' || target == 0) {
        fprintf(stderr, "invalid coalition id\n");
        return 64;
    }
    const int capacity = 65536;
    pid_t *pids = calloc((size_t)capacity, sizeof(*pids));
    if (pids == NULL) {
        perror("calloc");
        return 70;
    }
    errno = 0;
    int bytes = proc_listpids(PROC_UID_ONLY, (uint32_t)getuid(), pids,
                              capacity * (int)sizeof(*pids));
    int list_errno = errno;
    if (bytes < 0 || bytes % (int)sizeof(*pids) != 0) {
        printf("{\"listResult\":%d,\"listErrno\":%d}\n", bytes,
               list_errno);
        free(pids);
        return 0;
    }
    int count = bytes / (int)sizeof(*pids);
    int bounded_count = count < capacity ? count : capacity;
    bool complete = list_errno == 0 && count > 0 && count < capacity;
    bool first = true;
    int matched = 0;
    printf("{\"listResult\":%d,\"listErrno\":%d,\"complete\":%s,"
           "\"attempts\":[",
           bytes, list_errno, complete ? "true" : "false");
    for (int index = 0; index < bounded_count; index++) {
        if (pids[index] <= 0 || pids[index] == getpid()) {
            continue;
        }
        int query_result = -1;
        int query_errno = 0;
        audit_token_t token;
        if (bind_process_token(pids[index], false, &token, &query_result,
                               &query_errno) != 0) {
            continue;
        }
        struct ap_proc_pidcoalitioninfo coalition;
        int coalition_errno = 0;
        int coalition_result = coalition_info(
            pids[index], &coalition, &coalition_errno);
        if (coalition_result != (int)sizeof(coalition) ||
            coalition.coalition_id[AP_COALITION_TYPE_RESOURCE] != target) {
            continue;
        }
        matched++;
        int signal_result = -1;
        int signal_errno = 0;
        signal_bound_token(&token, SIGKILL, &signal_result, &signal_errno);
        printf("%s{\"pid\":%d,\"coalitionResult\":%d,"
               "\"coalitionErrno\":%d,\"queryResult\":%d,"
               "\"queryErrno\":%d,\"signalResult\":%d,"
               "\"signalErrno\":%d}",
               first ? "" : ",", pids[index], coalition_result,
               coalition_errno, query_result, query_errno,
               signal_result, signal_errno);
        first = false;
    }
    printf("],\"matched\":%d}\n", matched);
    free(pids);
    return 0;
}

int main(int argc, char **argv) {
    if (argc == 4 && strcmp(argv[1], "root") == 0) {
        return root_process(argv[0], argv[2], argv[3]);
    }
    if (argc == 4 && strcmp(argv[1], "hold") == 0) {
        return hold_process(argv[2], argv[3]);
    }
    if (argc == 3 && strcmp(argv[1], "inspect") == 0) {
        return inspect_process(argv[2]);
    }
    if (argc == 3 && strcmp(argv[1], "census") == 0) {
        return census_processes(argv[2]);
    }
    if (argc == 5 && strcmp(argv[1], "audit-signal") == 0) {
        return audit_signal_process(argv[2], argv[3], argv[4]);
    }
    if (argc == 3 && strcmp(argv[1], "drain") == 0) {
        return drain_coalition(argv[2]);
    }
    fprintf(stderr,
            "usage: %s root STATE_DIR FOREIGN_COALITION_ID | hold ROLE "
            "STATE_DIR | inspect PID | census RESOURCE_COALITION_ID | "
            "audit-signal PID SIGNAL fresh|stale | "
            "drain RESOURCE_COALITION_ID\n",
            argv[0]);
    return 64;
}
