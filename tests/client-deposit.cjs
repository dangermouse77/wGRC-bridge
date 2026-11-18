const assert = require("node:assert/strict");
const { test } = require("node:test");
const { mkdtemp, readFile, rm } = require("node:fs/promises");
const { tmpdir } = require("node:os");
const { join } = require("node:path");
const { parse, deposit } = require("../scripts/client-deposit.cjs");
const record = { txid: "ab".repeat(32), signedHex: "0102", recipient: "recipient", amountBaseUnits: "200000000" };

test("deposit validates amount and recipient arguments", () => {
  assert.deepEqual(parse(["2", "--solana-address", "recipient"]), { amount: "2", recipient: "recipient" });
  for (const args of [[], ["0", "--solana-address", "recipient"], ["-1", "--solana-address", "recipient"], ["2", "--wrong", "recipient"]]) {
    assert.throws(() => parse(args));
  }
});

test("saves exact signed transaction before broadcast and refuses overwriting it", async () => {
  const dir = await mkdtemp(join(tmpdir(), "wgrc-deposit-"));
  let broadcasts = 0;
  const run = async (args) => {
    if (args[0] === "create") return JSON.stringify(record);
    broadcasts++;
    assert.deepEqual(JSON.parse(await readFile(args[2], "utf8")), record);
    return JSON.stringify({ txid: record.txid });
  };
  try {
    const opts = { amount: "2", recipient: "recipient" };
    const result = await deposit(opts, "reserve", run, dir, () => {});
    assert.equal(result.txid, record.txid);
    await assert.rejects(deposit(opts, "reserve", run, dir, () => {}), /EEXIST/);
    assert.equal(broadcasts, 1);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test("ambiguous broadcast retains the original transaction for retry", async () => {
  const dir = await mkdtemp(join(tmpdir(), "wgrc-deposit-"));
  try {
    await assert.rejects(deposit({ amount: "2", recipient: "recipient" }, "reserve", async ([mode]) => {
      if (mode === "create") return JSON.stringify(record);
      throw new Error("RPC timed out");
    }, dir, () => {}), /Do not create another deposit.*broadcast-deposit/s);
    assert.deepEqual(JSON.parse(await readFile(join(dir, `${record.txid}.json`), "utf8")), record);
  } finally { await rm(dir, { recursive: true, force: true }); }
});
