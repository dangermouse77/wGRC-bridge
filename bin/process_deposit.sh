#!/bin/bash
set -euo pipefail

source "$(dirname -- "${BASH_SOURCE[0]}")/deposit-common.sh"

export WGRC_TESTNET_RESERVE_ADDRESS="$reserve"
export ANCHOR_PROVIDER_URL="${ANCHOR_PROVIDER_URL:-https://api.devnet.solana.com}"
export ANCHOR_WALLET="${ANCHOR_WALLET:-$HOME/.config/solana/devnet.json}"

txid="$(deposit_txid "$script_dir/deposit.json")"
cd -- "$script_dir/.."
exec cargo run -p wgrc-relayer -- process-deposit "$txid"
