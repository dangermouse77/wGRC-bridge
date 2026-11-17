#!/bin/bash
set -euo pipefail

if (( $# > 1 )); then
  echo "Usage: $0 [start height]" >&2
  exit 1
fi

source "$(dirname -- "${BASH_SOURCE[0]}")/deposit-common.sh"
export WGRC_TESTNET_RESERVE_ADDRESS="$reserve"
export ANCHOR_PROVIDER_URL="${ANCHOR_PROVIDER_URL:-https://api.devnet.solana.com}"
export ANCHOR_WALLET="${ANCHOR_WALLET:-$HOME/.config/solana/devnet.json}"

start_height="${1:-3339204}"
cd -- "$script_dir/.."
exec cargo run -p wgrc-relayer -- watch-gridcoin "$start_height" --once --mint
