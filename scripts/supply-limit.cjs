const assert = require("node:assert/strict");
const MAX_U64 = (1n << 64n) - 1n;

function parseAmount(value) {
  assert.match(value, /^\d+(?:\.\d{1,8})?$/, "Use a plain wGRC amount with at most eight decimals.");
  const [whole, fraction = ""] = value.split(".");
  const amount = BigInt(whole) * 100000000n + BigInt(fraction.padEnd(8, "0"));
  assert.ok(amount <= MAX_U64, "Amount exceeds the token limit.");
  return amount;
}

function checkCapacity(supply, maximum, amount) {
  assert.ok(amount > 0n && supply >= 0n && maximum >= 0n && maximum <= MAX_U64);
  assert.ok(supply + amount <= maximum,
    "Deposit rejected: minting this amount would exceed the configured wGRC supply cap. No Gridcoin transaction was broadcast by this attempt.");
}

function client() {
  const { Program } = require("@anchor-lang/core");
  const { Connection, PublicKey } = require("@solana/web3.js");
  const url = process.env.ANCHOR_PROVIDER_URL ?? "https://api.devnet.solana.com";
  assert.equal(url, "https://api.devnet.solana.com", "Supply limit tooling currently requires Solana Devnet.");
  const connection = new Connection(url, { commitment: "finalized",
    fetch: (input, init) => fetch(input, { ...init, signal: AbortSignal.timeout(30000) }),
  });
  const program = new Program(require("../target/idl/wgrc_bridge.json"), { connection });
  assert.equal(program.programId.toBase58(), "AvqkRykFXfx31fDYnJq7kPkNpgiMA6LbknavHMvjz3Zy");
  const pda = (seed) => PublicKey.findProgramAddressSync([Buffer.from(seed)], program.programId)[0];
  return { connection, program, bridge: pda("bridge"), mint: pda("mint"), supplyLimit: pda("supply_limit") };
}

async function readLimit() {
  const { unpackMint } = require("@solana/spl-token");
  const { connection, program, bridge, mint, supplyLimit } = client();
  const [settings, limit, token] = await connection.getMultipleAccountsInfo([bridge, supplyLimit, mint], "finalized");
  assert.ok(settings && limit && token, "Supply cap is not initialized. Do not send a deposit; ask the bridge admin to initialize it.");
  assert.ok(settings.owner.equals(program.programId) && limit.owner.equals(program.programId));
  const state = program.coder.accounts.decode("bridge", settings.data);
  return { paused: state.paused, supply: unpackMint(mint, token).supply,
    maximum: BigInt(program.coder.accounts.decode("supplyLimit", limit.data).maxSupply.toString()) };
}

async function assertDepositCapacity(amount) {
  const { supply, maximum, paused } = await readLimit();
  assert.equal(paused, false, "Bridge is paused; do not send a deposit.");
  checkCapacity(supply, maximum, BigInt(amount));
}

async function main() {
  const [mode, value, ...rest] = process.argv.slice(2);
  assert.ok(!rest.length && ((mode === "initialize" || mode === "show") && value === undefined
    || mode === "set" && value !== undefined), "Usage: supply-limit.cjs initialize | show | set AMOUNT_WGRC");
  if (mode === "show") {
    const { supply, maximum } = await readLimit();
    console.log(JSON.stringify({ supplyBaseUnits: String(supply), maxSupplyBaseUnits: String(maximum) }));
    return;
  }
  const { AnchorProvider, Program, BN } = require("@anchor-lang/core");
  const { SystemProgram } = require("@solana/web3.js");
  const { connection, program: reader, bridge, mint, supplyLimit } = client();
  const provider = new AnchorProvider(connection, AnchorProvider.env().wallet,
    { commitment: "finalized", preflightCommitment: "confirmed" });
  const program = new Program(reader.idl, provider);
  const admin = provider.wallet.publicKey;
  assert.ok((await program.account.bridge.fetch(bridge, "finalized")).admin.equals(admin), "Use the bridge administrator wallet.");
  const instruction = mode === "initialize"
    ? program.methods.initializeSupplyLimit().accountsStrict({ admin, bridge, mint, supplyLimit, systemProgram: SystemProgram.programId })
    : program.methods.setMaxSupply(new BN(parseAmount(value).toString())).accountsStrict({ admin, bridge, mint, supplyLimit });
  console.log(JSON.stringify({ signature: await instruction.rpc() }));
}

module.exports = { parseAmount, checkCapacity, assertDepositCapacity };
if (require.main === module) main().catch((error) => { console.error(error.message); process.exitCode = 1; });
