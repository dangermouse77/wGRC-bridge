# Shared by the Gridcoin Testnet deposit wrappers.
script_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
reserve="${WGRC_TESTNET_RESERVE_ADDRESS:-${GRC_RESERVE_ADDRESS:-}}"
if [[ -z "$reserve" ]]; then
  reserve="$(node -e '
    const fs = require("node:fs");
    const [config, example] = process.argv.slice(1);
    try {
      let address;
      try {
        ({ gridcoin_deposit_address: address } = JSON.parse(fs.readFileSync(config, "utf8")));
      } catch (error) {
        if (error.code !== "ENOENT") throw error;
      }
      address ??= JSON.parse(fs.readFileSync(example, "utf8")).gridcoin_deposit_address;
      if (typeof address !== "string" || !address) throw new Error("Missing Gridcoin deposit address.");
      console.log(address);
    } catch {
      console.error("Could not read the Gridcoin deposit address from " + config);
      process.exitCode = 1;
    }
  ' -- "$script_dir/../relayer/bridge.dev.json" "$script_dir/../relayer/bridge.dev.example.json")"
fi

if [[ ${WGRC_RPC_ROLE:-bridge} == bridge ]]; then
  GRC_RPC_URL="$(node "$script_dir/../scripts/bridge-rpc-config.cjs" GRC_RPC_URL)" || exit 1
  GRC_RPC_USER="$(node "$script_dir/../scripts/bridge-rpc-config.cjs" GRC_RPC_USER)" || exit 1
  GRC_RPC_PASSWORD="$(node "$script_dir/../scripts/bridge-rpc-config.cjs" GRC_RPC_PASSWORD)" || exit 1
fi
if [[ -z ${GRC_RPC_PASSWORD:-} ]]; then
  if [[ ! -t 0 ]]; then echo 'Configure the RPC password for noninteractive operation.' >&2; exit 1; fi
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
