const assert = require("node:assert/strict");
const { test } = require("node:test");
const { pendingDeposits } = require("../scripts/pending-deposits.cjs");
class InvalidDeposit extends Error {}
const reserve = { address: { address: "reserve", ismine: true }, script: "reserve-script" };
const decode = (tx) => {
  if (!tx.deposit) throw new InvalidDeposit("Not a bridge deposit");
  return tx.deposit;
};
const transactions = {
  first: { txid: "first", confirmations: 0, deposit: { depositId: "one", vout: 0, amountBaseUnits: "7700000000", recipient: "alice" } },
  minted: { txid: "minted", confirmations: 12, deposit: { depositId: "two", vout: 0, amountBaseUnits: "100000000", recipient: "bob" } },
  funding: { txid: "funding", confirmations: 100 },
};
function rpcFor(txs = transactions) {
  return async (method, txid) => {
    if (method === "getbestblockhash") return "tip";
    if (method === "listunspent") return Object.keys(txs).map((txid) => ({ txid, vout: 0, scriptPubKey: reserve.script }));
    if (method === "getrawtransaction") return txs[txid];
    assert.fail(`Unexpected RPC ${method}`);
  };
}
test("counts unconfirmed pending deposits, excludes minted deposits and ordinary funding", async () => {
  const receipts = new Map([["two", { amount: "100000000", recipient: "bob" }]]);
  assert.deepEqual(await pendingDeposits(rpcFor(), reserve, receipts, decode, InvalidDeposit),
    { total: 7700000000n, count: 1, tip: "tip" });
});
test("mint finalization removes an unspent deposit from the pending total", async () => {
  const tx = transactions.first;
  const receipts = new Map([["one", { amount: tx.deposit.amountBaseUnits, recipient: "alice" }]]);
  assert.equal((await pendingDeposits(rpcFor({ first: tx }), reserve, receipts, decode, InvalidDeposit)).total, 0n);
});
test("wrong wallet, lookup errors, and inconsistent receipts fail rather than report zero", async () => {
  await assert.rejects(pendingDeposits(rpcFor(), { ...reserve, address: { ismine: false } }, new Map(), decode, InvalidDeposit), /reserve wallet/);
  const rpc = rpcFor();
  await assert.rejects(pendingDeposits(async (...args) => {
    if (args[0] === "getrawtransaction") throw new Error("RPC unavailable");
    return rpc(...args);
  }, reserve, new Map(), decode, InvalidDeposit), /RPC unavailable/);
  await assert.rejects(pendingDeposits(rpc, reserve,
    new Map([["one", { amount: "1", recipient: "alice" }]]), decode, InvalidDeposit), /amount differs/);
});
test("chain tip change makes the report fail for retry", async () => {
  let tips = 0;
  const rpc = rpcFor({});
  await assert.rejects(pendingDeposits(async (...args) => args[0] === "getbestblockhash"
    ? String(++tips) : rpc(...args), reserve, new Map(), decode, InvalidDeposit), /tip changed/);
});
