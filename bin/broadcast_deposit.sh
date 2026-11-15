#!/bin/bash
if [[ -z ${GRC_RPC_PASSWORD:-} ]]; then

  read -rsp 'Gridcoin RPC password: ' GRC_RPC_PASSWORD; echo
  export GRC_RPC_PASSWORD

fi

export GRC_RPC_USER=dangermouse
export GRC_RPC_URL='http://gridtestnet:25715'


reserve='mttYZdNgbn3f5767arC4i8CCzncH29z86h'
node ../scripts/gridcoin-deposit.cjs broadcast "$reserve" ./deposit.json
