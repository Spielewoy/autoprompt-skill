#include <arpa/inet.h>
#include <errno.h>
#include <fcntl.h>
#include <launch.h>
#include <netinet/in.h>
#include <signal.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/socket.h>
#include <unistd.h>

static int publish(const char *path, int fd) {
  struct sockaddr_in address; socklen_t length = sizeof(address);
  if (getsockname(fd, (struct sockaddr *)&address, &length) != 0 || address.sin_family != AF_INET) return 2;
  char text[128]; int bytes = snprintf(text, sizeof(text), "{\"pid\":%d,\"port\":%u}\n", getpid(), (unsigned)ntohs(address.sin_port));
  char temporary[512];
  int temporary_bytes = snprintf(temporary, sizeof(temporary), "%s.%d.tmp", path, getpid());
  if (temporary_bytes < 0 || (size_t)temporary_bytes >= sizeof(temporary)) return 3;
  int out = open(temporary, O_WRONLY | O_CREAT | O_EXCL, 0600);
  if (out < 0) return 3;
  int ok = write(out, text, (size_t)bytes) == bytes && fsync(out) == 0;
  if (close(out) != 0) ok = 0;
  if (ok && rename(temporary, path) == 0) return 0;
  unlink(temporary); return 4;
}
static int probe_failure(const char *operation) {
  int value = errno;
  fprintf(stderr, "%s errno=%d\\n", operation, value);
  return value == EACCES || value == EPERM ? 77 : 66;
}
static int parsed_port(const char *text, in_port_t *port) {
  char *end = NULL;
  unsigned long value = strtoul(text, &end, 10);
  if (!text[0] || !end || *end || value > 65535) return -1;
  *port = htons((in_port_t)value);
  return 0;
}
static int connect4(const char *host, const char *text) {
  struct sockaddr_in address;
  in_port_t port;
  if (parsed_port(text, &port)) return 64;
  int fd = socket(AF_INET, SOCK_STREAM, 0);
  if (fd < 0) return 65;
  memset(&address, 0, sizeof(address));
  address.sin_family = AF_INET; address.sin_port = port;
  if (inet_pton(AF_INET, host, &address.sin_addr) != 1) { close(fd); return 64; }
  int result = connect(fd, (struct sockaddr *)&address, sizeof(address)) == 0 ? 0 : probe_failure("connect4");
  close(fd); return result;
}
static int connect6(const char *host, const char *text) {
  struct sockaddr_in6 address;
  in_port_t port;
  if (parsed_port(text, &port)) return 64;
  memset(&address, 0, sizeof(address));
  address.sin6_family = AF_INET6; address.sin6_port = port;
  if (inet_pton(AF_INET6, host, &address.sin6_addr) != 1) return 64;
  int fd = socket(AF_INET6, SOCK_STREAM, 0);
  if (fd < 0) return 65;
  int result = connect(fd, (struct sockaddr *)&address, sizeof(address)) == 0 ? 0 : probe_failure("connect6");
  close(fd); return result;
}
static int bind4(const char *host, const char *text) {
  struct sockaddr_in address;
  in_port_t port;
  if (parsed_port(text, &port)) return 64;
  memset(&address, 0, sizeof(address));
  address.sin_family = AF_INET; address.sin_port = port;
  if (inet_pton(AF_INET, host, &address.sin_addr) != 1) return 64;
  int fd = socket(AF_INET, SOCK_STREAM, 0);
  if (fd < 0) return 65;
  int result = bind(fd, (struct sockaddr *)&address, sizeof(address)) == 0 ? 0 : probe_failure("bind4");
  close(fd); return result;
}
int main(int argc, char **argv) {
  if (argc == 4) {
    if (strcmp(argv[1], "connect4") == 0) return connect4(argv[2], argv[3]);
    if (strcmp(argv[1], "connect6") == 0) return connect6(argv[2], argv[3]);
    if (strcmp(argv[1], "bind4") == 0) return bind4(argv[2], argv[3]);
    return 64;
  }
  if (argc != 3) return 64;
  int *fds = NULL; size_t count = 0;
  int status = launch_activate_socket(argv[1], &fds, &count);
  if (status != 0 || !fds || count != 1) { free(fds); return 65; }
  int result = publish(argv[2], fds[0]);
  if (result != 0) { close(fds[0]); free(fds); return result; }
  for (;;) pause();
}
