const { connectTestnet, deposit, InvalidDeposit } = require("../scripts/gridcoin-deposit.cjs");

const HASH = /^[a-f0-9]{64}$/;

async function scanBlock(rpc, reserveScript, height, minimum, previousHash) {
  const hashAt = async (at) => {
    const hash = await rpc("getblockhash", at);
    if (!HASH.test(hash)) throw new Error(`Gridcoin returned an invalid hash at height ${at}.`);
    return hash;
  };
  const tip = await rpc("getblockcount");
  if (!Number.isSafeInteger(tip) || tip < 0) throw new Error("Invalid Gridcoin tip height.");
  // A shorter node view can also mean it is still syncing. Wait until the
  // checkpoint height is available before deciding the old hash was orphaned.
  if (previousHash && tip >= height - 1 && await hashAt(height - 1) !== previousHash) {
    return { status: "reorg" };
  }
  if (tip - height + 1 < minimum) return { status: "waiting" };

  const hash = await hashAt(height);
  const block = await rpc("getblock", hash, true);
  if (block?.hash !== hash || block.height !== height || !Number.isSafeInteger(block.confirmations)
      || !Array.isArray(block.tx) || !block.tx.length) {
    throw new Error(`Gridcoin returned unexpected block data at height ${height}.`);
  }
  if (block.confirmations < minimum || (previousHash && block.previousblockhash !== previousHash)) {
    throw new Error(`Gridcoin chain changed while reading block ${height}. Retry the watcher.`);
  }

  const deposits = [];
  for (const tx of block.tx) {
    if (!HASH.test(tx?.txid) || !Array.isArray(tx.vin) || !tx.vin.length || !Array.isArray(tx.vout)
        || !tx.vout.every((output) => typeof output?.scriptPubKey?.hex === "string"
          && typeof output.value === "string")) {
      throw new Error(`Gridcoin returned incomplete decoded transactions at height ${height}.`);
    }
    if (!tx.vout.some((output) => output.scriptPubKey.hex === reserveScript)) continue;
    try {
      deposits.push(deposit(tx, reserveScript));
    } catch (error) {
      if (!(error instanceof InvalidDeposit)) throw error;
    }
  }
  if (await hashAt(height) !== hash) {
    throw new Error(`Gridcoin chain changed while scanning block ${height}. Retry the watcher.`);
  }
  return { status: "block", hash, confirmations: block.confirmations, deposits };
}

async function main() {
  const [reserve, heightArg, minimumArg, previousHash, ...rest] = process.argv.slice(2);
  const height = Number(heightArg);
  const minimum = Number(minimumArg);
  if (!reserve || !/^\d+$/.test(heightArg) || !Number.isSafeInteger(height)
      || !/^\d+$/.test(minimumArg) || !Number.isSafeInteger(minimum) || minimum < 1
      || (previousHash !== "" && (!height || !HASH.test(previousHash))) || rest.length) {
    throw new Error("Expected reserve address, block height, minimum confirmations, and checkpoint hash.");
  }
  const { rpc, script } = await connectTestnet(reserve);
  console.log(JSON.stringify(await scanBlock(rpc, script, height, minimum, previousHash)));
}

module.exports = { scanBlock };
if (require.main === module) {
  main().catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
}
