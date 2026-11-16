#!/bin/bash
set -euo pipefail

if [[ $# -ne 1 ]]; then
  echo "Usage: $0 AMOUNT_WGRC" >&2
  exit 1
fi

wallet="${ANCHOR_WALLET:-$HOME/.config/solana/devnet.json}"
owner='FWakmcaVqecEfFbxJKang1KoTp6A6JMJ1LSVygLx1JQC'
# Associated token account for the recipient and the Devnet wGRC mint.
token_account='9BPhbnYfAacZC61gfgEcN6X5y1YFf6rAkc1FVsfRPKhx'

if [[ "$(solana-keygen pubkey "$wallet")" != "$owner" ]]; then
  echo "Set ANCHOR_WALLET to the Devnet keypair for $owner." >&2
  exit 1
fi

exec spl-token --url devnet --fee-payer "$wallet" \
  burn "$token_account" "$1" --owner "$wallet"
