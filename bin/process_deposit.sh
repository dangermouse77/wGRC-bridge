export GRC_RPC_URL=http://gridtestnet:25715
export GRC_RPC_USER='dangermouse'
read -rsp 'Gridcoin RPC password: ' GRC_RPC_PASSWORD
echo
export GRC_RPC_PASSWORD

export WGRC_TESTNET_RESERVE_ADDRESS='FWakmcaVqecEfFbxJKang1KoTp6A6JMJ1LSVygLx1JQC'
export ANCHOR_PROVIDER_URL=https://api.devnet.solana.com
export ANCHOR_WALLET=':~/.config/solana/devnet.json'

cd ..
cargo run -p wgrc-relayer -- process-deposit \
  448bd13d7db71908372e30bb40f98134506810637339161bbbf34415499bf76e
