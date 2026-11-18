const assert = require("node:assert/strict");
const { execFile } = require("node:child_process");
const { promisify } = require("node:util");
const { mkdir, writeFile } = require("node:fs/promises");
const { resolve, join } = require("node:path");
const { parseAmount } = require("./supply-limit.cjs");
const execute = promisify(execFile);

function parse(args) {
  assert.ok(args.length === 3 && args[1] === "--solana-address" && args[2],
    "Usage: wgrc deposit AMOUNT_GRC --solana-address ADDRESS");
  assert.ok(parseAmount(args[0]) > 0n, "Deposit amount must be positive.");
  return { amount: args[0], recipient: args[2] };
}

async function deposit(options, reserve, run, directory = resolve("deposits"), log = console.error) {
  assert.ok(reserve, "Missing configured Gridcoin reserve address.");
  const prepared = JSON.parse(await run(["create", reserve, options.amount, options.recipient]));
  assert.match(prepared.txid, /^[a-f0-9]{64}$/);
  assert.match(prepared.signedHex, /^(?:[a-f0-9]{2})+$/i);
  assert.equal(prepared.recipient, options.recipient);
  assert.equal(prepared.amountBaseUnits, parseAmount(options.amount).toString());
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const file = join(directory, `${prepared.txid}.json`);
  // Never broadcast until signed bytes have been saved, and never overwrite
  // an existing attempt. Retry an ambiguous broadcast using this exact file.
  await writeFile(file, JSON.stringify(prepared, null, 2) + "\n", { flag: "wx", mode: 0o600 });
  log(`Saved deposit transaction: ${file}`);
  try {
    const result = JSON.parse(await run(["broadcast", reserve, file]));
    assert.equal(result.txid, prepared.txid);
    return { ...result, depositFile: file };
  } catch (error) {
    throw new Error(`Broadcast outcome may be uncertain. Do not create another deposit. Retry with: bash bin/wgrc broadcast-deposit '${file}'\n${error.message}`);
  }
}

async function main() {
  const options = parse(process.argv.slice(2));
  const run = async (args) => {
    try {
      const { stdout, stderr } = await execute(process.execPath,
        [resolve("scripts/gridcoin-deposit.cjs"), ...args], { timeout: 120000, maxBuffer: 1024 * 1024 });
      if (stderr) process.stderr.write(stderr);
      return stdout;
    } catch (error) {
      throw new Error(error.stderr?.trim() || error.message);
    }
  };
  console.log(JSON.stringify(await deposit(options, process.env.WGRC_TESTNET_RESERVE_ADDRESS, run), null, 2));
}

module.exports = { parse, deposit };
if (require.main === module) main().catch((error) => { console.error(error.message); process.exitCode = 1; });
