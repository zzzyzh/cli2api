#!/usr/bin/env bash
set -euo pipefail

CLI2API_ROOT="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
cd "$CLI2API_ROOT"
if ! command -v node >/dev/null 2>&1; then
  echo "需要 Node.js >= 20。" >&2
  exit 1
fi
if [[ ! -f node_modules/tsx/package.json ]]; then
  npm ci --include=dev --no-audit --no-fund
fi
exec node --import tsx "$CLI2API_ROOT/src/export.ts" "$@"
