const assert = require("node:assert/strict");

async function pendingPayouts(records, withdrawals, lookup, validate) {
  const minimum = records.minimumConfirmations;
  assert.ok(Number.isSafeInteger(minimum) && minimum > 0);
  assert.ok(Array.isArray(records.payouts));
  let total = 0n;
  let count = 0;
  let unobserved = 0;
  const confirmations = [];
  const prepared = new Set(records.payouts.map((payout) => payout.withdrawalAddress));
  const cancellations = new Set(records.cancellations ?? []);
  // Older binaries do not expose cancellation intents: don't guess a queue count.
  const queued = Array.isArray(records.cancellations)
    ? [...withdrawals].filter(([address, withdrawal]) => withdrawal.status === "pending"
      && !prepared.has(address) && !cancellations.has(address)).length
    : null;
  const seen = new Set();
  for (const payout of records.payouts) {
    assert.ok(!seen.has(payout.txid), "Duplicate payout record.");
    seen.add(payout.txid);
    const withdrawal = withdrawals.get(payout.withdrawalAddress);
    assert.ok(withdrawal, "Saved payout has no matching finalized withdrawal. Retry or reconcile.");
    assert.equal(payout.amountBaseUnits, withdrawal.amount);
    assert.equal(payout.gridcoinAddress, withdrawal.destination);
    if (withdrawal.status === "settled") continue;
    assert.equal(withdrawal.status, "pending", "Saved payout belongs to a cancelled withdrawal. Reconcile.");
    const tx = await lookup(payout.txid);
    if (!tx) { unobserved++; continue; }
    assert.equal(tx.txid, payout.txid);
    assert.ok(Number.isSafeInteger(tx.confirmations) && tx.confirmations >= 0,
      "Payout has invalid or conflicted confirmations. Reconcile.");
    await validate(tx, payout);
    if (tx.confirmations < minimum) {
      total += BigInt(payout.amountBaseUnits);
      count++;
      confirmations.push(tx.confirmations);
    }
  }
  return { total, count, unobserved, minimum, confirmations, queued };
}
module.exports = { pendingPayouts };
