#!/bin/bash
set -euo pipefail
WGRC_RPC_ROLE=funding source "$(dirname -- "${BASH_SOURCE[0]}")/deposit-common.sh"

exec node "$script_dir/../scripts/gridcoin-deposit.cjs" broadcast "$reserve" "$script_dir/deposit.json"
