// Separate supervisor event loop also bounds a blocked/synchronous worker.
const { spawn, spawnSync } = require("node:child_process");
if (process.env.WGRC_RPC_ROLE === "bridge") {
  try {
    const values = require("../scripts/bridge-rpc-config.cjs").bridgeRpc();
    for (const [key, value] of Object.entries(values)) if (value) process.env[key] = value;
  } catch (error) { console.error(error.message); process.exit(1); }
}
const seconds = Number(process.env.WGRC_WORKER_TIMEOUT_SECONDS ?? "120");
if (!Number.isInteger(seconds) || seconds < 1 || seconds > 3600 || !process.argv[2]) {
  console.error("Expected a worker script and WGRC_WORKER_TIMEOUT_SECONDS between 1 and 3600.");
  process.exit(1);
}
const child = spawn(process.execPath, process.argv.slice(2), {
  stdio: ["pipe", "inherit", "inherit"],
  detached: process.platform !== "win32",
});
process.stdin.pipe(child.stdin);
child.stdin.on("error", () => {}); // Worker can exit without consuming stdin.
let timedOut = false;
const timer = setTimeout(() => {
  timedOut = true;
  console.error(`Worker timed out after ${seconds}s. Outcome may be uncertain; retry the same operation.`);
  if (process.platform === "win32") {
    spawnSync("taskkill", ["/pid", String(child.pid), "/T", "/F"], { windowsHide: true, timeout: 5000 });
    child.kill("SIGKILL");
  } else {
    try { process.kill(-child.pid, "SIGKILL"); } catch (error) {
      if (error.code !== "ESRCH") throw error;
    }
  }
}, seconds * 1000);
child.on("error", (error) => {
  clearTimeout(timer);
  console.error(error.message);
  process.exit(1);
});
child.on("exit", (code) => {
  clearTimeout(timer);
  process.exit(timedOut ? 124 : (code ?? 1));
});
