#!/bin/bash
set -euo pipefail

cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.."
exec cargo run -p wgrc-relayer -- watch-solana --once
