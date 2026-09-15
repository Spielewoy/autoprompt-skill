#!/usr/bin/bash
# Research bootstrap. Never install the generated DLL into the running /usr/bin.
set -Eeuo pipefail
umask 077
build_stage=bootstrap
build_failed() {
  local status=$1 line=$2
  trap - ERR
  printf 'MSYS_BUILD_FAILURE stage=%s line=%s status=%s\n' "$build_stage" "$line" "$status" >&2
  exit "$status"
}
trap 'build_failed "$?" "$LINENO"' ERR
assert_compiler_target() {
  local file=$1 expected=$2
  # Compare exact records: only a single terminal Windows CR is equivalent.
  # Never trim whitespace, additional lines, NULs or a different target.
  if cmp -s "$file" <(printf '%s\n' "$expected"); then
    return 0
  elif cmp -s "$file" <(printf '%s\r\n' "$expected"); then
    printf 'MSYS compiler target uses one terminal CRLF record\n'
    return 0
  fi
  printf 'Unexpected compiler target; expected exactly %q with LF or CRLF\n' "$expected" >&2
  return 1
}
exec > >(tee /issue27-build/bootstrap-output.txt) 2>&1
mode=${1:?}; jobs=${2:?}; epoch=${3:?}; source_sha=${4:?}
compiler_target=${5:?}; configure_build=${6:?}; compiler_sha=${7:?}
[[ $mode == proof || $mode == full ]]
[[ $jobs =~ ^[0-9]+$ && $epoch =~ ^[0-9]+$ && $source_sha =~ ^[a-f0-9]{64}$ ]]
[[ $compiler_target == x86_64-pc-cygwin && $configure_build == x86_64-pc-cygwin && $compiler_sha =~ ^[a-f0-9]{64}$ ]]
export PATH=/usr/bin:/bin
export MSYSTEM=MSYS LC_ALL=C.UTF-8 TZ=UTC SOURCE_DATE_EPOCH=$epoch
export TMPDIR=/issue27-build/tmp
mkdir -p "$TMPDIR"
cd /issue27-build
build_stage=input-digests
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
build_stage=package-install
pacman --config /issue27-build/pacman.conf --noconfirm -U "${archives[@]}"
# Pacman verifies embedded-lock detached signatures and the dependency transaction.
pacman -Q > installed-packages.txt
build_stage=compiler-provenance
printf '%s  /usr/bin/gcc.exe\n' "$compiler_sha" | sha256sum -c -
gcc --version > compiler.txt
ld --version > linker.txt
gcc -dumpmachine > compiler-target.raw.txt
od -An -v -tx1 compiler-target.raw.txt > compiler-target-bytes.txt
printf 'MSYS compiler target bytes: '; cat compiler-target-bytes.txt
printf 'MSYS compiler target quoted: %q\n' "$(cat compiler-target.raw.txt)"
build_stage=compiler-target
assert_compiler_target compiler-target.raw.txt "$compiler_target"
sha256sum -c bootstrap-runtime.sha256
build_stage=source-extract
mkdir source build stage
# Exact archive SHA checked first; no second Cygwin-to-MSYS patch application.
tar -xzf source.tar.gz --strip-components=1 -C source
# This tree sits inside the SDK Git checkout. Give it its own Git root so
# git apply cannot interpret patch paths against the parent SDK repository.
git -C source init
git -C source config core.autocrlf false
git -C source config core.symlinks true
if [[ -f adaptation.patch ]]; then
  build_stage=source-adaptation
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
export CPPFLAGS='' LDFLAGS=''
printf 'CFLAGS=%s\nCXXFLAGS=%s\nCPPFLAGS=%s\nLDFLAGS=%s\n' "$CFLAGS" "$CXXFLAGS" "$CPPFLAGS" "$LDFLAGS" > build-flags.txt
build_stage=autogen
(cd source/winsup && ./autogen.sh)
cd build
options=(--prefix=/usr --build="$configure_build" --sysconfdir=/etc --with-msys2-runtime-commit=270ba2980700e6e2a0813944d506eecea0f86402)
if [[ $mode == proof ]]; then
  options+=(--with-cross-bootstrap --disable-doc --disable-dumper)
fi
build_stage=configure
../source/configure "${options[@]}" 2>&1 | tee configure-output.txt
build_stage=compile
LC_ALL=C make -j"$jobs" 2>&1 | tee make-output.txt
build_stage=stage-install
LC_ALL=C make -j1 DESTDIR=/issue27-build/stage install 2>&1 | tee install-output.txt
cd ..
build_stage=stage-verify
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
