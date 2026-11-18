const assert = require("node:assert/strict");
const { mkdirSync, writeFileSync, readFileSync } = require("node:fs");
const { resolve, join } = require("node:path");
const { parseRequest, verifyExisting } = require("./withdrawal-request.cjs");
const { AnchorProvider, BN, Program } = require("@anchor-lang/core");
const { getAssociatedTokenAddressSync, TOKEN_PROGRAM_ID } = require("@solana/spl-token");
const { PublicKey, SystemProgram } = require("@solana/web3.js");
const { connectTestnet } = require("./gridcoin-deposit.cjs");

async function main() {
  const { destination, amount, nonce: nonceString } = parseRequest(process.argv.slice(2));
  assert.equal(process.env.ANCHOR_PROVIDER_URL, "https://api.devnet.solana.com", "Use the Solana Devnet RPC.");
  const { address } = await connectTestnet(destination);
  const environment = AnchorProvider.env();
  const provider = new AnchorProvider(environment.connection, environment.wallet, {
    commitment: "finalized",
    preflightCommitment: "confirmed",
  });
  const idl = require("../target/idl/wgrc_bridge.json");
  const program = new Program(idl, provider);
  assert.equal(program.programId.toBase58(), "AvqkRykFXfx31fDYnJq7kPkNpgiMA6LbknavHMvjz3Zy");
  const pda = (seed, ...parts) =>
    PublicKey.findProgramAddressSync([Buffer.from(seed), ...parts], program.programId)[0];
  const owner = provider.wallet.publicKey;
  const mint = pda("mint");
  const nonce = Buffer.alloc(8);
  nonce.writeBigUInt64LE(BigInt(nonceString));
  const withdrawal = pda("withdrawal", owner.toBuffer(), nonce);
  const request = { withdrawalAddress: withdrawal.toBase58(), owner: owner.toBase58(),
    nonce: nonceString, amountBaseUnits: amount.toString(), gridcoinAddress: address.address };
  const directory = resolve("withdrawals");
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  const file = join(directory, `${withdrawal.toBase58()}.json`);
  try {
    writeFileSync(file, JSON.stringify(request, null, 2) + "\n", { flag: "wx", mode: 0o600 });
  } catch (error) {
    if (error.code !== "EEXIST") throw error;
    assert.deepEqual(JSON.parse(readFileSync(file, "utf8")), request, "Saved request differs; do not reuse this nonce.");
  }
  console.error(`Saved withdrawal request: ${file}`);
  console.error(`Withdrawal address: ${withdrawal.toBase58()}`);
  console.error(`For an uncertain submission, retry the same amount and destination with --nonce ${nonceString}.`);
  const existing = await program.account.escrowWithdrawal.fetchNullable(withdrawal, "finalized");
  if (existing) {
    console.log(JSON.stringify({ ...request, status: verifyExisting(existing, request), alreadySubmitted: true, signature: null }));
    return;
  }
  const signature = await program.methods.requestWithdrawal(
    new BN(nonce, "le"), new BN(amount.toString()), address.address,
  ).accountsStrict({
    owner,
    bridge: pda("bridge"),
    mint,
    ownerTokens: getAssociatedTokenAddressSync(mint, owner),
    withdrawal,
    vault: pda("vault", withdrawal.toBuffer()),
    tokenProgram: TOKEN_PROGRAM_ID,
    systemProgram: SystemProgram.programId,
  }).rpc();
  console.log(JSON.stringify({ ...request, status: "pending", signature }));
}

main().catch((error) => {
  console.error(error.message);
  process.exitCode = 1;
});
