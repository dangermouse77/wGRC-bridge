# Shared by the Gridcoin Testnet deposit wrappers.
script_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
reserve="${WGRC_TESTNET_RESERVE_ADDRESS:-${GRC_RESERVE_ADDRESS:-mxaRNFnUR9FwxS1Zp2EeWjwpAJ95g1wdgz}}"

if [[ -z ${GRC_RPC_PASSWORD:-} ]]; then
  read -rsp 'Gridcoin RPC password: ' GRC_RPC_PASSWORD
  echo >&2
fi
export GRC_RPC_PASSWORD
export GRC_RPC_USER="${GRC_RPC_USER:-dangermouse}"
export GRC_RPC_URL="${GRC_RPC_URL:-http://gridtestnet:25715}"

deposit_txid() {
  node -e '
    const fs = require("node:fs");
    try {
      const { txid } = JSON.parse(fs.readFileSync(process.argv[1], "utf8"));
      if (typeof txid !== "string" || !/^[a-f0-9]{64}$/i.test(txid)) {
        throw new Error("missing or invalid txid");
      }
      console.log(txid);
    } catch (error) {
      console.error(`Could not read the saved deposit: ${error.message}`);
      process.exitCode = 1;
    }
  ' -- "$1"
}
