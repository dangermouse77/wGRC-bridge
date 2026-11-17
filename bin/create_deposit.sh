#!/bin/bash
set -euo pipefail
source "$(dirname -- "${BASH_SOURCE[0]}")/deposit-common.sh"

deposit="$(node "$script_dir/../scripts/gridcoin-deposit.cjs" create \
  "$reserve" 2.00000000 'FWakmcaVqecEfFbxJKang1KoTp6A6JMJ1LSVygLx1JQC')"
printf '%s\n' "$deposit" | tee "$script_dir/deposit.json"
