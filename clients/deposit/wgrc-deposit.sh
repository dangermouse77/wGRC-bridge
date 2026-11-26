#!/usr/bin/env bash
set -euo pipefail

root="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/../.." && pwd)"
export WGRC_EXTERNAL_DEPOSIT_CLIENT=1
exec node "$root/scripts/client-deposit.cjs" "$@"
