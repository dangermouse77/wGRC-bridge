const fs = require("node:fs");
const path = require("node:path");
function bridgeRpc(env = process.env, file = path.join(__dirname, "../relayer/bridge.dev.json")) {
  let config = {};
  try { config = JSON.parse(fs.readFileSync(file, "utf8")); }
  catch (error) { if (error.code !== "ENOENT") throw new Error("Cannot parse bridge RPC configuration."); }
  const result = {};
  for (const suffix of ["URL", "USER", "PASSWORD"]) {
    const key = `GRC_BRIDGE_RPC_${suffix}`;
    const value = env[key] || config[key] || env[`GRC_RPC_${suffix}`] || "";
    if (typeof value !== "string" || value.includes("\0")) throw new Error(`Invalid ${key}.`);
    result[`GRC_RPC_${suffix}`] = value;
  }
  return result;
}
module.exports = { bridgeRpc };
if (require.main === module) {
  try { process.stdout.write(bridgeRpc()[process.argv[2]] ?? ""); }
  catch (error) { console.error(error.message); process.exitCode = 1; }
}
