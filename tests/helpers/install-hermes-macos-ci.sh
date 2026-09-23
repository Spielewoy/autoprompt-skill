#!/usr/bin/env bash
# Acquire Hermes 0.21.1 through its upstream macOS installer, with every
# persistent installer location rooted in the caller-provided private directory.
set -euo pipefail

commit='2237be355906fbe6065ce1815711eee52b2d646e'
archive_sha256='9ba535365d459300692a4275f28f4ca716770372eac8f9296a6733669d3c9cd7'
installer_sha256='5854b15670b51a8daae8f59ddfa917062de9f74be261eb73b4b8d719710f8968'
pyproject_sha256='1f0d8d7e9e19c3a1cc25521a5cf56f3c885e4604d3081246cd42d9924a983174'

if [ "$(uname -s)" != Darwin ]; then
  printf '%s\n' 'The official Hermes macOS installer probe requires macOS.' >&2
  exit 1
fi
if [ "$#" -ne 1 ]; then
  printf 'usage: %s OUTPUT_ROOT\n' "$0" >&2
  exit 64
fi

requested_root=$1
if [ -e "$requested_root" ] || [ -L "$requested_root" ]; then
  [ ! -L "$requested_root" ] && [ -d "$requested_root" ] || {
    printf '%s\n' 'Hermes evidence output root is linked or invalid.' >&2
    exit 1
  }
  [ -z "$(find "$requested_root" -mindepth 1 -maxdepth 1 -print -quit)" ] || {
    printf '%s\n' 'Hermes evidence output root must be empty.' >&2
    exit 1
  }
else
  mkdir -m 700 -p "$requested_root"
fi
output_root=$(cd "$requested_root" && pwd -P)
[ ! -L "$output_root" ] || { printf '%s\n' 'Hermes evidence output root resolves through a link.' >&2; exit 1; }

archive="$output_root/hermes-agent-0.21.1.zip"
source_parent="$output_root/source"
user_home="$output_root/user-home"
hermes_home="$output_root/hermes-home"
install_root="$hermes_home/hermes-agent"
uv_python_root="$hermes_home/uv-python"
uv_bin_root="$hermes_home/uv-bin"
cache_root="$output_root/uv-cache"
tmp_root="$output_root/tmp"
rustup_root="$output_root/rustup"
cargo_root="$output_root/cargo"
installer_log="$output_root/official-installer.log"
evidence="$output_root/hermes-macos-acquisition.json"
url="https://github.com/NousResearch/hermes-agent/archive/$commit.zip"
rust_toolchain='1.83.0'

mkdir -m 700 -p "$source_parent" "$user_home/.local/bin" "$hermes_home" "$uv_python_root" "$uv_bin_root" "$cache_root" "$tmp_root" "$rustup_root" "$cargo_root"

# The archive is the source identity. The installer still performs its normal
# managed uv, Python, venv, dependency, and launcher installation below.
curl --fail --location --silent --show-error --retry 3 --retry-all-errors \
  --connect-timeout 20 --max-time 300 "$url" --output "$archive"
[ "$(shasum -a 256 "$archive" | awk '{print $1}')" = "$archive_sha256" ] || {
  printf '%s\n' 'Pinned Hermes source archive hash changed.' >&2
  exit 1
}
unzip -q "$archive" -d "$source_parent"
source_root="$source_parent/hermes-agent-$commit"
[ -d "$source_root" ] && [ ! -L "$source_root" ] || {
  printf '%s\n' 'Pinned Hermes archive has an unexpected source root.' >&2
  exit 1
}
installer="$source_root/scripts/install.sh"
pyproject="$source_root/pyproject.toml"
[ "$(shasum -a 256 "$installer" | awk '{print $1}')" = "$installer_sha256" ] || {
  printf '%s\n' 'Pinned Hermes macOS installer source hash changed.' >&2
  exit 1
}
[ "$(shasum -a 256 "$pyproject" | awk '{print $1}')" = "$pyproject_sha256" ] || {
  printf '%s\n' 'Pinned Hermes pyproject source hash changed.' >&2
  exit 1
}
grep -qx 'version = "0.21.1"' "$pyproject" || {
  printf '%s\n' 'Pinned Hermes source is not version 0.21.1.' >&2
  exit 1
}

# install.sh updates an existing checkout before applying --commit. Seed a
# clean repository from the verified archive so that first checkout bytes are
# known and line-ending settings cannot change tracked files.
cp -R "$source_root" "$install_root"
git -C "$install_root" -c core.autocrlf=false init -q
git -C "$install_root" -c core.autocrlf=false config --local core.autocrlf false
git -C "$install_root" -c core.autocrlf=false remote add origin https://github.com/NousResearch/hermes-agent.git
git -C "$install_root" -c core.autocrlf=false fetch --depth 1 origin "$commit"
git -C "$install_root" -c core.autocrlf=false checkout --force --detach -q FETCH_HEAD
[ "$(git -C "$install_root" rev-parse HEAD)" = "$commit" ] || {
  printf '%s\n' 'Pinned Hermes archive checkout did not resolve the requested commit.' >&2
  exit 1
}
test -z "$(git -C "$install_root" status --porcelain)" || {
  printf '%s\n' 'Pinned Hermes archive checkout is not clean before the official installer.' >&2
  exit 1
}

