const assert = require("node:assert/strict");

async function reserveBalance(rpc, reserve, baseUnits) {
  assert.equal(reserve.address.ismine, true, "Reserve balance requires the reserve wallet RPC.");
  const tip = await rpc("getbestblockhash");
  const outputs = await rpc("listunspent", 1, 9999999, [reserve.address.address]);
  assert.ok(Array.isArray(outputs), "Expected reserve unspent outputs.");
  let total = 0n;
  const seen = new Set();
  for (const output of outputs) {
    if (output.scriptPubKey !== reserve.script) continue;
    assert.ok(Number.isSafeInteger(output.confirmations) && output.confirmations >= 1,
      "Expected confirmed reserve outputs.");
    const key = `${output.txid}:${output.vout}`;
    assert.ok(!seen.has(key), "Duplicate reserve output.");
    seen.add(key);
    total += baseUnits(output.amount);
  }
  assert.equal(await rpc("getbestblockhash"), tip, "Gridcoin tip changed during reserve balance inspection. Retry.");
  return total;
}

function coverageLabel(reserve, supply, decimals) {
  return reserve * 10n ** BigInt(decimals) >= supply * 100000000n ? "Covered" : "!! Uncovered !!";
}
module.exports = { reserveBalance, coverageLabel };
