const assert = require("node:assert/strict");
const { createHash } = require("node:crypto");
const { readFileSync } = require("node:fs");
const { baseUnits, connectTestnet, resolveGridcoinAddress } = require("../scripts/gridcoin-deposit.cjs");
const { decodeWithdrawal, devnetProgram } = require("./scan-solana.cjs");
const { findPayout, validateOutputs } = require("./redeem-devnet.cjs");

const HASH = /^[a-f0-9]{64}$/;
const LEGACY_TAG = createHash("sha256").update("account:WithdrawalRequest").digest().subarray(0, 8);

function legacyAmount(data) {
  // Anchor can omit the retired account type from the IDL. Its historical
  // layout starts with discriminator, owner, nonce, amount, and address length.
  assert.ok(data.length >= 60 && data.subarray(0, 8).equals(LEGACY_TAG), "Invalid legacy withdrawal.");
  const addressLength = data.readUInt32LE(56);
  assert.ok(addressLength > 0 && addressLength <= 35 && data.length >= 60 + addressLength,
    "Invalid legacy withdrawal destination.");
  const amount = data.readBigUInt64LE(48);
  assert.ok(amount > 0n, "Invalid legacy withdrawal amount.");
  return amount;
}

async function solanaSnapshot(expectedMint) {
  const { unpackMint } = require("@solana/spl-token");
  const { PublicKey } = require("@solana/web3.js");
  const program = devnetProgram();
  const { programId, idl, provider: { connection } } = program;
  const [mint] = PublicKey.findProgramAddressSync([Buffer.from("mint")], programId);
  assert.equal(mint.toBase58(), expectedMint, "Unexpected Devnet wGRC mint.");
  const before = await connection.getAccountInfoAndContext(mint, { commitment: "finalized" });
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
  assert.equal(decimals, 8, "Expected an eight-decimal wGRC mint.");
  assert.equal(unpackMint(mint, before.value).supply, supply, "Mint supply changed during the scan. Retry.");
  const escrow = idl.accounts?.find((entry) => entry.name === "escrowWithdrawal");
  assert.ok(escrow, "IDL is missing escrowWithdrawal. Run anchor build.");
  const escrowTag = Buffer.from(escrow.discriminator);
  const withdrawals = [];
  const legacy = [];
  for (const { pubkey, account } of snapshot.value) {
    if (account.data.subarray(0, escrowTag.length).equals(escrowTag)) {
      withdrawals.push(decodeWithdrawal(program, pubkey, account));
    } else if (account.data.subarray(0, LEGACY_TAG.length).equals(LEGACY_TAG)) {
      assert.ok(account.owner.equals(programId), "Unexpected legacy withdrawal account owner.");
      legacy.push({ address: pubkey.toBase58(), amountBaseUnits: legacyAmount(account.data).toString() });
    }
  }
  return { supply, slot: snapshot.context.slot, withdrawals, legacy };
}

function reserveTotals(outputs, script, minimum) {
  assert.ok(Array.isArray(outputs), "Expected reserve wallet unspent outputs.");
  const outpoints = new Set();
  let confirmed = 0n;
  let spendable = 0n;
  for (const output of outputs) {
    assert.equal(typeof output.scriptPubKey, "string", "Missing reserve output script.");
    if (output.scriptPubKey !== script) continue;
    assert.match(output.txid, HASH);
    assert.ok(Number.isInteger(output.vout) && output.vout >= 0);
    assert.ok(Number.isSafeInteger(output.confirmations) && output.confirmations >= 1);
    const outpoint = `${output.txid}:${output.vout}`;
    assert.ok(!outpoints.has(outpoint), "Duplicate reserve output.");
    outpoints.add(outpoint);
    if (output.confirmations < minimum) continue;
    const amount = baseUnits(output.amount);
    confirmed += amount;
    if (output.spendable !== false) spendable += amount;
  }
  return { confirmed, spendable };
}

async function reconcileWithdrawals(snapshot, payouts, verifyPayout) {
  const saved = new Map(payouts.map((payout) => [payout.withdrawalAddress, payout]));
  const issues = [];
  let pendingEscrow = 0n;
  let confirmedPendingPayouts = 0n;
  let unverifiedSettled = 0n;
  let legacyObligations = 0n;
  for (const withdrawal of snapshot.withdrawals) {
    const { address, status, gridcoinPayoutTxid } = withdrawal;
    const amount = BigInt(withdrawal.amountBaseUnits);
    const payout = saved.get(address);
    saved.delete(address);
    if (status === "pending") pendingEscrow += amount;
    if (status === "cancelled") {
      if (payout) issues.push({ withdrawal: address, reason: "Cancelled withdrawal has a saved payout." });
      continue;
    }
    let verified = false;
    let reason;
    if (status === "settled" && payout?.txid !== gridcoinPayoutTxid) {
      reason = "Settlement has no matching relayer payout record.";
    } else if (payout) {
      try {
        verified = await verifyPayout(withdrawal, payout);
      } catch (error) {
        reason = error.message;
      }
    }
    if (status === "pending" && verified) confirmedPendingPayouts += amount;
    if (status === "settled" && !verified) {
      unverifiedSettled += amount;
      reason ??= "Settled payout is missing or below the confirmation threshold.";
    }
    if (reason) issues.push({ withdrawal: address, txid: payout?.txid ?? gridcoinPayoutTxid, reason });
  }
  for (const address of saved.keys()) {
    issues.push({ withdrawal: address, reason: "Saved payout has no finalized escrow withdrawal." });
  }
  for (const { address, amountBaseUnits } of snapshot.legacy) {
    legacyObligations += BigInt(amountBaseUnits);
    issues.push({ withdrawal: address, reason: "Legacy burn-first withdrawal requires payout reconciliation." });
  }
  assert.ok(pendingEscrow <= snapshot.supply, "Pending escrow exceeds finalized mint supply. Retry the scan.");
  const required = snapshot.supply - confirmedPendingPayouts + unverifiedSettled + legacyObligations;
  return { required, pendingEscrow, confirmedPendingPayouts, unverifiedSettled, legacyObligations, issues };
}

