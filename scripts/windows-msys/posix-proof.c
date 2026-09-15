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

static volatile sig_atomic_t owned_child;
static int child_role;
static const char *mode;
static char work[PATH_MAX];
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
  if (argc != 3 || (strcmp(mode, "fifo") && strcmp(mode, "locks") && strcmp(mode, "mqueue") && strcmp(mode, "af-local") && strcmp(mode, "pipe-fork") && strcmp(mode, "blocked-fifo"))) {
    fputs("usage: posix-proof <fifo|locks|mqueue|af-local|pipe-fork|blocked-fifo> <owned-scratch>\n", stderr); return 64;
  }
  scratch = argv[2]; arm_watchdog(); umask(077);
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
  else proof_blocked_fifo();
  if (chdir(scratch) != 0) fail("scratch-return", errno);
  if (rmdir(work) != 0) fail("owned-directory-remove", errno);
  alarm(0);
  printf("{\"status\":\"passed\",\"mode\":\"%s\",\"supported\":true}\n", mode);
  return 0;
}
