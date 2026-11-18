const assert = require("node:assert/strict");
const { test } = require("node:test");
const { advancePayout, preparePayout, cancelWithdrawal } = require("../relayer/redeem-devnet.cjs");

const txid = "ab".repeat(32);
const blockhash = "34".repeat(32);
const payout = { txid, signedHex: "0102" };
const pending = async () => "pending";
const unexpected = async () => assert.fail("Unexpected broadcast or settlement.");
const missing = Object.assign(new Error("Transaction not found"), { rpcCode: -5 });

test("cancellation recovers a lost submission response without refunding twice", async () => {
  let status = "pending";
  let submissions = 0;
  await assert.rejects(cancelWithdrawal(async () => status, async () => {
    submissions++;
    status = "cancelled";
    throw new Error("Submission timed out");
  }), /timed out/);
  assert.equal(await cancelWithdrawal(async () => status, unexpected), null);
  assert.equal(submissions, 1);
});

test("cancellation refuses settled withdrawals and requires finalized cancellation", async () => {
  await assert.rejects(cancelWithdrawal(async () => "settled", unexpected), /Only pending/);
  await assert.rejects(cancelWithdrawal(pending, async () => "signature"), /not finalized/);
  let status = "pending";
  assert.equal(await cancelWithdrawal(async () => status, async () => {
    status = "cancelled";
    return "signature";
  }), "signature");
});

test("prepares an exact payout using only reserve inputs and reserve change", async () => {
  const reserve = { address: { address: "reserve" }, script: "51" };
  const destination = { address: { address: "destination" }, script: "52" };
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
      case "getrawtransaction":
        assert.deepEqual(params, [input.txid, true]);
        return { txid: input.txid, vout: [
          { n: input.vout, value: "2.00000000", scriptPubKey: { hex: reserve.script } },
        ] };
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

const reserve = { address: { address: "reserve" }, script: "51" };
const destination = { address: { address: "destination" }, script: "52" };
const depositInput = { txid: "cd".repeat(32), vout: 0 };
const fundingInput = { txid: "ef".repeat(32), vout: 0 };
const depositOutpoint = `${depositInput.txid}:0`;

function selectionRpc(inputs, expectedInput, { lookupError = false, malformed = false } = {}) {
  return async (method, ...params) => {
    switch (method) {
      case "listunspent":
        return inputs.map((input) => ({ ...input, scriptPubKey: reserve.script, amount: "2" }));
      case "getrawtransaction": {
        if (lookupError) throw new Error("Source lookup unavailable");
        const outputs = [{ n: 0, value: "2", scriptPubKey: { hex: "51" } }];
        if (params[0] === depositInput.txid) outputs.push({ n: 1, value: "0.00000001",
          scriptPubKey: { hex: malformed ? "6a01ff" : `6a255747524301${"11".repeat(32)}` } });
        return { txid: params[0], vout: outputs };
      }
      case "createrawtransaction":
        assert.ok(expectedInput, "Must not construct a payout using protected inputs");
        assert.deepEqual(params[0], [expectedInput]);
        return "unsigned";
      case "signrawtransaction":
        return { complete: true, hex: payout.signedHex };
      case "decoderawtransaction":
        return { txid, vin: [expectedInput], vout: [
          { value: "1", scriptPubKey: { hex: "52" } },
          { value: "0.999", scriptPubKey: { hex: "51" } },
        ] };
      default:
        assert.fail(`Unexpected RPC ${method}`);
    }
  };
}

test("payout skips undiscovered or pending deposits and uses separate reserve funding", async () => {
  const rpc = selectionRpc([depositInput, fundingInput], fundingInput);
  assert.deepEqual(await preparePayout(rpc, reserve, destination, 10, 100000000n, 100000n, []), payout);
});

test("only the exact finalized deposit outpoint becomes eligible", async () => {
  for (const minted of [[], [`${depositInput.txid}:1`], [`${fundingInput.txid}:0`]]) {
    await assert.rejects(preparePayout(selectionRpc([depositInput]), reserve, destination,
      10, 100000000n, 100000n, minted), /unminted deposit\/data outputs are protected/);
  }
  assert.deepEqual(await preparePayout(selectionRpc([depositInput], depositInput), reserve, destination,
    10, 100000000n, 100000n, [depositOutpoint]), payout);
});

test("a mint finishing during preparation only releases its input on the next attempt", async () => {
  const finalized = [];
  const rpc = selectionRpc([depositInput], depositInput);
  const concurrentRpc = async (method, ...params) => {
    if (method === "listunspent") finalized.push(depositOutpoint);
    return rpc(method, ...params);
  };
  await assert.rejects(preparePayout(concurrentRpc, reserve, destination,
    10, 100000000n, 100000n, finalized), /unminted deposit\/data outputs are protected/);
  assert.deepEqual(await preparePayout(rpc, reserve, destination,
    10, 100000000n, 100000n, finalized), payout);
});

test("unknown data outputs stay protected and source lookup failures stop preparation", async () => {
  await assert.rejects(preparePayout(selectionRpc([depositInput], undefined, { malformed: true }),
    reserve, destination, 10, 100000000n, 100000n), /unminted deposit\/data outputs are protected/);
  await assert.rejects(preparePayout(selectionRpc([fundingInput], undefined, { lookupError: true }),
    reserve, destination, 10, 100000000n, 100000n), /Source lookup unavailable/);
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
