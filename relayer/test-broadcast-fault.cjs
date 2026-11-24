const assert = require("node:assert/strict");
function validateBroadcastFault(env = process.env) {
  if (env.WGRC_TEST_LOST_BROADCAST_RESPONSE === undefined) return false;
  assert.equal(env.WGRC_TEST_LOST_BROADCAST_RESPONSE, "1", "Broadcast fault must be 1.");
  assert.equal(env.WGRC_ENABLE_TEST_FAULTS, "devnet", "Broadcast fault requires explicit Devnet opt-in.");
  assert.equal(env.ANCHOR_PROVIDER_URL, "https://api.devnet.solana.com", "Broadcast fault requires public Devnet.");
  return true;
}
function afterBroadcast(txid, env = process.env) {
  if (validateBroadcastFault(env)) {
    throw new Error(`Devnet test fault: payout ${txid} accepted by Gridcoin; simulating lost broadcast response. Retry the same withdrawal without fault variables.`);
  }
}
module.exports = { validateBroadcastFault, afterBroadcast };
