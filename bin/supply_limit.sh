#!/bin/bash
set -euo pipefail
cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.."
export ANCHOR_PROVIDER_URL="${ANCHOR_PROVIDER_URL:-https://api.devnet.solana.com}"
# initialize/set must use the current bridge admin, which may differ from the mint operator.
export ANCHOR_WALLET="${ANCHOR_WALLET:-$HOME/.config/solana/devnet.json}"
exec node scripts/supply-limit.cjs "$@"
