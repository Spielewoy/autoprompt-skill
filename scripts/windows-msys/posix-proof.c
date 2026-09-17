/* Standalone syscall proof, to be compiled by the pinned MSYS host compiler.
   No shell utilities, environment-derived identities or fallback execution.
   Linux compilation/tests validate the harness only, never the MSYS runtime. */
#define _POSIX_C_SOURCE 200809L
#define _DEFAULT_SOURCE 1
#include <sys/types.h>
#include <sys/stat.h>
#include <sys/file.h>
#include <sys/socket.h>
#include <sys/un.h>
#include <sys/wait.h>
#include <fcntl.h>
#include <unistd.h>
#include <signal.h>
#include <poll.h>
#include <mqueue.h>
#include <errno.h>
#include <limits.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <stddef.h>
#if defined(__CYGWIN__) || defined(__MSYS__)
#define WIN32_LEAN_AND_MEAN
#include <windows.h>
#define NATIVE_NULL_CAPABILITY_CASES 3
#else
#define NATIVE_NULL_CAPABILITY_CASES 0
#endif

static volatile sig_atomic_t owned_child;
static int child_role;
static const char *mode;
static char work[PATH_MAX];
static char program[PATH_MAX];
static const char *classify(int error) {
  if (error == EACCES || error == EPERM) return "denied";
  if (error == ENOSYS || error == ENOTSUP || error == EOPNOTSUPP || error == EAFNOSUPPORT || error == EPROTONOSUPPORT) return "unsupported";
  return "failure";
}
static void watchdog(int signal_number) {
  static const char message[] = "{\"status\":\"timed-out\",\"stage\":\"internal-watchdog\"}\n";
  (void)signal_number;
  if (owned_child > 0) kill((pid_t)owned_child, SIGKILL);
  { ssize_t written = write(STDERR_FILENO, message, sizeof(message) - 1); (void)written; }
  _exit(124);
}
static void arm_watchdog(void) {
  struct sigaction action;
  memset(&action, 0, sizeof(action)); action.sa_handler = watchdog;
  sigemptyset(&action.sa_mask);
  if (sigaction(SIGALRM, &action, NULL) != 0) _exit(125);
  action.sa_handler = SIG_IGN;
  if (sigaction(SIGPIPE, &action, NULL) != 0) _exit(125);
  alarm(20);
}
static void fail(const char *stage, int error) {
  int saved = error;
  if (owned_child > 0) {
    pid_t pid = (pid_t)owned_child;
    kill(pid, SIGKILL);
    while (waitpid(pid, NULL, 0) < 0 && errno == EINTR) {}
    owned_child = 0;
  }
  fprintf(stderr, "{\"status\":\"failed\",\"classification\":\"%s\",\"role\":\"%s\",\"mode\":\"%s\",\"stage\":\"%s\",\"errno\":%d}\n",
          classify(saved), child_role ? "child" : "parent", mode, stage, saved);
  fflush(stderr); _exit(1);
}
static void require(int condition, const char *stage) { if (!condition) fail(stage, EPROTO); }
static void close_fd(int fd, const char *stage) { if (close(fd) != 0) fail(stage, errno); }
static void write_exact(int fd, const void *data, size_t length, const char *stage) {
  const char *cursor = data;
  while (length) {
    ssize_t count = write(fd, cursor, length);
    if (count < 0 && errno == EINTR) continue;
    if (count <= 0) fail(stage, count < 0 ? errno : EIO);
    cursor += count; length -= (size_t)count;
  }
}
static void read_exact(int fd, const void *expected, size_t length, const char *stage) {
  char bytes[128]; size_t used = 0;
  require(length <= sizeof(bytes), "read-bound");
  while (used < length) {
    ssize_t count = read(fd, bytes + used, length - used);
    if (count < 0 && errno == EINTR) continue;
    if (count <= 0) fail(stage, count < 0 ? errno : EPIPE);
    used += (size_t)count;
  }
  require(memcmp(bytes, expected, length) == 0, stage);
}
static void wait_readable(int fd, const char *stage) {
  struct pollfd item = { fd, POLLIN, 0 };
  int result;
  do { result = poll(&item, 1, 3000); } while (result < 0 && errno == EINTR);
  if (result < 0) fail(stage, errno);
  require(result == 1 && (item.revents & POLLIN), stage);
}
static pid_t fork_owned(const char *stage) {
  pid_t pid = fork();
  if (pid < 0) fail(stage, errno);
  if (pid == 0) { owned_child = 0; child_role = 1; arm_watchdog(); }
  else owned_child = (sig_atomic_t)pid;
  return pid;
}
static void wait_owned(const char *stage) {
  int status; pid_t result, expected = (pid_t)owned_child;
  do { result = waitpid(expected, &status, 0); } while (result < 0 && errno == EINTR);
  if (result < 0) fail(stage, errno);
  owned_child = 0;
  require(result == expected && WIFEXITED(status) && WEXITSTATUS(status) == 0, stage);
}
static void make_pipe(int ends[2], const char *stage) { if (pipe(ends) != 0) fail(stage, errno); }
static int open_file(const char *name, int flags, mode_t permissions, const char *stage) {
  int fd = open(name, flags, permissions); if (fd < 0) fail(stage, errno); return fd;
}
static void remove_file(const char *name) { if (unlink(name) != 0) fail("unlink-owned-file", errno); }

