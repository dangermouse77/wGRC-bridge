#!/bin/bash
set -euo pipefail

# gt getblock 66a24dca1a5ba54db3491d9cd0335cce8391295d5381683fde11f42234a25e05 true |
#  jq '{height, confirmations, decoded: (.tx[0] | type)}'

source "$(dirname -- "${BASH_SOURCE[0]}")/deposit-common.sh"
export WGRC_TESTNET_RESERVE_ADDRESS="$reserve"

start_height='3339204'
cd -- "$script_dir/.."
exec cargo run -p wgrc-relayer -- watch-gridcoin "$start_height" --once

# test with
# SELECT d.block_height, b.block_hash, d.txid, d.vout,
#        d.amount_base_units, d.confirmations_at_scan, b.scanned_at
# FROM wgrc.gridcoin_deposit_discoveries AS d
# JOIN wgrc.gridcoin_blocks AS b
#   ON b.reserve_address = d.reserve_address AND b.height = d.block_height
# WHERE d.txid = 'e7ceb7bbde19f07a1c537050da1638899b725c0c077269fb1fe41545a39e41ec'
#   AND d.reserve_address = 'mxaRNFnUR9FwxS1Zp2EeWjwpAJ95g1wdgz';
