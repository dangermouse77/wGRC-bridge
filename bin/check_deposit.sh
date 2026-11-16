#!/bin/bash
set -euo pipefail

if (( $# > 2 )); then
  echo 'Usage: bash bin/check_deposit.sh [deposit.json] [minimum confirmations]' >&2
  exit 1
fi
source "$(dirname -- "${BASH_SOURCE[0]}")/deposit-common.sh"

deposit_file="${1:-$script_dir/deposit.json}"
minimum="${2:-${WGRC_MIN_CONFIRMATIONS:-$(<"$script_dir/../relayer/gridcoin-min-confirmations.txt")}}"
txid="$(deposit_txid "$deposit_file")"

exec node "$script_dir/../scripts/gridcoin-deposit.cjs" check "$reserve" "$txid" "$minimum"
