const assert = require("node:assert/strict");
const { test } = require("node:test");
const { scanBlock } = require("../relayer/scan-gridcoin.cjs");

const previous = "11".repeat(32);
const hash = "22".repeat(32);
const txid = "448bd13d7db71908372e30bb40f98134506810637339161bbbf34415499bf76e";
const reserve = "76a91492aef9ef034c2eeb9f57ce1f3f00c389d6b899fe88ac";
const payment = { n: 0, value: "1.00000000", scriptPubKey: { hex: reserve } };
const carrier = {
  n: 1,
  value: "0.00000001",
  scriptPubKey: { hex: "6a255747524301d797a07e45241c9403a85015b4f78997d923f95a963ea9a9f5c3f685e6ad2fb5" },
};
const deposit = { txid, vin: [{ txid: "33".repeat(32), vout: 0 }], vout: [payment, carrier] };

function fixture({ tip = 105, parent = previous, tx = [deposit], lastHash = hash } = {}) {
  let reads = 0;
  return async (method, ...params) => {
    if (method === "getblockcount") return tip;
    if (method === "getblockhash") {
      if (params[0] === 99) return parent;
      assert.equal(params[0], 100);
      return reads++ === 0 ? hash : lastHash;
    }
    assert.equal(method, "getblock");
    assert.deepEqual(params, [hash, true]);
    return { height: 100, hash, previousblockhash: previous, confirmations: 6, tx };
  };
}

test("discovers the Phase 2 deposit and skips a malformed carrier and coinbase payment", async () => {
  const tx = [
    { ...deposit, txid: "33".repeat(32), vin: [{ coinbase: "00" }] },
    { ...deposit, txid: "44".repeat(32), vout: [payment, { ...carrier, value: "0.00000000" }] },
    deposit,
  ];
  assert.deepEqual(await scanBlock(fixture({ tx }), reserve, 100, 6, previous), {
    status: "block",
    hash,
    confirmations: 6,
    deposits: [{
      txid,
      vout: 0,
      depositId: "fd6527a1f25e38d87e815b0ad3a71dd42f767a22fe096986fce7c36d911599c2",
      recipient: "FWakmcaVqecEfFbxJKang1KoTp6A6JMJ1LSVygLx1JQC",
      amountBaseUnits: "100000000",
    }],
  });
});

test("waits until the next block reaches the confirmation threshold", async () => {
  assert.deepEqual(await scanBlock(fixture({ tip: 104 }), reserve, 100, 6, previous), { status: "waiting" });
});

test("reports an orphaned checkpoint even when its replacement has too few confirmations", async () => {
  const rpc = fixture({ tip: 99, parent: "55".repeat(32) });
  assert.deepEqual(await scanBlock(rpc, reserve, 100, 6, previous), { status: "reorg" });
});

test("rejects a chain change during a scan", async () => {
  const rpc = fixture({ lastHash: "55".repeat(32) });
  await assert.rejects(scanBlock(rpc, reserve, 100, 6, previous), /chain changed/);
});

test("rejects a block response without decoded transactions", async () => {
  await assert.rejects(scanBlock(fixture({ tx: [txid] }), reserve, 100, 6, previous), /incomplete decoded/);
});
