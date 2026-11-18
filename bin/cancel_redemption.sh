#!/bin/bash
set -euo pipefail
if (( $# != 1 )); then
  echo "Usage: $0 WITHDRAWAL_ADDRESS" >&2
  exit 1
fi
cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.."
export ANCHOR_PROVIDER_URL="${ANCHOR_PROVIDER_URL:-https://api.devnet.solana.com}"
export ANCHOR_WALLET="${ANCHOR_WALLET:-$HOME/.config/solana/devnet.json}"
exec cargo run -p wgrc-relayer -- cancel-redemption "$1"
