const assert = require("node:assert/strict");
const { execFile } = require("node:child_process");
const { promisify } = require("node:util");
const { AnchorProvider, BN, Program } = require("@anchor-lang/core");
const {
  createAssociatedTokenAccountIdempotentInstruction,
  getAssociatedTokenAddressSync,
  TOKEN_PROGRAM_ID,
} = require("@solana/spl-token");
const { PublicKey, SystemProgram, Transaction } = require("@solana/web3.js");
const idl = require("../target/idl/wgrc_bridge.json");

const DEVNET_URL = "https://api.devnet.solana.com";
const PROGRAM_ID = "AvqkRykFXfx31fDYnJq7kPkNpgiMA6LbknavHMvjz3Zy";
const run = promisify(execFile);

async function main() {
  const [mode, reserve, minimum, input, expectedMint] = process.argv.slice(2);
  assert.ok(mode === "mint" || mode === "verify", "Expected mint or verify mode.");
  assert.equal(process.env.ANCHOR_PROVIDER_URL, DEVNET_URL, "Set the Solana Devnet RPC URL.");
  const deposit = JSON.parse(input);
  assert.match(deposit.depositId, /^[a-f0-9]{64}$/);
  const depositId = Buffer.from(deposit.depositId, "hex");
  const recipient = new PublicKey(deposit.recipient);
  const amount = new BN(deposit.amountBaseUnits);
  const environment = AnchorProvider.env();
  const provider = new AnchorProvider(environment.connection, environment.wallet, {
    commitment: "finalized",
    preflightCommitment: "confirmed",
  });
  const program = new Program(idl, provider);
  assert.equal(program.programId.toBase58(), PROGRAM_ID, "Unexpected Devnet bridge program.");
  const { connection } = provider;
  const operator = provider.wallet.publicKey;
  const pda = (seed, ...seeds) =>
    PublicKey.findProgramAddressSync([Buffer.from(seed), ...seeds], program.programId)[0];
  const bridge = pda("bridge");
  const mint = pda("mint");
  assert.equal(mint.toBase58(), expectedMint, "Configured wGRC mint differs from the Devnet bridge mint.");
  const depositReceipt = pda("deposit", depositId);

  async function hasMatchingReceipt() {
    const account = await connection.getAccountInfo(depositReceipt, "finalized");
    if (!account) return false;
    assert.ok(account.owner.equals(program.programId), "Unexpected receipt owner.");
    const receipt = program.coder.accounts.decode("depositReceipt", account.data);
    assert.deepEqual(Buffer.from(receipt.depositId), depositId);
    assert.ok(receipt.recipient.equals(recipient), "Receipt recipient differs from Gridcoin.");
    assert.ok(receipt.amount.eq(amount), "Receipt amount differs from Gridcoin.");
    return true;
  }

  let signature = null;
  if (!(await hasMatchingReceipt())) {
    assert.equal(mode, "mint", "The previously finalized receipt is missing. Reconcile before retrying.");
    const settings = await program.account.bridge.fetch(bridge, "finalized");
    assert.ok(settings.mintOperator.equals(operator), "Use the bridge's configured mint operator wallet.");
    assert.equal(settings.paused, false, "Bridge is paused.");

    const recipientTokens = getAssociatedTokenAddressSync(mint, recipient, true);
    const transaction = new Transaction().add(
      createAssociatedTokenAccountIdempotentInstruction(operator, recipientTokens, recipient, mint),
      await program.methods.mintDeposit([...depositId], amount).accountsStrict({
        bridge,
        mint,
        mintOperator: operator,
        recipient,
        recipientTokens,
        depositReceipt,
        tokenProgram: TOKEN_PROGRAM_ID,
        systemProgram: SystemProgram.programId,
      }).instruction(),
    );

    // Reuse the exact-amount active-chain validator before broadcasting.
    const { stdout } = await run(process.execPath, [
      "scripts/gridcoin-deposit.cjs", "check", reserve, deposit.txid, minimum,
    ]);
    const current = JSON.parse(stdout);
    for (const field of ["txid", "vout", "depositId", "recipient", "amountBaseUnits", "blockhash"]) {
      assert.equal(current[field], deposit[field], `Gridcoin deposit changed (${field}). Revalidate before retrying.`);
    }
    signature = await provider.sendAndConfirm(transaction);
    assert.ok(await hasMatchingReceipt(), "Mint has no finalized receipt. Retry the same deposit.");
  }
  console.log(JSON.stringify({ receipt: depositReceipt.toBase58(), signature }));
}

main().catch((error) => {
  console.error(error.stderr?.trim() || error.message);
  process.exitCode = 1;
});
