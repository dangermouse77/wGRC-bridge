#!/bin/bash
if [[ -z ${GRC_RPC_PASSWORD:-} ]]; then
  cat >&2 <<'EOF'
Set GRC_RPC_PASSWORD in your current shell, then rerun this script:
  read -rsp 'Gridcoin RPC password: ' GRC_RPC_PASSWORD; echo
  export GRC_RPC_PASSWORD
EOF
  exit 1
fi

export GRC_RPC_USER=dangermouse
export GRC_RPC_URL='http://gridtestnet:25715'
node ../scripts/gridcoin-deposit.cjs create \
  'mttYZdNgbn3f5767arC4i8CCzncH29z86h' 1.00000000 \
  'FWakmcaVqecEfFbxJKang1KoTp6A6JMJ1LSVygLx1JQC' > deposit.json

cat ./deposit.json
