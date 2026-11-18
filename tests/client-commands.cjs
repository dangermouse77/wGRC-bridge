const assert = require("node:assert/strict");
const { test } = require("node:test");
const { parseRequest, verifyExisting } = require("../scripts/withdrawal-request.cjs");
const { report, formatUnits } = require("../scripts/bridge-status.cjs");

test("withdrawal parses exact amounts and stable nonces", () => {
  assert.deepEqual(parseRequest(["destination", "1.00000001", "--nonce", "42"]),
    { destination: "destination", amount: 100000001n, nonce: "42" });
  const generated = parseRequest(["destination", "1"]);
  assert.ok(BigInt(generated.nonce) <= (1n << 64n) - 1n);
  for (const args of [[], ["destination", "0"], ["destination", "1", "--nonce", "-1"],
    ["destination", "1", "--nonce", "18446744073709551616"], ["destination", "1", "--other", "42"]]) {
    assert.throws(() => parseRequest(args));
  }
});

test("withdrawal replay verifies identity and cannot reuse a nonce for another payment", () => {
  const state = { owner: { toBase58: () => "owner" }, nonce: 42n, amount: 100000000n,
    gridcoinAddress: "destination", status: { pending: {} } };
  const request = { owner: "owner", nonce: "42", amountBaseUnits: "100000000", gridcoinAddress: "destination" };
  assert.equal(verifyExisting(state, request), "pending");
  assert.equal(verifyExisting({ ...state, status: { settled: {} } }, request), "settled");
  for (const key of Object.keys(request)) {
    assert.throws(() => verifyExisting(state, { ...request, [key]: "different" }));
  }
});

test("status reports capacity without claiming daemon health or reserve coverage", () => {
  const state = { supply: 100000001n, maximum: 200000000000000n, paused: false, slot: 42 };
  const result = report(state);
  assert.equal(result.outstandingWgrc, "1.00000001");
  assert.equal(result.maximumWgrc, "2000000");
  assert.equal(result.remainingCapacityWgrc, "1999998.99999999");
  assert.equal(result.mintingStatus, "capacity_available");
  assert.equal(result.daemonHealth, "not_checked");
  assert.equal(result.reserveBacking, "not_checked");
  assert.equal(report({ ...state, paused: true }).mintingStatus, "paused");
  assert.equal(report({ ...state, supply: state.maximum }).mintingStatus, "at_capacity");
  assert.equal(formatUnits(0n), "0");
});
