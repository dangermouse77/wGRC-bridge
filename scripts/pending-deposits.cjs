const assert = require("node:assert/strict");

// Compare the exact deposit outpoint, not the wallet's total GRC balance.
async function pendingDeposits(rpc, reserve, receipts, decode, InvalidDeposit) {
  assert.equal(reserve.address.ismine, true, "Pending deposits require the Gridcoin reserve wallet RPC.");
  const tip = await rpc("getbestblockhash");
  const outputs = await rpc("listunspent", 0, 9999999, [reserve.address.address]);
  assert.ok(Array.isArray(outputs), "Expected reserve wallet unspent outputs.");
  const seen = new Set();
  const sources = new Map();
  let total = 0n;
  let count = 0;
  for (const output of outputs) {
    if (output.scriptPubKey !== reserve.script) continue;
    const key = `${output.txid}:${output.vout}`;
    assert.ok(!seen.has(key), "Duplicate unspent output returned by Gridcoin.");
    seen.add(key);
    if (!sources.has(output.txid)) {
      const tx = await rpc("getrawtransaction", output.txid, true);
      assert.equal(tx.txid, output.txid, "Gridcoin returned a different deposit transaction.");
      sources.set(output.txid, tx);
    }
    const tx = sources.get(output.txid);
    if ((tx.confirmations ?? 0) < 0) continue;
    let deposit;
    try { deposit = decode(tx, reserve.script); }
    catch (error) { if (error instanceof InvalidDeposit) continue; throw error; }
    if (deposit.vout !== output.vout) continue;
    const receipt = receipts.get(deposit.depositId);
    if (receipt) {
      assert.equal(receipt.amount, deposit.amountBaseUnits, "Mint receipt amount differs from Gridcoin deposit.");
      assert.equal(receipt.recipient, deposit.recipient, "Mint receipt recipient differs from Gridcoin deposit.");
      continue;
    }
    total += BigInt(deposit.amountBaseUnits);
    count++;
  }
  assert.equal(await rpc("getbestblockhash"), tip, "Gridcoin tip changed during pending deposit inspection. Retry.");
  return { total, count, tip };
}

module.exports = { pendingDeposits };
