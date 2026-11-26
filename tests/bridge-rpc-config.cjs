const { test } = require("node:test");
const assert = require("node:assert/strict");
const { bridgeRpc } = require("../scripts/bridge-rpc-config.cjs");
const file = require("node:path").resolve("relayer/bridge.dev.example.json");
test("bridge configuration beats generic funding environment", () => {
  const result = bridgeRpc({ GRC_RPC_URL: "http://funding", GRC_RPC_USER: "funding" }, file);
  assert.equal(result.GRC_RPC_URL, "http://gridtestbridge:25715");
  assert.equal(result.GRC_RPC_USER, "dangermousebridge");
});
test("dedicated environment overrides JSON and supports literal password characters", () => {
  const password = 'quotes" $() `literal`';
  const result = bridgeRpc({ GRC_BRIDGE_RPC_URL: "http://override", GRC_BRIDGE_RPC_PASSWORD: password }, file);
  assert.equal(result.GRC_RPC_URL, "http://override");
  assert.equal(result.GRC_RPC_PASSWORD, password);
});
test("missing file preserves legacy RPC configuration", () => {
  assert.equal(bridgeRpc({ GRC_RPC_PASSWORD: "legacy" }, "missing-config-for-test.json").GRC_RPC_PASSWORD, "legacy");
});
