#!/bin/bash
export GRC_RPC_USER=dangermouse
export GRC_RPC_PASSWORD=******
export GRC_RPC_URL='http://gridtestnet:25715'
node scripts/gridcoin-deposit.cjs create \
  'mttYZdNgbn3f5767arC4i8CCzncH29z86h' 1.00000000 \
  'FWakmcaVqecEfFbxJKang1KoTp6A6JMJ1LSVygLx1JQC'
