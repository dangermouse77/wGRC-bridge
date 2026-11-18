const assert = require("node:assert/strict");
const { test } = require("node:test");
const { cycle, options } = require("../relayer/service.cjs");

test("service defaults to recovery without initiating new payouts", async () => {
  const commands = [];
  assert.equal(await cycle(options(["3339204"]), async (args) => {
    commands.push(args); return true;
  }), true);
  assert.deepEqual(commands, [
    ["watch-gridcoin", "3339204", "--once", "--mint"], ["watch-solana", "--once"],
    ["recover-redemptions", "--once"], ["recover-cancellations"], ["reconcile-reserve"],
  ]);
});

test("new payout initiation follows successful scans and recovery", async () => {
  const commands = [];
  await cycle(options(["1", "--enable-payouts"]), async ([command]) => {
    commands.push(command); return true;
  });
  assert.deepEqual(commands.slice(2), ["recover-redemptions", "recover-cancellations", "process-redemptions", "reconcile-reserve"]);
});

test("each prerequisite failure blocks new payouts while retaining recovery/reporting", async () => {
  for (const failure of ["watch-gridcoin", "watch-solana", "recover-redemptions", "recover-cancellations"]) {
    const commands = [];
    assert.equal(await cycle(options(["1", "--enable-payouts"]), async ([command]) => {
      commands.push(command); return command !== failure;
    }), false);
    assert.ok(!commands.includes("process-redemptions"));
    assert.ok(commands.includes("recover-redemptions"));
    assert.ok(commands.includes("recover-cancellations"));
    assert.ok(commands.includes("reconcile-reserve"));
  }
});

test("shutdown drains current step and starts no further operations", async () => {
  let stopped = false;
  let calls = 0;
  await cycle(options(["1", "--enable-payouts"]), async () => {
    calls++; stopped = true; return true;
  }, () => stopped);
  assert.equal(calls, 1);
});

test("a later cycle resumes normal processing after a failure", async () => {
  const config = options(["1", "--once", "--enable-payouts"]);
  assert.equal(await cycle(config, async () => false), false);
  const commands = [];
  assert.equal(await cycle(config, async ([command]) => { commands.push(command); return true; }, () => false, false), true);
  assert.ok(commands.includes("process-redemptions"));
  assert.ok(!commands.includes("reconcile-reserve"));
});

test("service rejects missing heights and unsupported or duplicate flags", () => {
  for (const args of [[], ["-1"], ["4294967296"], ["1", "--mint"], ["1", "--once", "--once"]]) {
    assert.throws(() => options(args), /Usage/);
  }
});
