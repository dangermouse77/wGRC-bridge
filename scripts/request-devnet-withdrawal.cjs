const assert = require("node:assert/strict");
const { randomBytes } = require("node:crypto");
const { AnchorProvider, BN, Program } = require("@anchor-lang/core");
const { getAssociatedTokenAddressSync, TOKEN_PROGRAM_ID } = require("@solana/spl-token");
const { PublicKey, SystemProgram } = require("@solana/web3.js");
const { baseUnits, connectTestnet } = require("./gridcoin-deposit.cjs");

async function main() {
  const [destination, value, ...extra] = process.argv.slice(2);
  assert.ok(destination && value && !extra.length,
    "Usage: node scripts/request-devnet-withdrawal.cjs GRIDCOIN_TESTNET_ADDRESS AMOUNT_WGRC");
  const amount = baseUnits(value);
  assert.ok(amount > 0n, "Withdrawal amount must be positive.");
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
  const nonce = randomBytes(8);
  const withdrawal = pda("withdrawal", owner.toBuffer(), nonce);
  // Print the PDA before submission so the request can be looked up after an RPC timeout.
  console.error(`Withdrawal address: ${withdrawal.toBase58()}`);
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
  console.log(JSON.stringify({ withdrawalAddress: withdrawal.toBase58(), signature }));
}

main().catch((error) => {
  console.error(error.message);
  process.exitCode = 1;
});