static void null_read_positive(const char *stage) {
  char byte; int fd = open_file("/dev/null", O_RDONLY, 0, stage);
  require(read(fd, &byte, 1) == 0, "null-read-eof"); close_fd(fd, "null-positive-close");
}
static int descriptor_argument(const char *text) {
  char *end; long value; errno = 0; value = strtol(text, &end, 10);
  require(text[0] && !*end && !errno && value >= 3 && value <= INT_MAX, "null-child-descriptor-argument");
  return (int)value;
}
static void null_exec_child(const char *inherited_text, const char *closed_text) {
  int inherited = descriptor_argument(inherited_text), closed = descriptor_argument(closed_text);
  char byte; struct stat info;
  require(inherited != closed, "null-child-distinct-descriptors");
  require(fcntl(inherited, F_GETFD) == 0, "null-inherited-after-exec");
  require(fstat(inherited, &info) == 0 && S_ISCHR(info.st_mode), "null-inherited-character-device");
  require(read(inherited, &byte, 1) == 0, "null-inherited-eof-after-exec");
  errno = 0; require(fcntl(closed, F_GETFD) == -1 && errno == EBADF, "null-cloexec-closed-after-exec");
  close_fd(inherited, "null-child-inherited-close");
  null_read_positive("null-reopen-after-exec"); _exit(0);
}
#if NATIVE_NULL_CAPABILITY_CASES
static void null_locator_refused(const WCHAR *locator, const WCHAR *original, int expected_errno, const char *stage) {
  int fd, saved;
  require(SetEnvironmentVariableW(L"AUTOPROMPT_PRIVATE_NUL_HANDLE", locator) != 0, "null-set-native-locator");
  errno = 0; fd = open("/dev/null", O_RDONLY); saved = errno;
  /* Restore the actual Win32 environment even if the negative control fails.
     Cygwin setenv alone does not establish which value the helper observes. */
  require(SetEnvironmentVariableW(L"AUTOPROMPT_PRIVATE_NUL_HANDLE", original) != 0, "null-restore-native-locator");
  if (fd >= 0) close_fd(fd, "null-unexpected-negative-close");
  require(fd == -1 && saved == expected_errno, stage);
  null_read_positive("null-restored-positive-control");
}
static void null_capability_controls(void) {
  WCHAR original[sizeof(uintptr_t) * 2 + 1], locator[sizeof(uintptr_t) * 2 + 1];
  HANDLE event; uintptr_t numeric; size_t index;
  DWORD length = GetEnvironmentVariableW(L"AUTOPROMPT_PRIVATE_NUL_HANDLE", original, sizeof(original) / sizeof(original[0]));
  require(length == sizeof(uintptr_t) * 2 && original[length] == 0, "null-original-native-locator");
  null_locator_refused(L"invalid", original, EINVAL, "null-malformed-locator-refused");
  event = CreateEventW(NULL, TRUE, FALSE, NULL);
  require(event != NULL, "null-owned-event-create");
  numeric = (uintptr_t)event;
  for (index = 0; index < sizeof(uintptr_t) * 2; index++)
    locator[index] = L"0123456789abcdef"[(numeric >> ((sizeof(uintptr_t) * 2 - 1 - index) * 4)) & 15];
  locator[index] = 0;
  null_locator_refused(locator, original, EBADF, "null-wrong-object-locator-refused");
  require(CloseHandle(event) != 0, "null-owned-event-close");
  null_locator_refused(locator, original, EBADF, "null-closed-locator-refused");
}
#endif
static void proof_null(void) {
  int reader, writer, closed, rejected; char byte; char inherited_arg[32], closed_arg[32]; struct stat info;
  reader = open_file("/dev/null", O_RDONLY, 0, "null-readonly-open");
  require(read(reader, &byte, 1) == 0, "null-readonly-eof");
  errno = 0; require(write(reader, "x", 1) == -1 && errno == EBADF, "null-readonly-write-refused");
  writer = open_file("/dev/null", O_WRONLY | O_CREAT | O_TRUNC, 0600, "null-writeonly-create-truncate-open");
  require(write(writer, "null-write", 10) == 10, "null-writeonly-write");
  errno = 0; require(read(writer, &byte, 1) == -1 && errno == EBADF, "null-writeonly-read-refused");
  close_fd(writer, "null-writeonly-close");
  writer = open_file("/dev/null", O_RDWR, 0, "null-readwrite-open");
  require(read(writer, &byte, 1) == 0, "null-readwrite-eof");
  require(write(writer, "readwrite", 9) == 9, "null-readwrite-write");
  close_fd(writer, "null-readwrite-close");
  errno = 0; rejected = open("/dev/null", O_WRONLY | O_CREAT | O_EXCL, 0600);
  require(rejected == -1 && errno == EEXIST, "null-exclusive-create-refused");
  errno = 0; rejected = open("/dev/null", O_RDONLY | O_DIRECTORY);
  require(rejected == -1 && errno == ENOTDIR, "null-directory-open-refused");
  closed = open_file("/dev/null", O_RDONLY | O_CLOEXEC, 0, "null-cloexec-open");
  require(fcntl(reader, F_GETFD) == 0, "null-inherited-descriptor-flags");
  require(fcntl(closed, F_GETFD) == FD_CLOEXEC, "null-cloexec-descriptor-flags");
  require(snprintf(inherited_arg, sizeof(inherited_arg), "%d", reader) > 0, "null-inherited-argument");
  require(snprintf(closed_arg, sizeof(closed_arg), "%d", closed) > 0, "null-closed-argument");
  if (fork_owned("null-fork") == 0) {
    execl(program, program, "null-child", inherited_arg, closed_arg, (char *)NULL);
    fail("null-exec", errno);
  }
  wait_owned("null-exec-waitpid");
  close_fd(reader, "null-parent-reader-close"); close_fd(closed, "null-parent-cloexec-close");
  /* /dev is a real directory on Linux and a fake-lock-handle fhandler in MSYS. */
  reader = open_file("/dev", O_RDONLY | O_DIRECTORY | O_CLOEXEC, 0, "null-fake-directory-open");
  require(fstat(reader, &info) == 0 && S_ISDIR(info.st_mode), "null-fake-directory-kind");
  require(fcntl(reader, F_GETFD) == FD_CLOEXEC, "null-fake-directory-cloexec");
  close_fd(reader, "null-fake-directory-close");
#if NATIVE_NULL_CAPABILITY_CASES
  null_capability_controls();
#endif
}

