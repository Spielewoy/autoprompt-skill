/*
 * Diagnostic only.  This exercises the deprecated launch_data SubmitJob FD
 * path to determine whether a current macOS launchd retains caller-created,
 * no-reuse listeners after its checked-in worker dies.  It is not a runtime
 * launcher and must never be used as one without native evidence.
 */
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

static void diagnostic(const char *stage, int error) { fprintf(stderr, "exclusive-fd stage=%s errno=%d\n", stage, error); }
static int parse_port(const char *text, in_port_t *port) {
  char *end = NULL; unsigned long value = strtoul(text, &end, 10);
  if (!text[0] || !end || *end || value == 0 || value > 65535) return -1;
  *port = htons((in_port_t)value); return 0;
}
static int valid_label(const char *label) {
  const char *prefix = "com.autoprompt.exclusivefd."; size_t length = strlen(label);
  if (length <= strlen(prefix) || length > 160 || strncmp(label, prefix, strlen(prefix)) != 0) return 0;
  for (size_t i = 0; i < length; i++) if (!((label[i] >= 'a' && label[i] <= 'z') || (label[i] >= '0' && label[i] <= '9') || label[i] == '.')) return 0;
  return label[length - 1] != '.' && strstr(label, "..") == NULL;
}
static int write_receipt(const char *path, const char *label, in_port_t port) {
  char temporary[1024], body[512];
  int length = snprintf(body, sizeof(body), "{\"pid\":%d,\"label\":\"%s\",\"port\":%u}\n", getpid(), label, (unsigned)ntohs(port));
  int temporary_length = snprintf(temporary, sizeof(temporary), "%s.%d.tmp", path, getpid());
  if (length < 0 || (size_t)length >= sizeof(body) || temporary_length < 0 || (size_t)temporary_length >= sizeof(temporary)) return 70;
  int fd = open(temporary, O_WRONLY | O_CREAT | O_EXCL, 0600);
  if (fd < 0) return 71;
  int ok = write(fd, body, (size_t)length) == length && fsync(fd) == 0 && close(fd) == 0 && rename(temporary, path) == 0;
  if (!ok) unlink(temporary);
  return ok ? 0 : 72;
}
static int bind4(in_port_t requested, in_port_t *actual) {
  int fd = socket(AF_INET, SOCK_STREAM, IPPROTO_TCP); struct sockaddr_in address; socklen_t length = sizeof(address);
  if (fd < 0) { diagnostic("bind4-socket", errno); return -1; }
  memset(&address, 0, sizeof(address)); address.sin_family = AF_INET; address.sin_addr.s_addr = htonl(INADDR_ANY); address.sin_port = requested;
  if (bind(fd, (struct sockaddr *)&address, sizeof(address)) != 0) { diagnostic("bind4-bind", errno); close(fd); return -1; }
  if (listen(fd, SOMAXCONN) != 0) { diagnostic("bind4-listen", errno); close(fd); return -1; }
  if (getsockname(fd, (struct sockaddr *)&address, &length) != 0) { diagnostic("bind4-getsockname", errno); close(fd); return -1; }
  *actual = address.sin_port; return fd;
}
static int bind6(in_port_t port) {
  int enabled = 1, fd = socket(AF_INET6, SOCK_STREAM, IPPROTO_TCP); struct sockaddr_in6 address;
  if (fd < 0) { diagnostic("bind6-socket", errno); return -1; }
  if (setsockopt(fd, IPPROTO_IPV6, IPV6_V6ONLY, &enabled, sizeof(enabled)) != 0) { diagnostic("bind6-v6only", errno); close(fd); return -1; }
  memset(&address, 0, sizeof(address)); address.sin6_family = AF_INET6; address.sin6_addr = in6addr_loopback; address.sin6_port = port;
  if (bind(fd, (struct sockaddr *)&address, sizeof(address)) != 0) { diagnostic("bind6-bind", errno); close(fd); return -1; }
  if (listen(fd, SOMAXCONN) != 0) { diagnostic("bind6-listen", errno); close(fd); return -1; }
  return fd;
}
static launch_data_t string_data(const char *value) { return value ? launch_data_new_string(value) : NULL; }
static int insert(launch_data_t dict, launch_data_t value, const char *key) { if (!value || !launch_data_dict_insert(dict, value, key)) { if (value) launch_data_free(value); return -1; } return 0; }
static int array_value(launch_data_t array, launch_data_t value, size_t index) { if (!value || !launch_data_array_set_index(array, value, index)) { if (value) launch_data_free(value); return -1; } return 0; }
static int submit(const char *self, const char *ready, const char *label, in_port_t requested) {
  in_port_t port; int fd4 = -1, fd6 = -1, result = 1; launch_data_t message = NULL, job = NULL, response = NULL, arguments = NULL, sockets = NULL, v4 = NULL, v6 = NULL;
  char stdout_path[1024], stderr_path[1024];
  if (!valid_label(label) || ready[0] != '/' || !self[0]) return 64;
  int stdout_length = snprintf(stdout_path, sizeof(stdout_path), "%s.stdout", ready), stderr_length = snprintf(stderr_path, sizeof(stderr_path), "%s.stderr", ready);
  if (stdout_length < 0 || stderr_length < 0 || (size_t)stdout_length >= sizeof(stdout_path) || (size_t)stderr_length >= sizeof(stderr_path)) return 64;
  fd4 = bind4(requested, &port);
  if (fd4 < 0 || (fd6 = bind6(port)) < 0) goto out;
  arguments = launch_data_alloc(LAUNCH_DATA_ARRAY); sockets = launch_data_alloc(LAUNCH_DATA_DICTIONARY);
  v4 = launch_data_alloc(LAUNCH_DATA_ARRAY); v6 = launch_data_alloc(LAUNCH_DATA_ARRAY);
  if (!arguments || !sockets || !v4 || !v6) goto out;
  if (array_value(arguments, string_data(self), 0) || array_value(arguments, string_data("--worker"), 1) || array_value(arguments, string_data(ready), 2) || array_value(arguments, string_data(label), 3) || array_value(v4, launch_data_new_fd(fd4), 0) || array_value(v6, launch_data_new_fd(fd6), 0)) goto out;
  if (insert(sockets, v4, "autoprompt.v4")) { v4 = NULL; goto out; } v4 = NULL;
  if (insert(sockets, v6, "autoprompt.v6")) { v6 = NULL; goto out; } v6 = NULL;
  job = launch_data_alloc(LAUNCH_DATA_DICTIONARY);
  if (!job || insert(job, string_data(label), LAUNCH_JOBKEY_LABEL)) goto out;
  if (insert(job, arguments, LAUNCH_JOBKEY_PROGRAMARGUMENTS)) { arguments = NULL; goto out; } arguments = NULL;
  if (insert(job, string_data(stdout_path), "StandardOutPath") || insert(job, string_data(stderr_path), "StandardErrorPath")) goto out;
  if (insert(job, launch_data_new_bool(true), LAUNCH_JOBKEY_RUNATLOAD) || insert(job, launch_data_new_bool(false), LAUNCH_JOBKEY_KEEPALIVE)) goto out;
  if (insert(job, sockets, LAUNCH_JOBKEY_SOCKETS)) { sockets = NULL; goto out; } sockets = NULL;
  message = launch_data_alloc(LAUNCH_DATA_DICTIONARY);
  if (!message) goto out;
  if (insert(message, job, LAUNCH_KEY_SUBMITJOB)) { job = NULL; goto out; } job = NULL;
  response = launch_msg(message);
  if (!response) { diagnostic("submit-launch-msg-null", errno); goto out; }
  if (launch_data_get_type(response) != LAUNCH_DATA_ERRNO) { fprintf(stderr, "exclusive-fd stage=submit-response-type type=%d\n", (int)launch_data_get_type(response)); goto out; }
  if (launch_data_get_errno(response) != 0) { diagnostic("submit-response-errno", launch_data_get_errno(response)); goto out; }
  printf("{\"submitted\":true,\"port\":%u}\n", (unsigned)ntohs(port)); fflush(stdout); result = 0;
out:
  if (response) launch_data_free(response);
  if (message) launch_data_free(message);
  if (job) launch_data_free(job);
  if (arguments) launch_data_free(arguments);
  if (sockets) launch_data_free(sockets);
  if (v4) launch_data_free(v4);
  if (v6) launch_data_free(v6);
  /* liblaunch frees data containers but does not close caller FD values. */
  if (fd4 >= 0) close(fd4);
  if (fd6 >= 0) close(fd6);
  return result;
}
static int checked_fd(launch_data_t sockets, const char *name, int family, in_port_t port) {
  launch_data_t values, value; struct sockaddr_storage address; socklen_t length = sizeof(address); int reuse_address = -1, reuse_port = -1; socklen_t option_length = sizeof(int);
  if (!sockets || launch_data_get_type(sockets) != LAUNCH_DATA_DICTIONARY) { diagnostic("checkin-sockets-shape", EPROTO); return -1; }
  values = launch_data_dict_lookup(sockets, name);
  if (!values || launch_data_get_type(values) != LAUNCH_DATA_ARRAY || launch_data_array_get_count(values) != 1 || !(value = launch_data_array_get_index(values, 0)) || launch_data_get_type(value) != LAUNCH_DATA_FD) { diagnostic("checkin-fd-shape", EPROTO); return -1; }
  int source = launch_data_get_fd(value), fd = source >= 0 ? dup(source) : -1;
  if (fd < 0) { diagnostic("checkin-fd-dup", errno); return -1; }
  if (getsockname(fd, (struct sockaddr *)&address, &length) != 0) { diagnostic("checkin-getsockname", errno); close(fd); return -1; }
  if (getsockopt(fd, SOL_SOCKET, SO_REUSEADDR, &reuse_address, &option_length) != 0) { diagnostic("checkin-reuseaddr-get", errno); close(fd); return -1; }
  if (reuse_address != 0) { diagnostic("checkin-reuseaddr-value", EADDRINUSE); close(fd); return -1; }
  option_length = sizeof(int); if (getsockopt(fd, SOL_SOCKET, SO_REUSEPORT, &reuse_port, &option_length) != 0) { diagnostic("checkin-reuseport-get", errno); close(fd); return -1; }
  if (reuse_port != 0) { diagnostic("checkin-reuseport-value", EADDRINUSE); close(fd); return -1; }
  if (family == AF_INET) { struct sockaddr_in *v4 = (struct sockaddr_in *)&address; if (address.ss_family != AF_INET || (port && v4->sin_port != port) || v4->sin_addr.s_addr != htonl(INADDR_ANY)) { diagnostic("checkin-family-or-address4", EPROTO); close(fd); return -1; } }
  else { struct sockaddr_in6 *v6 = (struct sockaddr_in6 *)&address; if (address.ss_family != AF_INET6 || (port && v6->sin6_port != port) || memcmp(&v6->sin6_addr, &in6addr_loopback, sizeof(in6addr_loopback))) { diagnostic("checkin-family-or-address6", EPROTO); close(fd); return -1; } }
  return fd;
}
static int worker(const char *ready, const char *label) {
  launch_data_t request = string_data(LAUNCH_KEY_CHECKIN), response = NULL; int fd4 = -1, fd6 = -1, result = 1;
  if (!valid_label(label) || ready[0] != '/') { if (request) launch_data_free(request); return 64; }
  if (!request) { diagnostic("checkin-request", ENOMEM); return result; }
  response = launch_msg(request);
  launch_data_free(request);
  if (!response) { diagnostic("checkin-launch-msg-null", errno); goto out; }
  if (launch_data_get_type(response) != LAUNCH_DATA_DICTIONARY) { fprintf(stderr, "exclusive-fd stage=checkin-response-type type=%d\n", (int)launch_data_get_type(response)); goto out; }
  launch_data_t sockets = launch_data_dict_lookup(response, LAUNCH_JOBKEY_SOCKETS);
  fd4 = checked_fd(sockets, "autoprompt.v4", AF_INET, 0); /* port follows after the first descriptor query */
  if (fd4 >= 0) { struct sockaddr_in address; socklen_t length = sizeof(address); if (getsockname(fd4, (struct sockaddr *)&address, &length) != 0) { diagnostic("checkin-primary-getsockname", errno); goto out; } close(fd4); fd4 = checked_fd(sockets, "autoprompt.v4", AF_INET, address.sin_port); fd6 = checked_fd(sockets, "autoprompt.v6", AF_INET6, address.sin_port); if (fd4 >= 0 && fd6 >= 0) result = write_receipt(ready, label, address.sin_port); }
out:
  if (response) launch_data_free(response);
  if (result != 0) { if (fd4 >= 0) close(fd4); if (fd6 >= 0) close(fd6); return result; }
  for (;;) pause();
}
static int probe_bind(int family, const char *host, const char *text, int reuse) {
  in_port_t port; if (parse_port(text, &port)) return 64;
  int enabled = 1, fd = socket(family, SOCK_STREAM, IPPROTO_TCP); if (fd < 0) return 65;
  if (reuse && (setsockopt(fd, SOL_SOCKET, SO_REUSEADDR, &enabled, sizeof(enabled)) != 0 || setsockopt(fd, SOL_SOCKET, SO_REUSEPORT, &enabled, sizeof(enabled)) != 0)) { close(fd); return 65; }
  int outcome = 66;
  if (family == AF_INET) { struct sockaddr_in address; memset(&address, 0, sizeof(address)); address.sin_family = AF_INET; address.sin_port = port; if (inet_pton(AF_INET, host, &address.sin_addr) == 1 && bind(fd, (struct sockaddr *)&address, sizeof(address)) == 0 && listen(fd, 1) == 0) outcome = 0; }
  else { struct sockaddr_in6 address; memset(&address, 0, sizeof(address)); address.sin6_family = AF_INET6; address.sin6_port = port; if (inet_pton(AF_INET6, host, &address.sin6_addr) == 1 && bind(fd, (struct sockaddr *)&address, sizeof(address)) == 0 && listen(fd, 1) == 0) outcome = 0; }
  if (outcome != 0 && errno == EADDRINUSE) outcome = 78;
  close(fd); return outcome;
}
int main(int argc, char **argv) {
  if ((argc == 5 || argc == 6) && !strcmp(argv[1], "--submit")) { in_port_t requested = 0; if (argc == 6 && parse_port(argv[5], &requested)) return 64; return submit(argv[2], argv[3], argv[4], requested); }
  if (argc == 4 && !strcmp(argv[1], "--worker")) return worker(argv[2], argv[3]);
  if (argc == 4 && (!strcmp(argv[1], "--bind4") || !strcmp(argv[1], "--bind4-reuse"))) return probe_bind(AF_INET, argv[2], argv[3], !strcmp(argv[1], "--bind4-reuse"));
  if (argc == 4 && (!strcmp(argv[1], "--bind6") || !strcmp(argv[1], "--bind6-reuse"))) return probe_bind(AF_INET6, argv[2], argv[3], !strcmp(argv[1], "--bind6-reuse"));
  return 64;
}
