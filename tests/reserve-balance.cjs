const { test } = require("node:test");
const assert = require("node:assert/strict");
const { reserveBalance, coverageLabel } = require("../scripts/reserve-balance.cjs");
test("coverage uses outstanding supply and exact integer precision", () => {
  assert.equal(coverageLabel(83n, 83n, 8), "Covered");
  assert.equal(coverageLabel(82n, 83n, 8), "!! Uncovered !!");
  assert.equal(coverageLabel(84n, 83n, 8), "Covered");
  assert.equal(coverageLabel(100000000n, 1000000000n, 9), "Covered");
});
test("reserve balance excludes other wallet addresses and rejects unstable snapshots", async () => {
  const reserve = { address: { ismine: true, address: "reserve" }, script: "ours" };
  const outputs = [{ txid: "a", vout: 0, confirmations: 3, amount: "123", scriptPubKey: "ours" },
    { txid: "b", vout: 0, confirmations: 3, amount: "999", scriptPubKey: "other" }];
  const rpc = async (method) => method === "getbestblockhash" ? "tip" : outputs;
  assert.equal(await reserveBalance(rpc, reserve, BigInt), 123n);
  let tip = 0;
  await assert.rejects(reserveBalance(async (method) => method === "getbestblockhash" ? ++tip : outputs,
    reserve, BigInt), /tip changed/);
  outputs.push(outputs[0]);
  await assert.rejects(reserveBalance(rpc, reserve, BigInt), /Duplicate/);
});
