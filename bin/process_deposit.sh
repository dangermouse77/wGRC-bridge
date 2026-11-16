#!/bin/bash
set -euo pipefail

export GRC_RPC_URL="${GRC_RPC_URL:-http://gridtestnet:25715}"
export GRC_RPC_USER="${GRC_RPC_USER:-dangermouse}"
if [[ -z ${GRC_RPC_PASSWORD:-} ]]; then
  read -rsp 'Gridcoin RPC password: ' GRC_RPC_PASSWORD
  echo >&2
fi
export GRC_RPC_PASSWORD

export WGRC_TESTNET_RESERVE_ADDRESS="${WGRC_TESTNET_RESERVE_ADDRESS:-${GRC_RESERVE_ADDRESS:-mttYZdNgbn3f5767arC4i8CCzncH29z86h}}"
export ANCHOR_PROVIDER_URL="${ANCHOR_PROVIDER_URL:-https://api.devnet.solana.com}"
export ANCHOR_WALLET="${ANCHOR_WALLET:-$HOME/.config/solana/devnet.json}"

cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.."
exec cargo run -p wgrc-relayer -- process-deposit \
  448bd13d7db71908372e30bb40f98134506810637339161bbbf34415499bf76e