async function main() {
  const [reserveAddress, minimumArg, expectedMint] = process.argv.slice(2);
  const minimum = Number(minimumArg);
  assert.ok(/^\d+$/.test(minimumArg) && Number.isSafeInteger(minimum) && minimum > 0,
    "Expected a positive Gridcoin confirmation threshold.");
  const payouts = JSON.parse(readFileSync(0, "utf8"));
  const reserve = await connectTestnet(reserveAddress);
  assert.equal(reserve.address.ismine, true, "Use the Gridcoin Testnet reserve wallet RPC.");
  const { rpc } = reserve;
  const tip = await rpc("getbestblockhash");
  assert.match(tip, HASH);
  const snapshot = await solanaSnapshot(expectedMint);
  const outputs = await rpc("listunspent", 1, 9999999, [reserve.address.address]);
  const { confirmed, spendable } = reserveTotals(outputs, reserve.script, minimum);

  const scripts = new Map([[reserve.address.address, reserve.script]]);
  async function scriptFor(address) {
    if (!scripts.has(address)) scripts.set(address, (await resolveGridcoinAddress(rpc, address)).script);
    return scripts.get(address);
  }
  const accounting = await reconcileWithdrawals(snapshot, payouts, async (withdrawal, payout) => {
    const tx = await findPayout(rpc, payout.txid);
    if (!tx || !Number.isSafeInteger(tx.confirmations) || tx.confirmations < minimum) return false;
    assert.match(tx.blockhash, HASH, "Confirmed payout has no valid Gridcoin block hash.");
    if (payout.blockHash) {
      assert.equal(tx.blockhash, payout.blockHash, "Confirmed payout moved to a different Gridcoin block.");
    }
    const reserveScript = await scriptFor(payout.reserveAddress);
    const destinationScript = await scriptFor(withdrawal.gridcoinAddress);
    validateOutputs(tx, destinationScript, reserveScript, BigInt(withdrawal.amountBaseUnits));
    for (const input of tx.vin) {
      const previous = await findPayout(rpc, input.txid);
      const source = previous?.vout.find((output) => output.n === input.vout);
      assert.equal(source?.scriptPubKey.hex, reserveScript, "Could not verify a payout input belonged to its reserve.");
    }
    return true;
  });
  assert.equal(await rpc("getbestblockhash"), tip, "Gridcoin tip changed during reconciliation. Retry.");

  const difference = confirmed - accounting.required;
  const liquidityDifference = spendable - accounting.required;
  let status = "covered";
  if (accounting.issues.length) status = "review_required";
  else if (difference < 0n) status = "shortfall";
  else if (liquidityDifference < 0n) status = "liquidity_shortfall";
  console.log(JSON.stringify({
    status,
    gridcoinReserveAddress: reserve.address.address,
    gridcoinTip: tip,
    solanaFinalizedSlot: snapshot.slot,
    minimumGridcoinConfirmations: minimum,
    confirmedReserveBaseUnits: confirmed.toString(),
    spendableReserveBaseUnits: spendable.toString(),
    finalizedWgrcSupplyBaseUnits: snapshot.supply.toString(),
    pendingEscrowBaseUnits: accounting.pendingEscrow.toString(),
    confirmedPayoutsAwaitingBurnBaseUnits: accounting.confirmedPendingPayouts.toString(),
    unverifiedSettledBaseUnits: accounting.unverifiedSettled.toString(),
    legacyObligationsBaseUnits: accounting.legacyObligations.toString(),
    requiredBackingBaseUnits: accounting.required.toString(),
    backingSurplusBaseUnits: (difference > 0n ? difference : 0n).toString(),
    backingShortfallBaseUnits: (difference < 0n ? -difference : 0n).toString(),
    spendableShortfallBaseUnits: (liquidityDifference < 0n ? -liquidityDifference : 0n).toString(),
    issues: accounting.issues,
  }, null, 2));
}

module.exports = { reconcileWithdrawals, reserveTotals, legacyAmount };
if (require.main === module) {
  main().catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
}
