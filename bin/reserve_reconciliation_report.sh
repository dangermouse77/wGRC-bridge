#!/bin/bash
set -euo pipefail

if (( $# > 1 )) || { (( $# == 1 )) && [[ "$1" != --summary ]]; }; then
  echo "Usage: $0 [--summary]" >&2
  exit 1
fi

source "$(dirname -- "${BASH_SOURCE[0]}")/deposit-common.sh"
export WGRC_TESTNET_RESERVE_ADDRESS="$reserve"

cd -- "$script_dir/.."
if [[ ${1:-} != --summary ]]; then
  exec cargo run -p wgrc-relayer -- reconcile-reserve
fi

report="$(cargo run -q -p wgrc-relayer -- reconcile-reserve)"
printf '%s\n' "$report" | node -e '
  const report = JSON.parse(require("node:fs").readFileSync(0, "utf8"));
  const format = (units) => {
    const amount = BigInt(units);
    const whole = (amount / 100_000_000n).toLocaleString("en-US");
    const fraction = (amount % 100_000_000n).toString().padStart(8, "0").replace(/0+$/, "");
    return fraction ? `${whole}.${fraction}` : whole;
  };
  const confirmed = format(report.confirmedReserveBaseUnits);
  const spendable = format(report.spendableReserveBaseUnits);
  const balance = confirmed === spendable
    ? `${confirmed} GRC`
    : `${confirmed} GRC confirmed / ${spendable} GRC spendable`;
  const shortfall = BigInt(report.backingShortfallBaseUnits) > 0n;
  const difference = shortfall ? report.backingShortfallBaseUnits : report.backingSurplusBaseUnits;
  console.log(`Confirmed and spendable reserve\t${balance}`);
  console.log(`Finalized supply\t${format(report.finalizedWgrcSupplyBaseUnits)} wGRC`);
  console.log(`Required backing, including unresolved records\t${format(report.requiredBackingBaseUnits)} GRC`);
  console.log(`Backing ${shortfall ? "shortfall" : "surplus"}\t${format(difference)} GRC`);
'
