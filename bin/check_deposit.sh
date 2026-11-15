#!/bin/bash
set -euo pipefail

if (( $# > 2 )); then
  echo 'Usage: bash bin/check_deposit.sh [deposit.json] [minimum confirmations]' >&2
  exit 1
fi
if [[ -z ${GRC_RPC_PASSWORD:-} ]]; then
  read -rsp 'Gridcoin RPC password: ' GRC_RPC_PASSWORD
  echo >&2
fi
export GRC_RPC_PASSWORD
export GRC_RPC_USER="${GRC_RPC_USER:-dangermouse}"
export GRC_RPC_URL="${GRC_RPC_URL:-http://gridtestnet:25715}"

script_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
deposit_file="${1:-$script_dir/deposit.json}"
minimum="${2:-6}"
reserve="${GRC_RESERVE_ADDRESS:-mttYZdNgbn3f5767arC4i8CCzncH29z86h}"

txid="$(node -e '
  const fs = require("node:fs");
  try {
    const { txid } = JSON.parse(fs.readFileSync(process.argv[1], "utf8"));
    if (typeof txid !== "string" || !/^[a-f0-9]{64}$/i.test(txid)) {
      throw new Error("missing or invalid txid");
    }
    console.log(txid);
  } catch (error) {
    console.error(`Could not read the saved deposit: ${error.message}`);
    process.exitCode = 1;
  }
' -- "$deposit_file")"

exec node "$script_dir/../scripts/gridcoin-deposit.cjs" check "$reserve" "$txid" "$minimum"
