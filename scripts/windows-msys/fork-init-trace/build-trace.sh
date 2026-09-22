#!/usr/bin/env bash
# Separate diagnostic build. Never install into the SDK or candidate stage.
set -euo pipefail
jobs=${1:?jobs}; epoch=${2:?source epoch}; trace_sha=${3:?externally pinned trace patch SHA}
[[ $jobs =~ ^[1-9][0-9]?$ && $epoch =~ ^[0-9]+$ && $trace_sha =~ ^[a-f0-9]{64}$ ]]
export PATH=/usr/bin:/bin MSYSTEM=MSYS LC_ALL=C.UTF-8 TZ=UTC SOURCE_DATE_EPOCH=$epoch
cd /issue27-build
printf '%s  source.tar.gz\n' 0571ad83f965bf7682a446a874830a560c8b12431e7d54e55f414a3851ba1146 | sha256sum -c -
printf '%s  adaptation.patch\n' bf20b8991c21d3d59be6b226b3c628de35fee0535d5f47cea8ca9d5b6c69fe2b | sha256sum -c -
sha256sum -c bootstrap-runtime.sha256
sha256sum -c toolchain-outputs.sha256
sha256sum -c stage.sha256 > /issue27-fork-trace/candidate-before.txt
cd /issue27-fork-trace
printf '%s  trace.patch\n' "$trace_sha" | sha256sum -c -
# Inputs may be copied here by the trusted controller; outputs must be fresh.
mkdir source build stage tmp build-tools
export TMPDIR=/issue27-fork-trace/tmp
sha256sum /usr/bin/gcc.exe /usr/bin/ld.exe > toolchain-before.sha256
sha256sum /usr/bin/msys-2.0.dll > bootstrap-before.sha256
tar -xzf /issue27-build/source.tar.gz --strip-components=1 -C source
git -C source init
git -C source config core.autocrlf false
git -C source config core.symlinks true
(cd source && git apply --check /issue27-build/adaptation.patch && git apply /issue27-build/adaptation.patch)
(cd source && git apply --check ../trace.patch && git apply ../trace.patch)
for tool in awk gawk; do
 printf '#!/usr/bin/bash\nLC_ALL=C.UTF-8 exec /usr/bin/%s.exe "$@"\n' "$tool" > "build-tools/$tool"
 chmod 700 "build-tools/$tool"
done
export PATH=/issue27-fork-trace/build-tools:/usr/bin:/bin
export CFLAGS='-O2 -pipe -g0 -DCYGPORT_RELEASE_INFO=3.6.10' CXXFLAGS='-O2 -pipe -g0' CPPFLAGS='' LDFLAGS=''
printf 'CFLAGS=%s\nCXXFLAGS=%s\nCPPFLAGS=%s\nLDFLAGS=%s\n' "$CFLAGS" "$CXXFLAGS" "$CPPFLAGS" "$LDFLAGS" > build-flags.txt
(cd source/winsup && ./autogen.sh)
cd build
../source/configure --prefix=/usr --build=x86_64-pc-cygwin --sysconfdir=/etc --with-msys2-runtime-commit=270ba2980700e6e2a0813944d506eecea0f86402 --with-cross-bootstrap --disable-doc --disable-dumper 2>&1 | tee configure-output.txt
LC_ALL=C make -j"$jobs" 2>&1 | tee make-output.txt
LC_ALL=C make -j1 DESTDIR=/issue27-fork-trace/stage install 2>&1 | tee install-output.txt
cd ..
[[ -s stage/usr/bin/msys-2.0.dll ]]
sha256sum -c toolchain-before.sha256
sha256sum -c bootstrap-before.sha256
sha256sum stage/usr/bin/msys-2.0.dll > trace-dll.sha256
(cd /issue27-build && sha256sum -c stage.sha256) > candidate-after.txt
cmp candidate-before.txt candidate-after.txt
printf 'DIAGNOSTIC_ONLY: no candidate export or runtime acceptance\n'
