#define _DARWIN_C_SOURCE
#include <arpa/inet.h>
#include <errno.h>
#include <fcntl.h>
#include <launch.h>
#include <netinet/in.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/socket.h>
#include <sys/stat.h>
#include <unistd.h>

static const char *MODEL_SOCKET = "autoprompt.model";
static const char *MCP_SOCKET = "autoprompt.mcp";

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
  if (launch_activate_socket(name, &descriptors, &count) != 0 || !descriptors || count != 1) {
    free(descriptors);
    return 70;
  }
  int descriptor = descriptors[0];
  free(descriptors);
  struct sockaddr_in6 address;
  socklen_t address_length = sizeof(address);
  int type = -1, accepting = -1, v6only = -1, reuseport = -1;
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
  if (getsockopt(descriptor, SOL_SOCKET, SO_ACCEPTCONN, &accepting, &option_length) != 0 || accepting != 1) {
    close(descriptor);
    return 72;
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
  closefrom(5);
  return 0;
}

int main(int argc, char **argv) {
  if (argc != 6 || argv[3][0] != '/' || argv[4][0] != '/' || argv[5][0] != '/') return 64;
  in_port_t model_port, mcp_port;
  if (parse_port(argv[1], &model_port) || parse_port(argv[2], &mcp_port) || model_port == mcp_port) return 65;
  struct stat node_status, script_status, request_status;
  if (lstat(argv[3], &node_status) || !S_ISREG(node_status.st_mode) || access(argv[3], X_OK) != 0 ||
      lstat(argv[4], &script_status) || !S_ISREG(script_status.st_mode) ||
      lstat(argv[5], &request_status) || !S_ISREG(request_status.st_mode)) return 66;
  int model = -1, mcp = -1;
  int status = acquire(MODEL_SOCKET, model_port, &model);
  if (!status) status = acquire(MCP_SOCKET, mcp_port, &mcp);
  if (!status) status = publish_descriptors(model, mcp);
  else if (model >= 0) close(model);
  if (status) {
    if (mcp >= 0) close(mcp);
    fprintf(stderr, "listener handoff refused: %d\n", status);
    return status;
  }
  char *const child_argv[] = { argv[3], argv[4], (char *)"--job", argv[5], NULL };
  execv(argv[3], child_argv);
  fprintf(stderr, "listener handoff exec failed: %d\n", errno);
  return 78;
}
