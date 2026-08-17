#!/usr/bin/env bash
set -euo pipefail

fail() {
  printf 'Error: %s\n' "$1" >&2
  exit 1
}

command -v node >/dev/null 2>&1 || fail 'Node.js 20 or newer is required: https://nodejs.org/en/download'
command -v npm >/dev/null 2>&1 || fail 'npm is required: https://nodejs.org/en/download'
command -v python >/dev/null 2>&1 || fail 'Python 3.11 or newer is required: https://www.python.org/downloads/'

node_major="$(node -p "Number(process.versions.node.split('.')[0])")"
[[ "$node_major" =~ ^[0-9]+$ ]] || fail 'Could not read the Node.js version.'
(( node_major >= 20 )) || fail "Node.js 20 or newer is required. Found $(node --version)."

(( BASH_VERSINFO[0] > 4 || (BASH_VERSINFO[0] == 4 && BASH_VERSINFO[1] >= 3) )) || \
  fail "Bash 4.3 or newer is required. Found ${BASH_VERSION}."

python -c 'import sys, yaml; assert sys.version_info >= (3, 11)' >/dev/null 2>&1 || \
  fail 'Python 3.11 or newer with PyYAML is required. Run: python -m pip install PyYAML'

script_directory="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)"
shopt -s nullglob
bundled=("$script_directory"/autoprompt-skill-*.tgz)
shopt -u nullglob
(( ${#bundled[@]} <= 1 )) || fail 'The release kit contains more than one npm archive.'
package='autoprompt-skill'
if (( ${#bundled[@]} == 1 )); then
  package="${bundled[0]}"
fi

printf 'Installing Autoprompt skill from %s\n' "$package"
npm install --global --ignore-scripts --no-audit --no-fund "$package"

if ! command -v autoprompt >/dev/null 2>&1; then
  printf 'Installed successfully. Open a new terminal, then run: autoprompt\n'
  exit 0
fi

printf 'Installed Autoprompt skill %s.\n' "$(autoprompt version)"
if [[ "${AUTOPROMPT_NO_LAUNCH:-0}" != '1' && -t 0 && -t 1 ]]; then
  exec autoprompt
fi
printf 'Run autoprompt to open the provider installer.\n'
