const assert = require("node:assert/strict");
const { test } = require("node:test");
const { pendingPayouts } = require("../scripts/pending-payouts.cjs");
const payouts = [0, 1, 2].map((i) => ({ txid: `tx${i}`, withdrawalAddress: `w${i}`,
  amountBaseUnits: "100000000", gridcoinAddress: "destination" }));
const withdrawals = new Map(payouts.map((p) => [p.withdrawalAddress,
  { amount: p.amountBaseUnits, destination: p.gridcoinAddress, status: "pending" }]));
const records = { minimumConfirmations: 10, payouts };
test("counts broadcast payouts below threshold, excludes confirmed ones", async () => {
  const result = await pendingPayouts(records, withdrawals,
    async (txid) => ({ txid, confirmations: { tx0: 0, tx1: 9, tx2: 10 }[txid] }), async () => {});
  assert.deepEqual(result, { total: 200000000n, count: 2, unobserved: 0, minimum: 10 });
});
test("saved but unobserved payouts are reported separately, never assumed broadcast", async () => {
  const result = await pendingPayouts(records, withdrawals, async () => null, async () => assert.fail());
  assert.equal(result.total, 0n);
  assert.equal(result.unobserved, 3);
});
test("settled withdrawals are excluded even if database completion is delayed", async () => {
  const settled = new Map([...withdrawals].map(([key, value]) => [key, { ...value, status: "settled" }]));
  assert.equal((await pendingPayouts(records, settled, async () => assert.fail(), async () => {})).count, 0);
});
test("RPC failures, conflicting payouts and destination mismatch fail the report", async () => {
  await assert.rejects(pendingPayouts(records, withdrawals, async () => { throw new Error("RPC unavailable"); }, async () => {}), /RPC unavailable/);
  await assert.rejects(pendingPayouts(records, withdrawals, async (txid) => ({ txid, confirmations: -1 }), async () => {}), /conflicted/);
  await assert.rejects(pendingPayouts(records, withdrawals, async (txid) => ({ txid, confirmations: 1 }), async () => { throw new Error("Wrong destination"); }), /Wrong destination/);
});
