const assert = require("node:assert/strict");

// Explicitly scoped to advancing an already saved Devnet payout, before RPC/signing.
async function testDelay(mode, request, env = process.env) {
  if (env.WGRC_TEST_REDEMPTION_DELAY_SECONDS === undefined) return;
  const seconds = Number(env.WGRC_TEST_REDEMPTION_DELAY_SECONDS);
  assert.equal(env.WGRC_ENABLE_TEST_FAULTS, "devnet", "Test delay requires WGRC_ENABLE_TEST_FAULTS=devnet.");
  assert.equal(env.ANCHOR_PROVIDER_URL, "https://api.devnet.solana.com", "Test delay requires public Devnet.");
  assert.ok(Number.isInteger(seconds) && seconds >= 1 && seconds <= 300, "Test delay must be 1–300 seconds.");
  assert.ok(mode === "advance" && request.payout, "Test delay requires advance of a saved payout.");
  console.error(`Devnet test delay: waiting ${seconds}s before payout advancement; no RPC or signing performed yet.`);
  await new Promise((resolve) => setTimeout(resolve, seconds * 1000));
}
module.exports = { testDelay };
