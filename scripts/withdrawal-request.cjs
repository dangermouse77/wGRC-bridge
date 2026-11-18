const assert = require("node:assert/strict");
const { randomBytes } = require("node:crypto");
const { parseAmount } = require("./supply-limit.cjs");

function parseRequest(args) {
  const [destination, value, ...extra] = args;
  assert.ok(destination && value && (extra.length === 0 || extra.length === 2 && extra[0] === "--nonce"),
    "Expected GRIDCOIN_TESTNET_ADDRESS AMOUNT_WGRC [--nonce NONCE]");
  const amount = parseAmount(value);
  assert.ok(amount > 0n, "Withdrawal amount must be positive.");
  const nonce = extra.length ? extra[1] : randomBytes(8).readBigUInt64LE().toString();
  assert.match(nonce, /^\d+$/, "Nonce must be an unsigned integer.");
  assert.ok(BigInt(nonce) <= (1n << 64n) - 1n, "Nonce exceeds u64.");
  return { destination, amount, nonce: BigInt(nonce).toString() };
}

function verifyExisting(state, request) {
  assert.equal(state.owner.toBase58(), request.owner, "Withdrawal owner differs from saved request.");
  assert.equal(state.nonce.toString(), request.nonce, "Withdrawal nonce differs from saved request.");
  assert.equal(state.amount.toString(), request.amountBaseUnits, "Nonce already used for a different amount.");
  assert.equal(state.gridcoinAddress, request.gridcoinAddress, "Nonce already used for a different destination.");
  return Object.keys(state.status)[0];
}

module.exports = { parseRequest, verifyExisting };
