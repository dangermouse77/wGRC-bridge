const assert = require("node:assert/strict");
const { createHash } = require("node:crypto");
const { test } = require("node:test");
const { reconcileWithdrawals, reserveTotals, legacyAmount } = require("../relayer/reconcile-reserve.cjs");

const payout = { withdrawalAddress: "request", txid: "ab".repeat(32) };
const withdrawal = {
  address: "request",
  amountBaseUnits: "100000000",
  status: "pending",
  gridcoinPayoutTxid: null,
};
const snapshot = (supply, withdrawals, legacy = []) => ({ supply, withdrawals, legacy });

test("counts unpaid pending escrow once and credits only a verified confirmed payout", async () => {
  const chain = snapshot(200000000n, [withdrawal]);
  const unpaid = await reconcileWithdrawals(chain, [payout], async () => false);
  assert.equal(unpaid.required, 200000000n);
  assert.equal(unpaid.pendingEscrow, 100000000n);
  const paid = await reconcileWithdrawals(chain, [payout], async () => true);
  assert.equal(paid.required, 100000000n);
  assert.equal(paid.confirmedPendingPayouts, 100000000n);
});

test("a verified settled withdrawal is already reflected in mint supply", async () => {
  const settled = { ...withdrawal, status: "settled", gridcoinPayoutTxid: payout.txid };
  const report = await reconcileWithdrawals(snapshot(100000000n, [settled]), [payout], async () => true);
  assert.equal(report.required, 100000000n);
  assert.equal(report.confirmedPendingPayouts, 0n);
  assert.deepEqual(report.issues, []);
});

test("flags unverified settlements and adds conservative legacy obligations", async () => {
  const settled = { ...withdrawal, status: "settled", gridcoinPayoutTxid: payout.txid };
  const chain = snapshot(100000000n, [settled], [{ address: "legacy", amountBaseUnits: "7" }]);
  const report = await reconcileWithdrawals(chain, [payout], async () => { throw new Error("Payout block changed"); });
  assert.equal(report.required, 200000007n);
  assert.equal(report.unverifiedSettled, 100000000n);
  assert.equal(report.legacyObligations, 7n);
  assert.equal(report.issues.length, 2);
});

test("only confirmed outputs from the correct reserve contribute to backing", () => {
  const output = { txid: "21".repeat(32), vout: 0, amount: "1.00000001", scriptPubKey: "reserve" };
  assert.deepEqual(reserveTotals([
    { ...output, confirmations: 10, spendable: true },
    { ...output, vout: 1, confirmations: 10, spendable: false },
    { ...output, vout: 2, confirmations: 9 },
    { ...output, vout: 3, confirmations: 10, scriptPubKey: "other" },
  ], "reserve", 10), { confirmed: 200000002n, spendable: 100000001n });
  assert.throws(() => reserveTotals([
    { ...output, confirmations: 10 }, { ...output, confirmations: 10 },
  ], "reserve", 10), /Duplicate reserve output/);
});

test("reads the full u64 from the legacy account without an IDL entry", () => {
  const data = Buffer.alloc(95);
  createHash("sha256").update("account:WithdrawalRequest").digest().copy(data, 0, 0, 8);
  data.writeBigUInt64LE(18446744073709551615n, 48);
  data.writeUInt32LE(35, 56);
  assert.equal(legacyAmount(data), 18446744073709551615n);
  assert.throws(() => legacyAmount(data.subarray(0, 94)), /Invalid legacy withdrawal destination/);
});
