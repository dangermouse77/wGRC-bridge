const assert = require("node:assert/strict");
const { Program } = require("@anchor-lang/core");
const { Connection, PublicKey } = require("@solana/web3.js");

const DEVNET_URL = "https://api.devnet.solana.com";
const PROGRAM_ID = "AvqkRykFXfx31fDYnJq7kPkNpgiMA6LbknavHMvjz3Zy";
const ACCOUNT = "escrowWithdrawal";

async function scanWithdrawals(program, minimumSlot) {
  const { programId, coder } = program;
  const snapshot = await program.provider.connection.getProgramAccounts(programId, {
    commitment: "finalized",
    withContext: true,
    minContextSlot: minimumSlot,
    filters: [{ memcmp: coder.accounts.memcmp(ACCOUNT) }],
  });
  const slot = snapshot.context.slot;
  assert.ok(Number.isSafeInteger(slot) && slot >= minimumSlot, "Invalid finalized snapshot slot.");

  const withdrawals = snapshot.value.map(({ pubkey, account }) => decodeWithdrawal(program, pubkey, account));
  return { slot, withdrawals };
}

function decodeWithdrawal(program, pubkey, account) {
  const { programId, coder } = program;
  assert.ok(account.owner.equals(programId), "Unexpected withdrawal account owner.");
  const request = coder.accounts.decode(ACCOUNT, account.data);
  const [address] = PublicKey.findProgramAddressSync([
    Buffer.from("withdrawal"),
    request.owner.toBuffer(),
    request.nonce.toArrayLike(Buffer, "le", 8),
  ], programId);
  assert.ok(address.equals(pubkey), "Withdrawal address does not match its owner and nonce.");
  assert.ok(!request.amount.isZero(), "Invalid zero withdrawal amount.");

  const [status] = Object.keys(request.status);
  assert.ok(["pending", "settled", "cancelled"].includes(status), "Unknown withdrawal status.");
  let gridcoinPayoutTxid = null;
  if (status === "settled") {
    const bytes = Buffer.from(request.status.settled.gridcoinTxid);
    assert.ok(bytes.length === 32 && bytes.some((byte) => byte !== 0), "Invalid payout transaction ID.");
    gridcoinPayoutTxid = bytes.toString("hex");
  }
  return {
    address: address.toBase58(),
    owner: request.owner.toBase58(),
    nonce: request.nonce.toString(),
    amountBaseUnits: request.amount.toString(),
    gridcoinAddress: request.gridcoinAddress,
    status,
    gridcoinPayoutTxid,
  };
}

function devnetProgram() {
  const endpoint = process.env.ANCHOR_PROVIDER_URL ?? DEVNET_URL;
  assert.equal(endpoint, DEVNET_URL, "The Solana watcher requires the public Devnet RPC URL.");
  const idl = require("../target/idl/wgrc_bridge.json");
  const connection = new Connection(endpoint, {
    commitment: "finalized",
    fetch: (input, init) => fetch(input, { ...init, signal: AbortSignal.timeout(30_000) }),
  });
  const program = new Program(idl, { connection });
  assert.equal(program.programId.toBase58(), PROGRAM_ID, "Unexpected Devnet bridge program.");
  return program;
}

async function main() {
  const minimumSlot = Number(process.argv[2]);
  assert.ok(Number.isSafeInteger(minimumSlot) && minimumSlot >= 0, "Invalid minimum slot.");
  console.log(JSON.stringify(await scanWithdrawals(devnetProgram(), minimumSlot)));
}

module.exports = { scanWithdrawals, decodeWithdrawal, devnetProgram };
if (require.main === module) {
  main().catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
}
