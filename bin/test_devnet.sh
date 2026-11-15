#!/bin/bash
export ANCHOR_PROVIDER_URL=https://api.devnet.solana.com
export ANCHOR_WALLET="$HOME/.config/solana/devnet.json"
export WGRC_TESTNET_GRIDCOIN_ADDRESS='SHxsNE73QgWLJKKRnK74HDWsPBaZk1gN1M'
npm run test:devnet
