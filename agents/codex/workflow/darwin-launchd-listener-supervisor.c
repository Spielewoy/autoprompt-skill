#define _DARWIN_C_SOURCE
#include <arpa/inet.h>
#include <errno.h>
#include <fcntl.h>
#include <inttypes.h>
#include <launch.h>
#include <libproc.h>
#include <limits.h>
#include <netinet/in.h>
#include <spawn.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/socket.h>
#include <sys/stat.h>
#include <sys/wait.h>
#include <unistd.h>

static const char *MODEL_SOCKET = "autoprompt.model";
static const char *MCP_SOCKET = "autoprompt.mcp";

#define AP_PROC_PIDUNIQIDENTIFIERINFO 17
#define AP_PROC_PIDCOALITIONINFO 20
#define AP_COALITION_TYPE_RESOURCE 0
#ifndef RENAME_EXCL
#define RENAME_EXCL 0x00000004
#endif

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

_Static_assert(sizeof(struct ap_proc_uniqidentifierinfo) == 56,
               "unexpected unique process info ABI");
_Static_assert(sizeof(struct ap_proc_pidcoalitioninfo) == 40,
               "unexpected coalition info ABI");

static int parse_port(const char *text, in_port_t *port) {
  char *end = NULL;
  errno = 0;
  unsigned long value = strtoul(text, &end, 10);
  if (errno || !text[0] || !end || *end || value < 1 || value > 65535) return -1;
  *port = htons((in_port_t)value);
  return 0;
}

static int acquire(const char *name, in_port_t expected, int *result) {
  int *descriptors = NULL;
  size_t count = 0;
  int activated = launch_activate_socket(name, &descriptors, &count);
  if (activated != 0 || !descriptors || count != 1) {
    if (!activated && descriptors) for (size_t index = 0; index < count; index++) close(descriptors[index]);
    free(descriptors);
    return 70;
  }
  int descriptor = descriptors[0];
  free(descriptors);
  struct sockaddr_in6 address;
  socklen_t address_length = sizeof(address);
  int type = -1, v6only = -1, reuseport = -1;
  socklen_t option_length = sizeof(int);
  if (getsockname(descriptor, (struct sockaddr *)&address, &address_length) != 0 ||
      address_length != sizeof(address) || address.sin6_family != AF_INET6 ||
      address.sin6_port != expected ||
      memcmp(&address.sin6_addr, &in6addr_loopback, sizeof(in6addr_loopback)) != 0 ||
      getsockopt(descriptor, SOL_SOCKET, SO_TYPE, &type, &option_length) != 0 || type != SOCK_STREAM) {
    close(descriptor);
    return 71;
  }
  option_length = sizeof(int);
  if (getsockopt(descriptor, IPPROTO_IPV6, IPV6_V6ONLY, &v6only, &option_length) != 0 || v6only != 1) {
    close(descriptor);
    return 73;
  }
  option_length = sizeof(int);
  if (getsockopt(descriptor, SOL_SOCKET, SO_REUSEPORT, &reuseport, &option_length) != 0 || reuseport != 0) {
    close(descriptor);
    return 74;
  }
  // Darwin exposes SO_ACCEPTCONN as an internal socket option bit, but does
  // not implement it in sogetoptlock(). Idempotent listen() establishes the
  // listening state of this already-bound, authenticated launchd socket.
  if (listen(descriptor, SOMAXCONN) != 0) {
    close(descriptor);
    return 72;
  }
  *result = descriptor;
  return 0;
}

static int publish_descriptors(int model, int mcp) {
  if (model == mcp) return 75;
  int model_copy = fcntl(model, F_DUPFD_CLOEXEC, 5);
  int mcp_copy = fcntl(mcp, F_DUPFD_CLOEXEC, 5);
  if (model_copy < 0 || mcp_copy < 0) {
    if (model_copy >= 0) close(model_copy);
    if (mcp_copy >= 0) close(mcp_copy);
    return 76;
  }
  close(model);
  close(mcp);
  if (dup2(model_copy, 3) != 3 || dup2(mcp_copy, 4) != 4 ||
      fcntl(3, F_SETFD, 0) != 0 || fcntl(4, F_SETFD, 0) != 0) {
    close(model_copy);
    close(mcp_copy);
    close(3);
    close(4);
    return 77;
  }
  close(model_copy);
  close(mcp_copy);
  return 0;
}

static int write_all(int descriptor, const char *bytes, size_t length) {
  while (length) {
    ssize_t written = write(descriptor, bytes, length);
    if (written < 0) { if (errno == EINTR) continue; return -1; }
    if (written == 0) return -1;
    bytes += written;
    length -= (size_t)written;
  }
  return 0;
}

