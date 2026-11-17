#!/bin/bash
set -euo pipefail

# gt getblock 66a24dca1a5ba54db3491d9cd0335cce8391295d5381683fde11f42234a25e05 true |
#  jq '{height, confirmations, decoded: (.tx[0] | type)}'

source "$(dirname -- "${BASH_SOURCE[0]}")/deposit-common.sh"
export WGRC_TESTNET_RESERVE_ADDRESS="$reserve"

start_height='3339204'
cd -- "$script_dir/.."
exec cargo run -p wgrc-relayer -- watch-gridcoin "$start_height" --once
