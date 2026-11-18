function formatUnits(amount) {
  const digits = amount.toString().padStart(9, "0");
  const fraction = digits.slice(-8).replace(/0+$/, "");
  return digits.slice(0, -8) + (fraction ? `.${fraction}` : "");
}

function report(state) {
  const remaining = state.maximum > state.supply ? state.maximum - state.supply : 0n;
  return {
    network: "Solana Devnet / Gridcoin Testnet",
    finalizedSlot: state.slot,
    program: state.program, bridge: state.bridge, mint: state.mint,
    supplyLimit: state.supplyLimit, admin: state.admin, mintOperator: state.mintOperator,
    paused: state.paused,
    mintingStatus: state.paused ? "paused" : remaining === 0n ? "at_capacity" : "capacity_available",
    outstandingWgrc: formatUnits(state.supply),
    maximumWgrc: formatUnits(state.maximum),
    remainingCapacityWgrc: formatUnits(remaining),
    daemonHealth: "not_checked",
    reserveBacking: "not_checked",
  };
}

module.exports = { formatUnits, report };
if (require.main === module) require("./supply-limit.cjs").readLimit()
  .then((state) => console.log(JSON.stringify(report(state), null, 2)))
  .catch((error) => { console.error(error.message); process.exitCode = 1; });