/* Publish the launchd generation before acquiring a listener or consulting
 * the started marker. A truncated record deliberately remains durable and is
 * UNKNOWN to recovery; this function never unlinks or repairs evidence. */
static int publish_generation(const char *directory, const char *request_hash) {
  char canonical[PATH_MAX];
  if (!realpath(directory, canonical) || strcmp(canonical, directory) != 0) return 86;
  struct stat named;
  if (lstat(directory, &named) || !S_ISDIR(named.st_mode) || named.st_uid != geteuid() ||
      (named.st_mode & 077) != 0) return 86;
  int directory_fd = open(directory, O_RDONLY | O_DIRECTORY | O_NOFOLLOW);
  if (directory_fd < 0) return 86;
  struct stat opened;
  if (fstat(directory_fd, &opened) || opened.st_dev != named.st_dev || opened.st_ino != named.st_ino ||
      !S_ISDIR(opened.st_mode) || opened.st_uid != geteuid() || (opened.st_mode & 077) != 0) {
    close(directory_fd);
    return 86;
  }
  struct ap_proc_uniqidentifierinfo unique;
  struct ap_proc_pidcoalitioninfo coalitions;
  memset(&unique, 0, sizeof(unique));
  memset(&coalitions, 0, sizeof(coalitions));
  pid_t pid = getpid();
  if (proc_pidinfo(pid, AP_PROC_PIDUNIQIDENTIFIERINFO, 0, &unique, (int)sizeof(unique)) != (int)sizeof(unique) ||
      proc_pidinfo(pid, AP_PROC_PIDCOALITIONINFO, 0, &coalitions, (int)sizeof(coalitions)) != (int)sizeof(coalitions) ||
      coalitions.coalition_id[AP_COALITION_TYPE_RESOURCE] == 0) {
    close(directory_fd);
    return 87;
  }
  char name[96], temporary[104];
  int name_length = snprintf(name, sizeof(name), "generation-%ld-%" PRId32 ".json", (long)pid, unique.pid_version);
  int temporary_length = snprintf(temporary, sizeof(temporary), ".%s.tmp", name);
  if (name_length < 1 || (size_t)name_length >= sizeof(name) || temporary_length < 1 ||
      (size_t)temporary_length >= sizeof(temporary)) { close(directory_fd); return 88; }
  int record_fd = openat(directory_fd, temporary, O_WRONLY | O_CREAT | O_EXCL | O_NOFOLLOW, 0600);
  if (record_fd < 0) { close(directory_fd); return 88; }
  struct stat record;
  int status = 0;
  if (fstat(record_fd, &record) || !S_ISREG(record.st_mode) || record.st_nlink != 1 ||
      record.st_uid != geteuid() || (record.st_mode & 077) != 0) status = 89;
  char value[512];
  int value_length = snprintf(value, sizeof(value),
      "{\"schemaVersion\":1,\"requestSha256\":\"%s\",\"pid\":%ld,\"uid\":%u,"
      "\"pidVersion\":%" PRId32 ",\"resourceCoalitionId\":\"%" PRIu64 "\"}\n",
      request_hash, (long)pid, (unsigned int)geteuid(), unique.pid_version,
      coalitions.coalition_id[AP_COALITION_TYPE_RESOURCE]);
  if (!status && (value_length < 1 || (size_t)value_length >= sizeof(value) ||
      write_all(record_fd, value, (size_t)value_length) != 0 || fsync(record_fd) != 0)) status = 89;
  if (close(record_fd) != 0) status = 89;
  if (!status && renameatx_np(directory_fd, temporary, directory_fd, name, RENAME_EXCL) != 0) status = 89;
  if (fsync(directory_fd) != 0) status = 89;
  if (close(directory_fd) != 0) status = 89;
  return status;
}

/* The marker is deliberately request-bound and published before spawn. A later
 * demand activation may retain launchd's sockets, but can never execute another
 * child for this reservation. */
