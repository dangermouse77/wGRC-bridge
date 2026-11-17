#gt getblock 66a24dca1a5ba54db3491d9cd0335cce8391295d5381683fde11f42234a25e05 true |
#  jq '{height, confirmations, decoded: (.tx[0] | type)}'


export GRC_RPC_URL=http://gridtestnet:25715
export GRC_RPC_USER=dangermouse
read -rsp 'Gridcoin RPC password: ' GRC_RPC_PASSWORD
echo
export GRC_RPC_PASSWORD
export WGRC_TESTNET_RESERVE_ADDRESS=mxaRNFnUR9FwxS1Zp2EeWjwpAJ95g1wdgz
export WGRC_MIN_CONFIRMATIONS=10

cd ../relayer/

start_height='3339204'
cargo run -p wgrc-relayer -- watch-gridcoin "$start_height" --once