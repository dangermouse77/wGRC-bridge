const assert = require("node:assert/strict");
const { test } = require("node:test");
const { advancePayout, preparePayout } = require("../relayer/redeem-devnet.cjs");

const txid = "ab".repeat(32);
const blockhash = "34".repeat(32);
const payout = { txid, signedHex: "0102" };
const pending = async () => "pending";
const unexpected = async () => assert.fail("Unexpected broadcast or settlement.");
const missing = Object.assign(new Error("Transaction not found"), { rpcCode: -5 });

test("prepares an exact payout using only reserve inputs and reserve change", async () => {
  const reserve = { address: { address: "reserve" }, script: "reserve-script" };
  const destination = { address: { address: "destination" }, script: "destination-script" };
  const input = { txid: "12".repeat(32), vout: 2 };
  const rpc = async (method, ...params) => {
    switch (method) {
      case "listunspent":
        assert.deepEqual(params, [10, 9999999, ["reserve"]]);
        return [
          { ...input, scriptPubKey: "another-script", amount: "5.00000000" },
          { ...input, scriptPubKey: reserve.script, amount: "2.00000000" },
        ];
      case "createrawtransaction":
        assert.deepEqual(params, [[input], { destination: "1.00000001", reserve: "0.99899999" }]);
        return "unsigned";
      case "signrawtransaction":
        assert.deepEqual(params, ["unsigned"]);
        return { complete: true, hex: payout.signedHex };
      case "decoderawtransaction":
        assert.deepEqual(params, [payout.signedHex]);
        return { txid, vin: [input], vout: [
          { value: "1.00000001", scriptPubKey: { hex: destination.script } },
          { value: "0.99899999", scriptPubKey: { hex: reserve.script } },
        ] };
      default:
        assert.fail(`Unexpected payout RPC ${method}`);
    }
  };
  assert.deepEqual(await preparePayout(rpc, reserve, destination, 10, 100000001n, 100000n), payout);
});

test("broadcasts the saved bytes and waits for confirmations", async () => {
  let broadcast = false;
  const rpc = async (method, value, verbose) => {
    if (method === "sendrawtransaction") {
      assert.equal(value, payout.signedHex);
      broadcast = true;
      return txid;
    }
    assert.deepEqual([method, value, verbose], ["getrawtransaction", txid, true]);
    if (!broadcast) throw missing;
    return { txid, confirmations: 0 };
  };
  assert.deepEqual(await advancePayout(rpc, payout, 10, pending, unexpected), {
    txid, confirmations: 0, blockHash: null, signature: null,
  });
  assert.equal(broadcast, true);
});

test("recovers a lost broadcast response by tracking the same transaction", async () => {
  let broadcasts = 0;
  const rpc = async (method, id) => {
    if (method === "sendrawtransaction") {
      assert.equal(id, payout.signedHex);
      broadcasts++;
      throw new Error("Broadcast response timed out");
    }
    assert.deepEqual([method, id], ["getrawtransaction", txid]);
    if (broadcasts === 0) throw missing;
    return { txid, confirmations: 9, blockhash };
  };
  await assert.rejects(advancePayout(rpc, payout, 10, pending, unexpected), /timed out/);
  assert.deepEqual(await advancePayout(rpc, payout, 10, pending, unexpected), {
    txid, confirmations: 9, blockHash: null, signature: null,
  });
  assert.equal(broadcasts, 1);
});

test("a transient lookup failure leaves the saved payout eligible for retry", async () => {
  const rpc = async (method, id) => {
    assert.deepEqual([method, id], ["getrawtransaction", txid]);
    throw new Error("Gridcoin RPC temporarily unavailable");
  };
  await assert.rejects(advancePayout(rpc, payout, 10, pending, unexpected), /temporarily unavailable/);
});

test("settles a confirmed payout and recovers a lost settlement response", async () => {
  const rpc = async (method, id) => {
    assert.deepEqual([method, id], ["getrawtransaction", txid]);
    return { txid, confirmations: 10, blockhash };
  };
  assert.deepEqual(await advancePayout(rpc, payout, 10, pending, async () => "signature"), {
    txid, confirmations: 10, blockHash: blockhash, signature: "signature",
  });
  assert.deepEqual(await advancePayout(rpc, payout, 10, async () => "settled", unexpected), {
    txid, confirmations: 10, blockHash: blockhash, signature: null,
  });
});

test("holds a settled payout for reconciliation if Gridcoin removes it", async () => {
  const rpc = async (method) => {
    assert.equal(method, "getrawtransaction");
    throw missing;
  };
  await assert.rejects(advancePayout(rpc, payout, 10, async () => "settled", unexpected, blockhash),
    /needs reconciliation/);
  await assert.rejects(advancePayout(unexpected, payout, 10, pending, unexpected, blockhash),
    /Saved settlement is missing/);
});
