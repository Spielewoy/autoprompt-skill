#!/usr/bin/bash
# Run inside the already verified, pinned SDK after the adapted DLL build.
# Arguments are owned input and a FRESH output directory under /issue27-build.
set -Eeuo pipefail
umask 077
source_file=${1:?source file}; output=${2:?fresh output directory}
[[ $output =~ ^/issue27-build/posix-compile-[A-Za-z0-9-]+$ && ! -e $output ]]
[[ $source_file == /* && $source_file != *[$'\r\n']* ]]
unset GCC_EXEC_PREFIX COMPILER_PATH LIBRARY_PATH C_INCLUDE_PATH CPLUS_INCLUDE_PATH CPATH OBJC_INCLUDE_PATH LD_PRELOAD
export PATH=/usr/bin:/bin LC_ALL=C.UTF-8 MSYSTEM=MSYS
[[ $(git -C / rev-parse HEAD) == e3cc14afd549778c2f2d3bcc6e89307f40f5c2c1 ]]
printf '%s  /usr/bin/gcc.exe\n' 4bd76635b6053a7926f4579a30f9c800a673632fd10b4d6adf8083d3eda1b80c | sha256sum -c -
printf '%s  %s\n' 4e225db6364d28e7dd2b7b9458e9ac2506e9eb31358251784be4fcbf2eb0856b "$source_file" | sha256sum -c -
mkdir "$output"
cp -- "$source_file" "$output/posix-proof.c"
printf '%s  %s\n' 4e225db6364d28e7dd2b7b9458e9ac2506e9eb31358251784be4fcbf2eb0856b "$output/posix-proof.c" | sha256sum -c -
# No extra utilities are required by the executable at runtime. Do not install
# into /usr/bin or replace its loaded MSYS DLL. MSYS exports POSIX libc APIs.
/usr/bin/gcc -std=c11 -O2 -Wall -Wextra -Werror -Wl,--dynamicbase -Wl,--no-insert-timestamp \
  "$output/posix-proof.c" -o "$output/posix-proof.exe"
(cd "$output" && sha256sum posix-proof.c posix-proof.exe > fixture.sha256)
printf '%s  /usr/bin/gcc.exe\n' 4bd76635b6053a7926f4579a30f9c800a673632fd10b4d6adf8083d3eda1b80c | sha256sum -c -
