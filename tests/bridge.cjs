const assert = require("node:assert/strict");
const { test } = require("node:test");
const { AnchorProvider, BN, Program } = require("@anchor-lang/core");
const {
  createAssociatedTokenAccountInstruction,
  getAccount,
  getAssociatedTokenAddressSync,
  getMint,
  TOKEN_PROGRAM_ID,
} = require("@solana/spl-token");
const { Keypair, PublicKey, SystemProgram, Transaction } = require("@solana/web3.js");
const idl = require("../target/idl/wgrc_bridge.json");

const UPGRADEABLE_LOADER = new PublicKey("BPFLoaderUpgradeab1e11111111111111111111111");
// A Base58Check fixture. Gridcoin network validation happens outside the program.
const WITHDRAWAL_ADDRESS = "1BoatSLRHtKNngkdXEeobR76b53LETtpyT";

test("mints and redeems wGRC once per deposit ID and withdrawal nonce", async () => {
  const { hostname } = new URL(process.env.ANCHOR_PROVIDER_URL ?? "http://invalid");
  assert.ok(
    ["127.0.0.1", "localhost", "[::1]"].includes(hostname),
    "Run this test with anchor test --provider.cluster localnet.",
  );
  const environment = AnchorProvider.env();
  const provider = new AnchorProvider(environment.connection, environment.wallet, {
    commitment: "confirmed",
    preflightCommitment: "confirmed",
  });
  const program = new Program(idl, provider);
  const { connection } = provider;
  const admin = provider.wallet.publicKey;
  const operator = Keypair.generate();
  const holder = Keypair.generate();

  const pda = (seed, ...seeds) =>
    PublicKey.findProgramAddressSync([Buffer.from(seed), ...seeds], program.programId)[0];
  const bridge = pda("bridge");
  const mint = pda("mint");
  const [programData] = PublicKey.findProgramAddressSync(
    [program.programId.toBuffer()],
    UPGRADEABLE_LOADER,
  );
  const tokenAccount = getAssociatedTokenAddressSync(mint, holder.publicKey);
  const commonAccounts = {
    bridge,
    mint,
    tokenProgram: TOKEN_PROGRAM_ID,
    systemProgram: SystemProgram.programId,
  };

  await program.methods.initialize(operator.publicKey).accountsStrict({
    ...commonAccounts,
    upgradeAuthority: admin,
    program: program.programId,
    programData,
  }).rpc();

  const settings = await program.account.bridge.fetch(bridge, "confirmed");
  assert.ok(settings.admin.equals(admin));
  assert.ok(settings.mintOperator.equals(operator.publicKey));
  assert.equal(settings.paused, false);

  const setup = new Transaction();
  for (const signer of [operator, holder]) {
    setup.add(SystemProgram.transfer({
      fromPubkey: admin,
      toPubkey: signer.publicKey,
      lamports: 10_000_000,
    }));
  }
  setup.add(createAssociatedTokenAccountInstruction(admin, tokenAccount, holder.publicKey, mint));
  await provider.sendAndConfirm(setup);

  async function assertSupplyAndBalance(expected) {
    const mintState = await getMint(connection, mint, "confirmed");
    assert.equal(mintState.decimals, 8);
    assert.ok(mintState.mintAuthority?.equals(mint));
    assert.equal(mintState.supply, expected);
    assert.equal((await getAccount(connection, tokenAccount, "confirmed")).amount, expected);
  }

  const depositId = Buffer.alloc(32, 1);
  const receiptAddress = pda("deposit", depositId);
  const mintAmount = 300_000_000;

  function mintDeposit(signer, amount) {
    return program.methods.mintDeposit([...depositId], new BN(amount)).accountsStrict({
      ...commonAccounts,
      mintOperator: signer.publicKey,
      recipient: holder.publicKey,
      recipientTokens: tokenAccount,
      depositReceipt: receiptAddress,
    }).signers([signer]).rpc();
  }

  await assert.rejects(mintDeposit(holder, mintAmount), /Error Code: Unauthorized\b/);
  assert.equal(await connection.getAccountInfo(receiptAddress, "confirmed"), null);
  await assertSupplyAndBalance(0n);

  await mintDeposit(operator, mintAmount);
  const receipt = await program.account.depositReceipt.fetch(receiptAddress, "confirmed");
  assert.deepEqual(Buffer.from(receipt.depositId), depositId);
  assert.ok(receipt.recipient.equals(holder.publicKey));
  assert.equal(receipt.amount.toNumber(), mintAmount);
  await assertSupplyAndBalance(BigInt(mintAmount));

  // Change the amount so the replay is a distinct Solana transaction.
  await assert.rejects(mintDeposit(operator, mintAmount + 1), /already in use/i);
  await assertSupplyAndBalance(BigInt(mintAmount));

  const nonce = new BN(42);
  const withdrawalAddress = pda(
    "withdrawal",
    holder.publicKey.toBuffer(),
    nonce.toArrayLike(Buffer, "le", 8),
  );
  const burnAmount = 100_000_000;

  function requestWithdrawal(amount, address) {
    return program.methods.requestWithdrawal(nonce, new BN(amount), address).accountsStrict({
      ...commonAccounts,
      owner: holder.publicKey,
      ownerTokens: tokenAccount,
      withdrawal: withdrawalAddress,
    }).signers([holder]).rpc();
  }

  await assert.rejects(
    requestWithdrawal(burnAmount, "invalid"),
    /Error Code: InvalidGridcoinAddress\b/,
  );
  assert.equal(await connection.getAccountInfo(withdrawalAddress, "confirmed"), null);
  await assertSupplyAndBalance(BigInt(mintAmount));

  await requestWithdrawal(burnAmount, WITHDRAWAL_ADDRESS);
  const withdrawal = await program.account.withdrawalRequest.fetch(withdrawalAddress, "confirmed");
  assert.ok(withdrawal.owner.equals(holder.publicKey));
  assert.equal(withdrawal.nonce.toNumber(), nonce.toNumber());
  assert.equal(withdrawal.amount.toNumber(), burnAmount);
  assert.equal(withdrawal.gridcoinAddress, WITHDRAWAL_ADDRESS);
  await assertSupplyAndBalance(BigInt(mintAmount - burnAmount));

  await assert.rejects(requestWithdrawal(burnAmount + 1, WITHDRAWAL_ADDRESS), /already in use/i);
  await assertSupplyAndBalance(BigInt(mintAmount - burnAmount));
});
