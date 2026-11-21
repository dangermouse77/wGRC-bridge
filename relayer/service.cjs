const { spawn } = require("node:child_process");
const { resolve } = require("node:path");

function options(args, env = process.env) {
  const explicit = args.length > 0 && !args[0].startsWith("--");
  const height = explicit ? args[0] : "auto";
  const flags = explicit ? args.slice(1) : args;
  if ((height !== "auto" && (!/^\d+$/.test(height) || Number(height) > 0xffffffff))
      || new Set(flags).size !== flags.length
      || flags.some((flag) => !["--once", "--enable-payouts"].includes(flag))) {
    throw new Error("Usage: wgrc serve [START_HEIGHT] [--once] [--enable-payouts]");
  }
  const batch = env.WGRC_GRIDCOIN_BATCH_SIZE ?? "50";
  if (!/^\d+$/.test(batch) || Number(batch) < 1 || Number(batch) > 10000) {
    throw new Error("WGRC_GRIDCOIN_BATCH_SIZE must be an integer between 1 and 10000.");
  }
  return { height, batchSize: String(Number(batch)), once: flags.includes("--once"), payouts: flags.includes("--enable-payouts") };
}

async function cycle(config, run, stopping = () => false, reconcile = true) {
  let healthy = true;
  async function step(args) {
    if (stopping()) return false;
    const success = await run(args);
    healthy = success && healthy;
    return success;
  }
  const gridcoin = await step(["watch-gridcoin", config.height, "--once", "--mint", "--max-blocks", config.batchSize]);
  const solana = await step(["watch-solana", "--once"]);
  // Recovery remains available even when a watcher is temporarily unavailable.
  const recovery = await step(["recover-redemptions", "--once"]);
  const cancellations = await step(["recover-cancellations"]);
  if (config.payouts && gridcoin && solana && recovery && cancellations) {
    await step(["process-redemptions"]);
  }
  if (reconcile) await step(["reconcile-reserve"]);
  return healthy;
}

async function main(args) {
  const config = options(args);
  const binary = resolve(process.env.WGRC_RELAYER_BIN ?? "target/release/wgrc-relayer");
  let stopping = false;
  let wake;
  const stop = () => {
    stopping = true;
    console.error("Bridge stopping after the active command; saved operations resume on restart.");
    wake?.();
  };
  process.on("SIGTERM", stop);
  process.on("SIGINT", stop);
  const run = (command) => new Promise((done) => {
    console.error(`[bridge] ${command.join(" ")}`);
    const child = spawn(binary, command, { stdio: ["ignore", "inherit", "inherit"] });
    child.on("error", (error) => { console.error(error.message); done(false); });
    child.on("exit", (code, signal) => {
      if (code !== 0) console.error(`[bridge] command failed (${signal ?? code}); retrying next cycle.`);
      done(code === 0);
    });
  });
  console.error(`Bridge service started; new payouts ${config.payouts ? "ENABLED" : "disabled"}.`);
  let nextReport = 0;
  let delay = 15000;
  while (!stopping) {
    const report = Date.now() >= nextReport;
    const healthy = await cycle(config, run, () => stopping, report);
    if (report) nextReport = Date.now() + 300000;
    if (config.once) { process.exitCode = healthy ? 0 : 1; break; }
    delay = healthy ? 15000 : Math.min(delay * 2, 120000);
    if (!stopping) await new Promise((done) => {
      const timer = setTimeout(done, delay);
      wake = () => { clearTimeout(timer); done(); };
    });
    wake = undefined;
  }
}

module.exports = { options, cycle, main };
if (require.main === module) main(process.argv.slice(2)).catch((error) => {
  console.error(error.message);
  process.exitCode = 1;
});