static void proof_pipe_fork(void) {
  int request[2], reply[2]; make_pipe(request, "pipe-request"); make_pipe(reply, "pipe-reply");
  if (fork_owned("pipe-fork") == 0) {
    close_fd(request[1], "child-close-request-writer"); close_fd(reply[0], "child-close-reply-reader");
    read_exact(request[0], "parent-request", 14, "pipe-child-read");
    write_exact(reply[1], "child-response", 14, "pipe-child-write");
    close_fd(request[0], "child-close-request"); close_fd(reply[1], "child-close-reply"); _exit(0);
  }
  close_fd(request[0], "parent-close-request-reader"); close_fd(reply[1], "parent-close-reply-writer");
  write_exact(request[1], "parent-request", 14, "pipe-parent-write");
  wait_readable(reply[0], "pipe-parent-poll"); read_exact(reply[0], "child-response", 14, "pipe-parent-read");
  close_fd(request[1], "parent-close-request"); close_fd(reply[0], "parent-close-reply"); wait_owned("pipe-waitpid");
}
static void proof_fifo(void) {
  int missing, reader, writer; char byte;
  if (mkfifo("fifo", 0600) != 0) fail("mkfifo", errno);
  errno = 0; missing = open("fifo", O_WRONLY | O_NONBLOCK);
  if (missing >= 0) { close_fd(missing, "unexpected-fifo-writer"); fail("fifo-missing-peer-accepted", EPROTO); }
  if (errno != ENXIO) fail("fifo-missing-peer-must-be-enxio", errno);
  reader = open_file("fifo", O_RDONLY | O_NONBLOCK, 0, "fifo-reader-open");
  { ssize_t count = read(reader, &byte, 1);
    if (count < 0) fail("fifo-reader-without-writer", errno);
    require(count == 0, "fifo-reader-without-writer-eof"); }
  if (fork_owned("fifo-fork") == 0) {
    close_fd(reader, "fifo-child-close-inherited-reader");
    writer = open_file("fifo", O_WRONLY | O_NONBLOCK, 0, "fifo-writer-open");
    write_exact(writer, "fifo-message", 12, "fifo-write"); close_fd(writer, "fifo-writer-close"); _exit(0);
  }
  wait_readable(reader, "fifo-poll"); read_exact(reader, "fifo-message", 12, "fifo-read");
  wait_owned("fifo-waitpid"); close_fd(reader, "fifo-reader-close"); remove_file("fifo");
}
static void set_record_lock(int fd, short type, const char *stage) {
  struct flock lock; memset(&lock, 0, sizeof(lock)); lock.l_type = type; lock.l_whence = SEEK_SET; lock.l_len = 1;
  if (fcntl(fd, F_SETLK, &lock) != 0) fail(stage, errno);
}
static void proof_locks(void) {
  int file = open_file("locked", O_CREAT | O_EXCL | O_RDWR, 0600, "lock-file-create");
  write_exact(file, "old", 3, "lock-file-initialize");
  if (flock(file, LOCK_EX | LOCK_NB) != 0) fail("flock-parent-acquire", errno);
  if (fork_owned("flock-fork") == 0) {
    int other, result, saved; close_fd(file, "flock-child-close-inherited");
    other = open_file("locked", O_RDWR, 0, "flock-child-open");
    result = flock(other, LOCK_EX | LOCK_NB); saved = errno;
    if (result != -1 || (saved != EAGAIN && saved != EWOULDBLOCK))
      fail("flock-contention-not-denied", result == -1 ? saved : EPROTO);
    close_fd(other, "flock-child-close"); _exit(0);
  }
  wait_owned("flock-waitpid"); if (flock(file, LOCK_UN) != 0) fail("flock-parent-release", errno);
  set_record_lock(file, F_WRLCK, "record-lock-parent-acquire");
  if (fork_owned("record-lock-fork") == 0) {
    int other, result, saved; struct flock lock;
    close_fd(file, "record-lock-child-close-inherited"); other = open_file("locked", O_RDWR, 0, "record-lock-child-open");
    memset(&lock, 0, sizeof(lock)); lock.l_type = F_WRLCK; lock.l_whence = SEEK_SET; lock.l_len = 1;
    result = fcntl(other, F_SETLK, &lock); saved = errno;
    if (result != -1 || (saved != EACCES && saved != EAGAIN))
      fail("record-lock-contention-not-denied", result == -1 ? saved : EPROTO);
    close_fd(other, "record-lock-child-close"); _exit(0);
  }
  wait_owned("record-lock-waitpid"); set_record_lock(file, F_UNLCK, "record-lock-parent-release");
  if (fork_owned("lock-shared-state-fork") == 0) {
    int other; close_fd(file, "shared-state-child-close-inherited"); other = open_file("locked", O_RDWR, 0, "shared-state-child-open");
    if (flock(other, LOCK_EX | LOCK_NB) != 0) fail("flock-child-after-release", errno);
    set_record_lock(other, F_WRLCK, "record-lock-child-after-release");
    write_exact(other, "new", 3, "lock-shared-state-write"); set_record_lock(other, F_UNLCK, "record-lock-child-release");
    if (flock(other, LOCK_UN) != 0) fail("flock-child-release", errno);
    close_fd(other, "shared-state-child-close"); _exit(0);
  }
  wait_owned("shared-state-waitpid"); require(lseek(file, 0, SEEK_SET) == 0, "shared-state-seek");
  read_exact(file, "new", 3, "lock-shared-state-observed"); close_fd(file, "lock-file-close"); remove_file("locked");
}
static void proof_mqueue(void) {
  char name[96], bytes[64]; unsigned priority = 0; struct mq_attr attributes; mqd_t queue;
  const char *leaf = strrchr(work, '/'); leaf = leaf ? leaf + 1 : work;
  require(snprintf(name, sizeof(name), "/autoprompt-%ld-%s", (long)getpid(), leaf) < (int)sizeof(name), "mq-name-bound");
  memset(&attributes, 0, sizeof(attributes)); attributes.mq_maxmsg = 4; attributes.mq_msgsize = sizeof(bytes);
  queue = mq_open(name, O_CREAT | O_EXCL | O_RDWR | O_NONBLOCK, 0600, &attributes);
  if (queue == (mqd_t)-1) fail("mq-open-create", errno);
  /* The controller may inspect this owned scratch receipt after proven job
     drain. It records a successfully created queue, not an attempted name.
     A crash between creation and this write still needs isolated backing. */
  { int receipt = open_file("mqueue-name", O_CREAT | O_EXCL | O_WRONLY, 0600, "mq-receipt-create");
    write_exact(receipt, name, strlen(name), "mq-receipt-name");
    write_exact(receipt, "\n", 1, "mq-receipt-newline");
    close_fd(receipt, "mq-receipt-close"); }
  if (mq_getattr(queue, &attributes) != 0) fail("mq-getattr", errno);
  require(attributes.mq_msgsize == (long)sizeof(bytes) && attributes.mq_curmsgs == 0, "mq-created-attributes");
  { ssize_t count; int saved;
    errno = 0; count = mq_receive(queue, bytes, sizeof(bytes), &priority); saved = errno;
    if (count != -1 || saved != EAGAIN) fail("mq-empty-must-be-eagain", count == -1 ? saved : EPROTO); }
  if (mq_send(queue, "request", 7, 7) != 0) fail("mq-send-request", errno);
  if (fork_owned("mq-fork") == 0) {
    mqd_t other; if (mq_close(queue) != 0) fail("mq-child-close-inherited", errno);
    other = mq_open(name, O_RDWR | O_NONBLOCK); if (other == (mqd_t)-1) fail("mq-child-open", errno);
    { ssize_t count = mq_receive(other, bytes, sizeof(bytes), &priority);
      if (count < 0) fail("mq-child-receive", errno);
      require(count == 7 && priority == 7 && memcmp(bytes, "request", 7) == 0, "mq-child-message"); }
    if (mq_send(other, "reply", 5, 4) != 0) fail("mq-child-send", errno);
    if (mq_close(other) != 0) fail("mq-child-close", errno);
    _exit(0);
  }
  wait_owned("mq-waitpid");
  { ssize_t count = mq_receive(queue, bytes, sizeof(bytes), &priority);
    if (count < 0) fail("mq-parent-receive", errno);
    require(count == 5 && priority == 4 && memcmp(bytes, "reply", 5) == 0, "mq-parent-message"); }
  if (mq_close(queue) != 0) fail("mq-parent-close", errno);
  if (mq_unlink(name) != 0) fail("mq-unlink", errno);
  errno = 0; queue = mq_open(name, O_RDONLY | O_NONBLOCK);
  if (queue != (mqd_t)-1) { mq_close(queue); fail("mq-unlink-reopened", EPROTO); }
  if (errno != ENOENT) fail("mq-unlinked-must-be-enoent", errno);
  remove_file("mqueue-name");
}
static void proof_af_local(void) {
  int pair[2], server, accepted; struct sockaddr_un address; socklen_t length;
  if (socketpair(AF_UNIX, SOCK_STREAM, 0, pair) != 0) fail("af-local-socketpair", errno);
  write_exact(pair[0], "pair", 4, "af-local-pair-write"); wait_readable(pair[1], "af-local-pair-poll");
  read_exact(pair[1], "pair", 4, "af-local-pair-read"); close_fd(pair[0], "af-local-pair-close0"); close_fd(pair[1], "af-local-pair-close1");
  server = socket(AF_UNIX, SOCK_STREAM, 0); if (server < 0) fail("af-local-server-socket", errno);
  memset(&address, 0, sizeof(address)); address.sun_family = AF_UNIX; strcpy(address.sun_path, "endpoint");
  length = (socklen_t)(offsetof(struct sockaddr_un, sun_path) + strlen(address.sun_path) + 1);
  if (bind(server, (struct sockaddr *)&address, length) != 0) fail("af-local-bind", errno);
  if (listen(server, 1) != 0) fail("af-local-listen", errno);
  if (fork_owned("af-local-fork") == 0) {
    int client; close_fd(server, "af-local-child-close-server"); client = socket(AF_UNIX, SOCK_STREAM, 0);
    if (client < 0) fail("af-local-client-socket", errno);
    if (connect(client, (struct sockaddr *)&address, length) != 0) fail("af-local-connect", errno);
    write_exact(client, "socket-request", 14, "af-local-client-write"); read_exact(client, "socket-reply", 12, "af-local-client-read");
    close_fd(client, "af-local-client-close"); _exit(0);
  }
  wait_readable(server, "af-local-server-poll"); accepted = accept(server, NULL, NULL); if (accepted < 0) fail("af-local-accept", errno);
  read_exact(accepted, "socket-request", 14, "af-local-server-read"); write_exact(accepted, "socket-reply", 12, "af-local-server-write");
  close_fd(accepted, "af-local-accepted-close"); wait_owned("af-local-waitpid"); close_fd(server, "af-local-server-close"); remove_file("endpoint");
}
static void proof_blocked_fifo(void) {
  int hold, ready[2], finished[2]; struct pollfd item; int result;
  if (mkfifo("blocked-fifo", 0600) != 0) fail("blocked-mkfifo", errno);
  hold = open_file("blocked-fifo", O_RDWR | O_NONBLOCK, 0, "blocked-hold-open");
  make_pipe(ready, "blocked-ready-pipe"); make_pipe(finished, "blocked-finished-pipe");
  if (fork_owned("blocked-fork") == 0) {
    int reader; char byte; ssize_t received;
    close_fd(ready[0], "blocked-child-ready-reader"); close_fd(finished[0], "blocked-child-finished-reader");
    close_fd(hold, "blocked-child-hold-close"); reader = open_file("blocked-fifo", O_RDONLY, 0, "blocked-reader-open");
    write_exact(ready[1], "R", 1, "blocked-ready-write"); close_fd(ready[1], "blocked-child-ready-close");
    received = read(reader, &byte, 1); /* No writer ever supplies data; parent holds the peer open. */
    (void)received; write_exact(finished[1], "F", 1, "blocked-unexpected-finish"); fail("blocked-read-returned", EPROTO);
  }
  close_fd(ready[1], "blocked-parent-ready-writer"); close_fd(finished[1], "blocked-parent-finished-writer");
  wait_readable(ready[0], "blocked-parent-ready-poll"); read_exact(ready[0], "R", 1, "blocked-parent-ready-read"); close_fd(ready[0], "blocked-parent-ready-close");
  item.fd = finished[0]; item.events = POLLIN; item.revents = 0;
  do { result = poll(&item, 1, 100); } while (result < 0 && errno == EINTR);
  if (result < 0) fail("blocked-observe-poll", errno);
  require(result == 0, "blocked-read-completed-before-cancel");
  require(waitpid((pid_t)owned_child, NULL, WNOHANG) == 0, "blocked-child-not-live");
  printf("{\"status\":\"ready\",\"mode\":\"blocked-fifo\",\"phase\":\"reader-open-no-completion\",\"childPid\":%ld,\"observationMs\":100}\n", (long)owned_child); fflush(stdout);
  /* Only external owned-job cancellation is success for this mode. If no
     cancellation arrives, the 20s internal watchdog fails with exit124. */
  wait_owned("blocked-child-ended-without-controller-cancel"); fail("blocked-mode-returned", EPROTO);
}
int main(int argc, char **argv) {
  const char *scratch; struct stat status; int length;
  mode = argc > 1 ? argv[1] : "invalid";
  if (argc == 4 && !strcmp(mode, "null-child")) {
    child_role = 1; arm_watchdog(); null_exec_child(argv[2], argv[3]);
  }
  if (argc != 3 || (strcmp(mode, "fifo") && strcmp(mode, "locks") && strcmp(mode, "mqueue") && strcmp(mode, "af-local") && strcmp(mode, "pipe-fork") && strcmp(mode, "blocked-fifo") && strcmp(mode, "null"))) {
    fputs("usage: posix-proof <fifo|locks|mqueue|af-local|pipe-fork|blocked-fifo|null> <owned-scratch>\n", stderr); return 64;
  }
  scratch = argv[2]; arm_watchdog(); umask(077);
  if (!strcmp(mode, "null") && !realpath(argv[0], program)) fail("null-executable-realpath", errno);
  require(scratch[0] == '/' || (strlen(scratch) >= 3 && scratch[1] == ':' && (scratch[2] == '/' || scratch[2] == '\\')), "scratch-must-be-absolute");
  if (lstat(scratch, &status) != 0) fail("scratch-stat", errno);
  require(S_ISDIR(status.st_mode) && !S_ISLNK(status.st_mode), "scratch-must-be-physical-directory");
  length = snprintf(work, sizeof(work), "%s/posix-proof.XXXXXX", scratch);
  require(length > 0 && length < (int)sizeof(work), "scratch-path-bound");
  if (!mkdtemp(work)) fail("owned-directory-create", errno);
  if (chdir(work) != 0) fail("owned-directory-chdir", errno);
  if (!strcmp(mode, "fifo")) proof_fifo();
  else if (!strcmp(mode, "locks")) proof_locks();
  else if (!strcmp(mode, "mqueue")) proof_mqueue();
  else if (!strcmp(mode, "af-local")) proof_af_local();
  else if (!strcmp(mode, "pipe-fork")) proof_pipe_fork();
  else if (!strcmp(mode, "null")) proof_null();
  else proof_blocked_fifo();
  if (chdir(scratch) != 0) fail("scratch-return", errno);
  if (rmdir(work) != 0) fail("owned-directory-remove", errno);
  alarm(0);
  if (!strcmp(mode, "null"))
    printf("{\"status\":\"passed\",\"mode\":\"null\",\"supported\":true,\"capabilityRefusals\":%d}\n", NATIVE_NULL_CAPABILITY_CASES);
  else printf("{\"status\":\"passed\",\"mode\":\"%s\",\"supported\":true}\n", mode);
  return 0;
}
