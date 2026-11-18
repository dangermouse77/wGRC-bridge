const assert = require("node:assert/strict");
const { test } = require("node:test");
const { parseAmount, checkCapacity } = require("../scripts/supply-limit.cjs");

test("cap parsing preserves eight decimals and rejects ambiguous or overflowing values", () => {
  assert.equal(parseAmount("2000000"), 200000000000000n);
  assert.equal(parseAmount("0.00000001"), 1n);
  for (const amount of ["2'000'000", "2,000,000", "-1", "1e6", "0.000000001", "184467440738"]) {
    assert.throws(() => parseAmount(amount));
  }
});
test("capacity accepts exact boundary and rejects one base unit beyond", () => {
  const maximum = parseAmount("2000000");
  checkCapacity(maximum - 1n, maximum, 1n);
  assert.throws(() => checkCapacity(maximum, maximum, 1n), /Deposit rejected/);
  assert.throws(() => checkCapacity(0n, maximum, maximum + 1n), /Deposit rejected/);
});
test("burned supply frees capacity; escrowed supply still counts", () => {
  assert.throws(() => checkCapacity(100n, 100n, 1n));
  checkCapacity(90n, 100n, 10n);
});