# Keep all user-scoped uv, Python, cache, temp, shell-startup, and Hermes state
# below OUTPUT_ROOT. PATH already contains the private launcher destination, so
# the official installer never needs to amend a host shell profile.
if [ "$(uname -m)" = x86_64 ]; then
  rustup_command=$(command -v rustup || true)
  [ -n "$rustup_command" ] && [ -x "$rustup_command" ] || {
    printf '%s\n' 'The x64 Hermes dependency build requires the runner Rustup bootstrap.' >&2
    exit 1
  }
  rustup_directory=$(cd -P "$(dirname "$rustup_command")" && pwd)
  rustup_command="$rustup_directory/$(basename "$rustup_command")"
fi
(
  unset PYTHONHOME PYTHONPATH UV_PYTHON UV_CONFIG_FILE HERMES_INSTALL_DIR
  export HOME="$user_home"
  export HERMES_HOME="$hermes_home"
  export UV_PYTHON_INSTALL_DIR="$uv_python_root"
  export UV_PYTHON_BIN_DIR="$uv_bin_root"
  # The official installer asks its managed uv to find Python 3.11 before it
  # creates the venv. `only-managed` makes that lookup install into the
  # explicitly private UV_PYTHON_INSTALL_DIR instead of adopting a runner
  # Python whose venv symlink would escape OUTPUT_ROOT.
  export UV_PYTHON_PREFERENCE=only-managed
  export UV_CACHE_DIR="$cache_root"
  export XDG_CACHE_HOME="$cache_root/xdg"
  export XDG_CONFIG_HOME="$output_root/xdg-config"
  export XDG_DATA_HOME="$output_root/xdg-data"
  export TMPDIR="$tmp_root"
  export PATH="$user_home/.local/bin:$PATH"
  export GIT_CONFIG_NOSYSTEM=1
  export GIT_CONFIG_GLOBAL=/dev/null
  export GIT_TERMINAL_PROMPT=0
  if [ "$(uname -m)" = x86_64 ]; then
    # Hermes 0.21.1's locked cryptography 50.0.0 has an ARM macOS wheel but
    # no x64 macOS wheel. Its source declares Rust 1.83.0 as the MSRV. Keep
    # the required compiler, toolchain metadata, and Cargo cache private.
    export RUSTUP_HOME="$rustup_root"
    export CARGO_HOME="$cargo_root"
    "$rustup_command" toolchain install "$rust_toolchain" --profile minimal
    "$rustup_command" default "$rust_toolchain"
    export RUSTUP_TOOLCHAIN="$rust_toolchain"
    export PATH="$cargo_root/bin:$user_home/.local/bin:$PATH"
    rustc_path=$("$rustup_command" which rustc)
    case "$rustc_path" in "$rustup_root"/toolchains/*/bin/rustc) ;; *)
      printf '%s\n' 'Private Rustup did not select a private Rust compiler.' >&2; exit 1;;
    esac
    "$rustc_path" --version | grep -q '^rustc 1\.83\.0 ' || {
      printf '%s\n' 'Private Rust compiler version differs from cryptography 50.0.0 MSRV.' >&2; exit 1
    }
  fi
  bash "$installer" --commit "$commit" --force-commit --hermes-home "$hermes_home" \
    --dir "$install_root" --non-interactive --skip-setup --skip-browser \
    --skip-computer-use --no-skills
) 2>&1 | tee "$installer_log"

public_launcher="$user_home/.local/bin/hermes"
venv_python="$install_root/venv/bin/python"
for file in "$public_launcher" "$install_root/hermes" "$hermes_home/bin/uv"; do
  [ -f "$file" ] && [ -x "$file" ] && [ ! -L "$file" ] || {
    printf 'Hermes installer omitted a regular executable: %s\n' "$file" >&2
    exit 1
  }
done
[ -f "$venv_python" ] && [ -x "$venv_python" ] || {
  printf 'Hermes installer omitted its venv interpreter: %s\n' "$venv_python" >&2
  exit 1
}
[ "$(git -C "$install_root" rev-parse HEAD)" = "$commit" ] || {
  printf '%s\n' 'Hermes installer checkout differs from the pinned release commit.' >&2
  exit 1
}
git -C "$install_root" diff --quiet || {
  printf '%s\n' 'Hermes installer changed a tracked source file.' >&2
  exit 1
}

python_physical=$("$venv_python" -c 'import os, sys; print(os.path.realpath(sys.executable))')
case "$python_physical" in "$output_root"/*) ;; *)
  printf '%s\n' 'Hermes venv resolves outside the private acquisition root.' >&2
  exit 1
esac
"$venv_python" - <<'PY'
import importlib.metadata as metadata
import sys
assert sys.version_info[:2] == (3, 11), sys.version
assert metadata.version('hermes-agent') == '0.21.1'
assert metadata.version('boto3') == '1.42.89'
assert metadata.version('botocore') == '1.42.89'
import boto3  # noqa: F401
import botocore  # noqa: F401
PY
cli_version=$("$public_launcher" --version 2>&1)
[ -n "$cli_version" ] || { printf '%s\n' 'Hermes public launcher produced no version output.' >&2; exit 1; }

export HERMES_MACOS_COMMIT="$commit"
export HERMES_MACOS_ARCHIVE_SHA256="$archive_sha256"
export HERMES_MACOS_INSTALLER_SHA256="$installer_sha256"
export HERMES_MACOS_PYPROJECT_SHA256="$pyproject_sha256"
export HERMES_MACOS_SOURCE_ROOT="$source_root"
export HERMES_MACOS_HOME="$hermes_home"
export HERMES_MACOS_INSTALL_ROOT="$install_root"
export HERMES_MACOS_CLI="$public_launcher"
export HERMES_MACOS_PYTHON="$venv_python"
export HERMES_MACOS_PYTHON_PHYSICAL="$python_physical"
export HERMES_MACOS_INSTALLER_LOG="$installer_log"
export HERMES_MACOS_CLI_VERSION_SHA256="$(printf '%s' "$cli_version" | shasum -a 256 | awk '{print $1}')"
"$venv_python" - "$evidence" <<'PY'
import importlib.metadata as metadata
import json
import os
import platform
import subprocess
import sys
import sysconfig

keys = ('COMMIT', 'ARCHIVE_SHA256', 'INSTALLER_SHA256', 'PYPROJECT_SHA256',
        'SOURCE_ROOT', 'HOME', 'INSTALL_ROOT', 'CLI', 'PYTHON',
        'PYTHON_PHYSICAL', 'INSTALLER_LOG', 'CLI_VERSION_SHA256')
expected_arch = os.environ.get('AUTOPROMPT_CI_EXPECTED_ARCH')
assert expected_arch in {'x64', 'arm64'}, 'Expected native Python architecture is required'
assert platform.machine() == {'x64': 'x86_64', 'arm64': 'arm64'}[expected_arch], 'Hermes Python runs under the wrong architecture'
data = {key.lower(): os.environ['HERMES_MACOS_' + key] for key in keys}
data.update(schemaVersion=1, provider='hermes', platform=sys.platform,
            architecture=platform.machine(), python=sys.version,
            hermesVersion=metadata.version('hermes-agent'),
            boto3=metadata.version('boto3'), botocore=metadata.version('botocore'),
            lockedBotocore='1.42.89',
            linuxFixtureCacheBotocoreObserved='1.42.97')
load_commands = subprocess.run(['/usr/bin/otool', '-L', os.environ['HERMES_MACOS_PYTHON_PHYSICAL']],
                              check=True, capture_output=True, text=True, timeout=30)
assert len(load_commands.stdout.encode('utf-8')) <= 65536, 'Unexpectedly large interpreter dependency inventory'
data['pythonRuntime'] = {'executable': sys.executable, 'basePrefix': sys.base_prefix,
                         'prefix': sys.prefix, 'sysconfigPaths': sysconfig.get_paths(),
                         'libraryDirectory': sysconfig.get_config_var('LIBDIR'),
                         'sharedLibrary': sysconfig.get_config_var('LDLIBRARY'),
                         'interpreterLoadCommands': load_commands.stdout}
with open(sys.argv[1], 'x', encoding='utf-8') as handle:
    json.dump(data, handle, sort_keys=True, indent=2)
    handle.write('\n')
PY

if [ -n "${GITHUB_ENV:-}" ]; then
  {
    printf 'AUTOPROMPT_HERMES_TEST_CLI=%s\n' "$public_launcher"
    printf 'AUTOPROMPT_HERMES_MACOS_HOME=%s\n' "$hermes_home"
    printf 'AUTOPROMPT_HERMES_MACOS_INSTALL_ROOT=%s\n' "$install_root"
    printf 'AUTOPROMPT_HERMES_MACOS_PYTHON=%s\n' "$venv_python"
    printf 'AUTOPROMPT_HERMES_MACOS_INSTALLER_LOG=%s\n' "$installer_log"
  } >> "$GITHUB_ENV"
fi
cat "$evidence"
