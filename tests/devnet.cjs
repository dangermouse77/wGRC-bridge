const assert = require("node:assert/strict");
const { randomBytes } = require("node:crypto");
const { test } = require("node:test");
const { AnchorProvider, BN, Program } = require("@anchor-lang/core");
const {
  createAssociatedTokenAccountIdempotentInstruction,
  getAccount,
  getAssociatedTokenAddressSync,
  TOKEN_PROGRAM_ID,
} = require("@solana/spl-token");
const { SystemProgram, PublicKey, Transaction } = require("@solana/web3.js");
const idl = require("../target/idl/wgrc_bridge.json");

test("mints wGRC, locks it in escrow, and burns it on Devnet settlement", async () => {
  assert.equal(
    process.env.ANCHOR_PROVIDER_URL,
    "https://api.devnet.solana.com",
    "Set ANCHOR_PROVIDER_URL to the public Solana Devnet endpoint.",
  );
  const environment = AnchorProvider.env();
  const provider = new AnchorProvider(environment.connection, environment.wallet, {
    commitment: "confirmed",
    preflightCommitment: "confirmed",
  });
  const program = new Program(idl, provider);
  const { connection } = provider;
  const operator = provider.wallet.publicKey;
  const pda = (seed, ...seeds) =>
    PublicKey.findProgramAddressSync([Buffer.from(seed), ...seeds], program.programId)[0];
  const bridge = pda("bridge");
  const mint = pda("mint");
  const gridcoinAddress = process.env.WGRC_TESTNET_GRIDCOIN_ADDRESS;
  assert.ok(gridcoinAddress, "Set WGRC_TESTNET_GRIDCOIN_ADDRESS to a Gridcoin testnet address.");
  const settings = await program.account.bridge.fetch(bridge, "confirmed");
  assert.equal(settings.paused, false);
  if (!settings.mintOperator.equals(operator) && process.env.WGRC_ROTATE_DEVNET_OPERATOR === "1") {
    assert.ok(settings.admin.equals(operator), "Only the Devnet bridge admin can rotate the operator.");
    await program.methods.setMintOperator(operator).accountsStrict({
      admin: operator,
      bridge,
    }).rpc();
  }
  const currentSettings = await program.account.bridge.fetch(bridge, "confirmed");
  assert.ok(
    currentSettings.mintOperator.equals(operator),
    `Configured mint operator is ${currentSettings.mintOperator}. Use its wallet or rotate it as bridge admin.`,
  );

  const account = getAssociatedTokenAddressSync(mint, operator);
  const balanceBefore = await connection.getAccountInfo(account, "confirmed")
    ? (await getAccount(connection, account, "confirmed")).amount
    : 0n;
  const depositId = randomBytes(32);
  const nonceBytes = randomBytes(8);
  const nonce = new BN(nonceBytes, "le");
  const depositReceipt = pda("deposit", depositId);
  const withdrawal = pda("withdrawal", operator.toBuffer(), nonceBytes);
  const vault = pda("vault", withdrawal.toBuffer());
  const amount = new BN(1);
  const common = { bridge, mint, tokenProgram: TOKEN_PROGRAM_ID, systemProgram: SystemProgram.programId };
  const mintInstruction = await program.methods.mintDeposit([...depositId], amount).accountsStrict({
    ...common,
    mintOperator: operator,
    recipient: operator,
    recipientTokens: account,
    depositReceipt,
  }).instruction();
  const lockInstruction = await program.methods.requestWithdrawal(nonce, amount, gridcoinAddress)
    .accountsStrict({
      ...common,
      owner: operator,
      ownerTokens: account,
      withdrawal,
      vault,
    }).instruction();
  const payoutTxid = [...randomBytes(32)];
  const settleInstruction = await program.methods.settleWithdrawal(payoutTxid).accountsStrict({
    bridge, mint, withdrawal, vault, mintOperator: operator, tokenProgram: TOKEN_PROGRAM_ID,
  }).instruction();

  // Mint and burn atomically, including if the withdrawal address is rejected.
  const transaction = new Transaction().add(
    createAssociatedTokenAccountIdempotentInstruction(operator, account, operator, mint),
    mintInstruction,
    lockInstruction,
    settleInstruction,
  );
  const signature = await provider.sendAndConfirm(transaction);
  console.log(`Devnet transaction: ${signature}`);

  const [receipt, request, tokenAccount] = await Promise.all([
    program.account.depositReceipt.fetch(depositReceipt, "confirmed"),
    program.account.escrowWithdrawal.fetch(withdrawal, "confirmed"),
    getAccount(connection, account, "confirmed"),
  ]);
  assert.deepEqual(Buffer.from(receipt.depositId), depositId);
  assert.ok(receipt.recipient.equals(operator));
  assert.ok(receipt.amount.eq(amount));
  assert.ok(request.owner.equals(operator));
  assert.ok(request.nonce.eq(nonce));
  assert.ok(request.amount.eq(amount));
  assert.equal(request.gridcoinAddress, gridcoinAddress);
  assert.deepEqual(request.status.settled.gridcoinTxid, payoutTxid);
  assert.equal(tokenAccount.amount, balanceBefore);
});
