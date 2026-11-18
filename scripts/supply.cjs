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
  if (new Set(args).size !== args.length || args.some((arg) => !["--pending-deposits", "--pending-payouts"].includes(arg))) {
    throw new Error("Usage: supply.cjs [--pending-deposits] [--pending-payouts]");
  }
  const includePending = args.includes("--pending-deposits");
  const includePayouts = args.includes("--pending-payouts");
  let payoutRecords;
  if (includePayouts) {
    const { promisify } = require("node:util");
    const { execFile } = require("node:child_process");
    const { resolve } = require("node:path");
    const { stdout } = await promisify(execFile)(
      process.env.WGRC_RELAYER_BIN || resolve("target/release/wgrc-relayer"), ["payout-records"],
      { timeout: 45000, maxBuffer: 4 * 1024 * 1024 },
    );
    payoutRecords = JSON.parse(stdout);
  }
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
  const withdrawals = new Map();
  for (const { pubkey, account: { data } } of snapshot.value) {
    if (data.subarray(0, receiptTag.length).equals(receiptTag)) {
      const receipt = coder.accounts.decode("depositReceipt", data);
      minted += BigInt(receipt.amount.toString());
      receipts.set(Buffer.from(receipt.depositId).toString("hex"), {
        amount: receipt.amount.toString(), recipient: receipt.recipient.toBase58(),
      });
    } else if (data.subarray(0, escrowTag.length).equals(escrowTag)) {
      const withdrawal = coder.accounts.decode("escrowWithdrawal", data);
      withdrawals.set(pubkey.toBase58(), { amount: withdrawal.amount.toString(),
        destination: withdrawal.gridcoinAddress, status: Object.keys(withdrawal.status)[0] });
      if (Object.hasOwn(withdrawal.status, "pending")) {
        locked += BigInt(withdrawal.amount.toString());
      }
    }
  }
  if (supply > minted || locked > supply) {
    throw new Error("Program records and mint supply disagree. Check the RPC and try again.");
  }

  let pending;
  let payouts;
  if (includePending || includePayouts) {
    const { connectTestnet, deposit, InvalidDeposit, resolveGridcoinAddress } = require("./gridcoin-deposit.cjs");
    const reserveAddress = process.env.WGRC_TESTNET_RESERVE_ADDRESS;
    if (!reserveAddress) throw new Error("Set WGRC_TESTNET_RESERVE_ADDRESS or use wgrc supply --pending-deposits.");
    const reserve = await connectTestnet(reserveAddress);
    if (includePending) pending = await require("./pending-deposits.cjs").pendingDeposits(
      reserve.rpc, reserve, receipts, deposit, InvalidDeposit,
    );
    if (includePayouts) {
      const { findPayout, validateOutputs } = require("../relayer/redeem-devnet.cjs");
      const tip = await reserve.rpc("getbestblockhash");
      payouts = await require("./pending-payouts.cjs").pendingPayouts(payoutRecords, withdrawals,
        (txid) => findPayout(reserve.rpc, txid), async (tx, payout) => {
          const destination = await resolveGridcoinAddress(reserve.rpc, payout.gridcoinAddress);
          validateOutputs(tx, destination.script, reserve.script, BigInt(payout.amountBaseUnits));
        });
      if (await reserve.rpc("getbestblockhash") !== tip) throw new Error("Gridcoin tip changed during payout inspection. Retry.");
    }
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
  console.log(payouts
    ? `GRC payouts awaiting confirmation: ${formatAmount(payouts.total, 8)} GRC (${payouts.count} payouts; fewer than ${payouts.minimum} confirmations)`
    : "GRC payouts awaiting confirmation: not checked (use --pending-payouts)");
  if (payouts?.unobserved) console.log(`Saved payouts not found on Gridcoin: ${payouts.unobserved} (excluded; broadcast status unknown, inspect recovery).`);
}

main().catch((error) => {
  console.error(error.message);
  process.exitCode = 1;
});
