const { Program } = require("@anchor-lang/core");
const { unpackMint } = require("@solana/spl-token");
const { Connection, PublicKey } = require("@solana/web3.js");

function formatAmount(amount, decimals) {
  const scale = 10n ** BigInt(decimals);
  const fraction = (amount % scale).toString().padStart(decimals, "0").replace(/0+$/, "");
  return fraction ? `${amount / scale}.${fraction}` : (amount / scale).toString();
}

async function main() {
  const args = process.argv.slice(2);
  if (args.length && (args.length !== 1 || args[0] !== "--pending-deposits")) {
    throw new Error("Usage: supply.cjs [--pending-deposits]");
  }
  const includePending = args.length === 1;
  const idl = require("../target/idl/wgrc_bridge.json");
  const connection = new Connection(
    process.env.ANCHOR_PROVIDER_URL ?? "https://api.devnet.solana.com",
    "finalized",
  );
  const program = new Program(idl, { connection });
  const { programId, coder } = program;
  const [mint] = PublicKey.findProgramAddressSync([Buffer.from("mint")], programId);
  const before = await connection.getAccountInfoAndContext(mint);
  const snapshot = await connection.getProgramAccounts(programId, {
    commitment: "finalized",
    minContextSlot: before.context.slot,
    withContext: true,
  });
  const after = await connection.getAccountInfoAndContext(mint, {
    commitment: "finalized",
    minContextSlot: snapshot.context.slot,
  });
  const { supply, decimals } = unpackMint(mint, after.value);
  if (unpackMint(mint, before.value).supply !== supply) {
    throw new Error("Mint supply changed during the read. Run the command again.");
  }

  const discriminator = (name) => {
    const account = program.idl.accounts?.find((entry) => entry.name === name);
    if (!account) throw new Error(`IDL is missing ${name}. Run anchor build.`);
    return Buffer.from(account.discriminator);
  };
  const receiptTag = discriminator("depositReceipt");
  const escrowTag = discriminator("escrowWithdrawal");
  let minted = 0n;
  let locked = 0n;
  const receipts = new Map();
  for (const { account: { data } } of snapshot.value) {
    if (data.subarray(0, receiptTag.length).equals(receiptTag)) {
      const receipt = coder.accounts.decode("depositReceipt", data);
      minted += BigInt(receipt.amount.toString());
      receipts.set(Buffer.from(receipt.depositId).toString("hex"), {
        amount: receipt.amount.toString(), recipient: receipt.recipient.toBase58(),
      });
    } else if (data.subarray(0, escrowTag.length).equals(escrowTag)) {
      const withdrawal = coder.accounts.decode("escrowWithdrawal", data);
      if (Object.hasOwn(withdrawal.status, "pending")) {
        locked += BigInt(withdrawal.amount.toString());
      }
    }
  }
  if (supply > minted || locked > supply) {
    throw new Error("Program records and mint supply disagree. Check the RPC and try again.");
  }

  let pending;
  if (includePending) {
    const { connectTestnet, deposit, InvalidDeposit } = require("./gridcoin-deposit.cjs");
    const reserveAddress = process.env.WGRC_TESTNET_RESERVE_ADDRESS;
    if (!reserveAddress) throw new Error("Set WGRC_TESTNET_RESERVE_ADDRESS or use wgrc supply --pending-deposits.");
    const reserve = await connectTestnet(reserveAddress);
    pending = await require("./pending-deposits.cjs").pendingDeposits(
      reserve.rpc, reserve, receipts, deposit, InvalidDeposit,
    );
    const latest = await connection.getAccountInfoAndContext(mint, {
      commitment: "finalized", minContextSlot: after.context.slot,
    });
    if (unpackMint(mint, latest.value).supply !== supply) {
      throw new Error("Mint supply changed during pending deposit inspection. Retry.");
    }
  }

  console.log(`Mint: ${mint}`);
  for (const [label, amount] of [
    ["Total minted", minted],
    ["Locked in pending withdrawals", locked],
    ["Total burned", minted - supply],
    ["Circulating (minted - burned)", supply],
    ["Supply outside pending escrow", supply - locked],
  ]) {
    console.log(`${label}: ${formatAmount(amount, decimals)} wGRC (${amount} base units)`);
  }
  console.log(`Finalized slots: bridge records ${snapshot.context.slot}, mint ${after.context.slot}`);
  console.log(pending
    ? `Locked in pending deposits: ${formatAmount(pending.total, 8)} GRC (${pending.total} base units; ${pending.count} unspent deposits)`
    : "Locked in pending deposits: not checked (use --pending-deposits with reserve-wallet RPC)");
  if (pending) console.log(`Gridcoin snapshot tip: ${pending.tip}; includes unconfirmed deposits visible to the wallet.`);
}

main().catch((error) => {
  console.error(error.message);
  process.exitCode = 1;
});
