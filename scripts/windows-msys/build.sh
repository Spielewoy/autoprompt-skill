#!/usr/bin/bash
# Research bootstrap. Never install the generated DLL into the running /usr/bin.
set -euo pipefail
umask 077
mode=${1:?}; jobs=${2:?}; epoch=${3:?}; source_sha=${4:?}
[[ $mode == proof || $mode == full ]]
[[ $jobs =~ ^[0-9]+$ && $epoch =~ ^[0-9]+$ && $source_sha =~ ^[a-f0-9]{64}$ ]]
export PATH=/usr/bin:/bin
export MSYSTEM=MSYS LC_ALL=C.UTF-8 TZ=UTC SOURCE_DATE_EPOCH=$epoch
export TMPDIR=/issue27-build/tmp
mkdir -p "$TMPDIR"
cd /issue27-build
printf '%s  source.tar.gz\n' "$source_sha" | sha256sum -c -
sha256sum -c archives.sha256
sha256sum /usr/bin/msys-2.0.dll > bootstrap-runtime.sha256
# No repository entries: never solve a dependency by downloading an unpinned package.
cat > pacman.conf <<'EOF'
[options]
Architecture = x86_64
SigLevel = Required
LocalFileSigLevel = Required
EOF
shopt -s nullglob
archives=(/issue27-build/archives/*.pkg.tar.zst /issue27-build/archives/*.pkg.tar.xz)
((${#archives[@]} > 0))
pacman --config /issue27-build/pacman.conf --noconfirm -U "${archives[@]}"
# Pacman verifies embedded-lock detached signatures and the dependency transaction.
pacman -Q > installed-packages.txt
[[ $(gcc -dumpmachine) == x86_64-pc-msys ]]
gcc --version > compiler.txt
ld --version > linker.txt
sha256sum -c bootstrap-runtime.sha256
mkdir source build stage
# Exact archive SHA checked first; no second Cygwin-to-MSYS patch application.
tar -xzf source.tar.gz --strip-components=1 -C source
# This tree sits inside the SDK Git checkout. Give it its own Git root so
# git apply cannot interpret patch paths against the parent SDK repository.
git -C source init
git -C source config core.autocrlf false
git -C source config core.symlinks true
if [[ -f adaptation.patch ]]; then
  sha256sum -c adaptation.sha256
  (cd source && git apply --check ../adaptation.patch && git apply ../adaptation.patch)
fi
# The upstream GfW recipe uses an awk locale shim. Keep it inside this owned tree.
mkdir build-tools
for tool in awk gawk; do
  printf '#!/usr/bin/bash\nLC_ALL=C.UTF-8 exec /usr/bin/%s.exe "$@"\n' "$tool" > "build-tools/$tool"
  chmod 700 "build-tools/$tool"
done
export PATH=/issue27-build/build-tools:/usr/bin:/bin
export CFLAGS='-O2 -pipe -g0 -DCYGPORT_RELEASE_INFO=3.6.10'
export CXXFLAGS='-O2 -pipe -g0'
(cd source/winsup && ./autogen.sh)
cd build
options=(--prefix=/usr --build=x86_64-pc-msys --sysconfdir=/etc --with-msys2-runtime-commit=270ba2980700e6e2a0813944d506eecea0f86402)
if [[ $mode == proof ]]; then
  options+=(--with-cross-bootstrap --disable-doc --disable-dumper)
fi
../source/configure "${options[@]}" 2>&1 | tee configure-output.txt
LC_ALL=C make -j"$jobs" 2>&1 | tee make-output.txt
LC_ALL=C make -j1 DESTDIR=/issue27-build/stage install 2>&1 | tee install-output.txt
cd ..
# A compiler proof emits original unstripped staged output; packaging is separate.
[[ -s stage/usr/bin/msys-2.0.dll ]]
sha256sum -c bootstrap-runtime.sha256
mkdir -p stage/source-notices
for item in COPYING COPYING3 COPYING.LIB COPYING.NEWLIB COPYING.LIBGLOSS winsup/COPYING winsup/COPYING.LIB winsup/CYGWIN_LICENSE winsup/CONTRIBUTORS; do
  if [[ -f source/$item ]]; then
    mkdir -p "stage/source-notices/$(dirname "$item")"
    cp "source/$item" "stage/source-notices/$item"
  fi
done
cp lock.json compiler.txt linker.txt installed-packages.txt stage/
find stage -type f -print0 | sort -z | xargs -0 sha256sum > stage.sha256
