const assert = require("node:assert/strict");
const { test } = require("node:test");
const { spawnSync } = require("node:child_process");
const { mkdtempSync, writeFileSync, rmSync } = require("node:fs");
const { tmpdir } = require("node:os");
const { join } = require("node:path");

function run(source, options = {}) {
  const dir = mkdtempSync(join(tmpdir(), "wgrc-worker-"));
  try {
    const file = join(dir, "worker.cjs");
    writeFileSync(file, source);
    return spawnSync(process.execPath, ["relayer/worker.cjs", file], {
      encoding: "utf8", timeout: 10000,
      env: { ...process.env, WGRC_WORKER_TIMEOUT_SECONDS: "1" }, ...options,
    });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test("worker preserves JSON stdin/stdout and drains large output", () => {
  const input = JSON.stringify({ value: "x".repeat(200000) });
  const result = run('process.stdin.pipe(process.stdout)', { input });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout, input);
});

test("supervisor kills a worker with a blocked event loop", () => {
  const result = run('while (true) {}');
  assert.equal(result.status, 124, result.stderr);
  assert.match(result.stderr, /Outcome may be uncertain/);
});

test("worker errors preserve failure status and diagnostics", () => {
  const result = run('console.error("failed"); process.exit(7)');
  assert.equal(result.status, 7);
  assert.match(result.stderr, /failed/);
});

test("invalid timeout fails before starting worker", () => {
  const result = run('console.log("should not run")', {
    env: { ...process.env, WGRC_WORKER_TIMEOUT_SECONDS: "0" },
  });
  assert.equal(result.status, 1);
  assert.equal(result.stdout, "");
});

test("guarded redemption delay times out and normal retry completes", () => {
  const modulePath = require.resolve("../relayer/test-delay.cjs");
  const source = `require(${JSON.stringify(modulePath)}).testDelay("advance", { payout: {} }).then(() => console.log("completed"));`;
  const env = { ...process.env, WGRC_WORKER_TIMEOUT_SECONDS: "1",
    WGRC_ENABLE_TEST_FAULTS: "devnet", ANCHOR_PROVIDER_URL: "https://api.devnet.solana.com",
    WGRC_TEST_REDEMPTION_DELAY_SECONDS: "5" };
  const result = run(source, { env });
  assert.equal(result.status, 124, result.stderr);
  assert.match(result.stderr, /Devnet test delay/);
  assert.equal(result.stdout, "");
  delete env.WGRC_TEST_REDEMPTION_DELAY_SECONDS;
  const retry = run(source, { env });
  assert.equal(retry.status, 0, retry.stderr);
  assert.match(retry.stdout, /completed/);
});

test("redemption test delay rejects unsafe configuration", async () => {
  const { testDelay } = require("../relayer/test-delay.cjs");
  const env = { WGRC_ENABLE_TEST_FAULTS: "devnet", ANCHOR_PROVIDER_URL: "https://api.devnet.solana.com",
    WGRC_TEST_REDEMPTION_DELAY_SECONDS: "5" };
  await assert.rejects(testDelay("advance", { payout: {} }, { ...env, WGRC_ENABLE_TEST_FAULTS: "" }));
  await assert.rejects(testDelay("advance", { payout: {} }, { ...env, ANCHOR_PROVIDER_URL: "https://api.mainnet.solana.com" }));
  await assert.rejects(testDelay("prepare", {}, env));
  await assert.rejects(testDelay("advance", {}, env));
  await assert.rejects(testDelay("advance", { payout: {} }, { ...env, WGRC_TEST_REDEMPTION_DELAY_SECONDS: "0" }));
});
