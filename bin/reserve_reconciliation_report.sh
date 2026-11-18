#!/bin/bash
set -euo pipefail

if (( $# != 0 )); then
  echo "Usage: $0" >&2
  exit 1
fi

source "$(dirname -- "${BASH_SOURCE[0]}")/deposit-common.sh"
export WGRC_TESTNET_RESERVE_ADDRESS="$reserve"

cd -- "$script_dir/.."
exec cargo run -p wgrc-relayer -- reconcile-reserve
