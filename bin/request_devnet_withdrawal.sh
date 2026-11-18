#!/bin/bash
set -euo pipefail

if (( $# != 2 )); then
  echo "Usage: $0 GRIDCOIN_TESTNET_ADDRESS AMOUNT_WGRC" >&2
  exit 1
fi

source "$(dirname -- "${BASH_SOURCE[0]}")/deposit-common.sh"
if [[ "$1" == "$reserve" ]]; then
  echo "Use a Gridcoin Testnet payout address outside the bridge reserve." >&2
  exit 1
fi

export ANCHOR_PROVIDER_URL="${ANCHOR_PROVIDER_URL:-https://api.devnet.solana.com}"
export ANCHOR_WALLET="${ANCHOR_WALLET:-$HOME/.config/solana/devnet.json}"

cd -- "$script_dir/.."
exec node scripts/request-devnet-withdrawal.cjs "$1" "$2"
