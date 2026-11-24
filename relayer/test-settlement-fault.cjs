const assert = require("node:assert/strict");
function validateSettlementFault(env = process.env) {
  if (env.WGRC_TEST_LOST_SETTLEMENT_RESPONSE === undefined) return false;
  assert.equal(env.WGRC_TEST_LOST_SETTLEMENT_RESPONSE, "1", "Settlement fault must be 1.");
  assert.equal(env.WGRC_ENABLE_TEST_FAULTS, "devnet", "Settlement fault requires explicit Devnet opt-in.");
  assert.equal(env.ANCHOR_PROVIDER_URL, "https://api.devnet.solana.com", "Settlement fault requires public Devnet.");
  return true;
}
function afterSettlement(signature, env = process.env) {
  if (validateSettlementFault(env)) throw new Error(`Devnet test fault: settlement ${signature} finalized; simulating lost settlement response. Retry the same withdrawal without fault variables.`);
}
module.exports = { validateSettlementFault, afterSettlement };
