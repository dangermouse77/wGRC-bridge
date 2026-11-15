#!/bin/bash
export ANCHOR_PROVIDER_URL=https://api.devnet.solana.com
export ANCHOR_WALLET="$HOME/.config/solana/devnet.json"

npm install
node ../scripts/create-token-metadata.cjs \
  'https://raw.githubusercontent.com/dangermouse77/wGRC-bridge/refs/heads/main/metadata/wgrc.json'