static int started_marker(const char *marker, const char *request_hash, int *first) {
  char expected[80];
  int expected_length = snprintf(expected, sizeof(expected), "v1\n%s\n", request_hash);
  if (expected_length != 68) return 80;
  int descriptor = open(marker, O_WRONLY | O_CREAT | O_EXCL | O_NOFOLLOW, 0600);
  if (descriptor >= 0) {
    struct stat created;
    if (fstat(descriptor, &created) || !S_ISREG(created.st_mode) || created.st_nlink != 1) {
      close(descriptor);
      unlink(marker);
      return 81;
    }
    int failed = write_all(descriptor, expected, (size_t)expected_length) != 0;
    if (!failed && fsync(descriptor) != 0) failed = 1;
    if (close(descriptor) != 0) failed = 1;
    if (failed) { unlink(marker); return 81; }
    *first = 1;
    return 0;
  }
  if (errno != EEXIST) return 82;
  struct stat named;
  if (lstat(marker, &named) || !S_ISREG(named.st_mode) || named.st_nlink != 1) return 83;
  descriptor = open(marker, O_RDONLY | O_NOFOLLOW);
  if (descriptor < 0) return 83;
  struct stat opened;
  if (fstat(descriptor, &opened) || opened.st_dev != named.st_dev || opened.st_ino != named.st_ino) {
    close(descriptor);
    return 83;
  }
  char actual[80];
  ssize_t count;
  do { count = read(descriptor, actual, sizeof(actual)); } while (count < 0 && errno == EINTR);
  int close_status = close(descriptor);
  if (count != expected_length || close_status || memcmp(actual, expected, (size_t)expected_length) != 0) return 84;
  *first = 0;
  return 0;
}

static int spawn_with_listeners(char *const child_argv[], pid_t *child) {
  posix_spawnattr_t attributes;
  posix_spawn_file_actions_t actions;
  int status = posix_spawnattr_init(&attributes);
  if (status) return status;
  status = posix_spawn_file_actions_init(&actions);
  if (status) { posix_spawnattr_destroy(&attributes); return status; }
  // Keep only standard I/O and the two admitted listeners in the child. The
  // supervisor retains its own descriptors and stays launchd's stable root.
  status = posix_spawnattr_setflags(&attributes, POSIX_SPAWN_CLOEXEC_DEFAULT);
  for (int descriptor = 0; !status && descriptor < 5; descriptor++)
    status = posix_spawn_file_actions_addinherit_np(&actions, descriptor);
  if (!status) {
    extern char **environ;
    status = posix_spawn(child, child_argv[0], &actions, &attributes, child_argv, environ);
  }
  posix_spawn_file_actions_destroy(&actions);
  posix_spawnattr_destroy(&attributes);
  return status;
}

static void hold_until_bootout(void) {
  for (;;) pause();
}

int main(int argc, char **argv) {
  if (argc != 9 || argv[3][0] != '/' || argv[4][0] != '/' || argv[5][0] != '/' || argv[6][0] != '/' || argv[8][0] != '/' ||
      strlen(argv[7]) != 64 || strspn(argv[7], "0123456789abcdef") != 64) return 64;
  in_port_t model_port, mcp_port;
  if (parse_port(argv[1], &model_port) || parse_port(argv[2], &mcp_port) || model_port == mcp_port) return 65;
  struct stat node_status, script_status, request_status;
  if (lstat(argv[3], &node_status) || !S_ISREG(node_status.st_mode) || access(argv[3], X_OK) != 0 ||
      lstat(argv[4], &script_status) || !S_ISREG(script_status.st_mode) ||
      lstat(argv[5], &request_status) || !S_ISREG(request_status.st_mode)) return 66;
  int status = publish_generation(argv[8], argv[7]);
  if (status) {
    fprintf(stderr, "listener generation refused: %d\n", status);
    return status;
  }
  int model = -1, mcp = -1;
  status = acquire(MODEL_SOCKET, model_port, &model);
  if (!status) status = acquire(MCP_SOCKET, mcp_port, &mcp);
  if (!status) status = publish_descriptors(model, mcp);
  else if (model >= 0) close(model);
  if (status) {
    if (mcp >= 0) close(mcp);
    fprintf(stderr, "listener handoff refused: %d\n", status);
    return status;
  }
  int first = 0;
  status = started_marker(argv[6], argv[7], &first);
  if (status) {
    fprintf(stderr, "listener marker refused: %d\n", status);
    return status;
  }
  if (!first) {
    fprintf(stdout, "GUARD_PID:%ld\n", (long)getpid());
    fflush(stdout);
    hold_until_bootout();
  }
  char *const child_argv[] = { argv[3], argv[4], (char *)"--job", argv[5], NULL };
  pid_t child = -1;
  int spawn_status = spawn_with_listeners(child_argv, &child);
  if (spawn_status) {
    fprintf(stderr, "listener handoff spawn failed: %d\n", spawn_status);
    return 78;
  }
  int wait_status;
  while (waitpid(child, &wait_status, 0) < 0) if (errno != EINTR) return 85;
  fprintf(stdout, "CHILD_REAPED:%ld\n", (long)child);
  fflush(stdout);
  hold_until_bootout();
}
