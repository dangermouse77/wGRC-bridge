const assert = require("node:assert/strict");
const { baseUnits, connectTestnet, resolveGridcoinAddress } = require("../scripts/gridcoin-deposit.cjs");

const HASH = /^[a-f0-9]{64}$/;
const DEVNET_URL = "https://api.devnet.solana.com";
const PROGRAM_ID = "AvqkRykFXfx31fDYnJq7kPkNpgiMA6LbknavHMvjz3Zy";

function grc(units) {
  const digits = units.toString().padStart(9, "0");
  return `${digits.slice(0, -8)}.${digits.slice(-8)}`;
}

function validateOutputs(tx, destinationScript, reserveScript, amount) {
  assert.match(tx.txid, HASH);
  assert.ok(tx.vin?.length, "Gridcoin payout has no inputs.");
  assert.ok(tx.vout.length === 1 || tx.vout.length === 2, "Unexpected Gridcoin payout outputs.");
  const payments = tx.vout.filter((out) => out.scriptPubKey.hex === destinationScript);
  assert.equal(payments.length, 1, "Expected one payment to the withdrawal destination.");
  assert.equal(baseUnits(payments[0].value), amount, "Gridcoin payout amount does not match the withdrawal.");
  for (const out of tx.vout) {
    if (out !== payments[0]) {
      assert.equal(out.scriptPubKey.hex, reserveScript, "Payout change must return to the reserve address.");
      assert.ok(baseUnits(out.value) > 0n, "Payout change must be positive.");
    }
  }
}

async function preparePayout(rpc, reserve, destination, minimum, amount, fee) {
  const coins = await rpc("listunspent", minimum, 9999999, [reserve.address.address]);
  assert.ok(Array.isArray(coins), "Expected the reserve wallet's unspent outputs.");
  const inputs = [];
  const selected = new Set();
  let total = 0n;
  for (const coin of coins) {
    if (total >= amount + fee) break;
    if (coin.spendable === false || coin.scriptPubKey !== reserve.script) continue;
    assert.match(coin.txid, HASH);
    assert.ok(Number.isInteger(coin.vout) && coin.vout >= 0 && coin.vout <= 0xffffffff);
    const outpoint = `${coin.txid}:${coin.vout}`;
    assert.ok(!selected.has(outpoint), "Duplicate reserve output returned by Gridcoin.");
    selected.add(outpoint);
    inputs.push({ txid: coin.txid, vout: coin.vout });
    total += baseUnits(coin.amount);
  }
  assert.ok(total >= amount + fee, "Reserve has insufficient confirmed spendable GRC for the payout and fee.");
  const change = total - amount - fee;
  const outputs = { [destination.address.address]: grc(amount) };
  if (change > 0n) outputs[reserve.address.address] = grc(change);
  const raw = await rpc("createrawtransaction", inputs, outputs);
  const signed = await rpc("signrawtransaction", raw);
  assert.equal(signed.complete, true, "Reserve wallet could not fully sign the payout.");
  assert.match(signed.hex, /^(?:[a-f0-9]{2})+$/);
  const tx = await rpc("decoderawtransaction", signed.hex);
  validateOutputs(tx, destination.script, reserve.script, amount);
  assert.deepEqual(tx.vin.map(({ txid, vout }) => ({ txid, vout })), inputs);
  const paid = tx.vout.reduce((sum, out) => sum + baseUnits(out.value), 0n);
  assert.equal(total - paid, fee, "Signed payout fee differs from the configured fee.");
  return { txid: tx.txid, signedHex: signed.hex };
}

async function findPayout(rpc, txid) {
  try {
    const tx = await rpc("getrawtransaction", txid, true);
    assert.equal(tx.txid, txid, "Gridcoin returned a different payout transaction.");
    return tx;
  } catch (error) {
    if (error.rpcCode === -5) return null;
    throw error;
  }
}

async function advancePayout(rpc, payout, minimum, verifyPending, settle, previousBlockHash) {
  const current = await verifyPending();
  if (previousBlockHash) {
    assert.equal(current, "settled", "Saved settlement is missing from Solana. Reconcile before proceeding.");
  }
  let tx = await findPayout(rpc, payout.txid);
  if (!tx && current === "pending") {
    await verifyPending("pending");
    const acknowledged = await rpc("sendrawtransaction", payout.signedHex);
    assert.equal(acknowledged, payout.txid, "Gridcoin acknowledged a different payout transaction.");
    tx = await findPayout(rpc, payout.txid);
  }
  const confirmations = tx?.confirmations ?? 0;
  assert.ok(Number.isSafeInteger(confirmations) && confirmations >= 0, "Unexpected payout confirmation count.");
  if (confirmations < minimum || !HASH.test(tx?.blockhash ?? "")) {
    assert.equal(current, "pending", "Previously settled Gridcoin payout needs reconciliation.");
    return { txid: payout.txid, confirmations, blockHash: null, signature: null };
  }
  if (previousBlockHash) {
    assert.equal(tx.blockhash, previousBlockHash, "Previously settled payout changed Gridcoin blocks.");
  }
  const signature = current === "pending" ? await settle() : null;
  return { txid: payout.txid, confirmations, blockHash: tx.blockhash, signature };
}

async function main() {
  const [mode, reserveAddress, minimumArg, input] = process.argv.slice(2);
  assert.ok(mode === "prepare" || mode === "advance", "Expected prepare or advance mode.");
  const minimum = Number(minimumArg);
  assert.ok(/^\d+$/.test(minimumArg) && Number.isSafeInteger(minimum) && minimum > 0);
  const request = JSON.parse(input);
  const amount = BigInt(request.amountBaseUnits);
  const { AnchorProvider, Program } = require("@anchor-lang/core");
  const { Connection, PublicKey } = require("@solana/web3.js");
  const { getAccount, TOKEN_PROGRAM_ID } = require("@solana/spl-token");
  const idl = require("../target/idl/wgrc_bridge.json");
  assert.equal(process.env.ANCHOR_PROVIDER_URL, DEVNET_URL, "Redemption requires the public Solana Devnet RPC.");
  const environment = AnchorProvider.env();
  const connection = new Connection(DEVNET_URL, {
    commitment: "finalized",
    fetch: (input, init) => fetch(input, { ...init, signal: AbortSignal.timeout(30_000) }),
  });
  const provider = new AnchorProvider(connection, environment.wallet, {
    commitment: "finalized",
    preflightCommitment: "confirmed",
  });
  const program = new Program(idl, provider);
  assert.equal(program.programId.toBase58(), PROGRAM_ID, "Unexpected Devnet bridge program.");
  const pda = (seed, ...parts) =>
    PublicKey.findProgramAddressSync([Buffer.from(seed), ...parts], program.programId)[0];
  const bridge = pda("bridge");
  const mint = pda("mint");
  assert.equal(mint.toBase58(), request.mint, "Configured wGRC mint differs from the Devnet bridge mint.");
  const withdrawal = new PublicKey(request.address);
  const vault = pda("vault", withdrawal.toBuffer());
  const mintOperator = provider.wallet.publicKey;
  const settings = await program.account.bridge.fetch(bridge, "finalized");
  assert.ok(settings.mintOperator.equals(mintOperator), "Use the configured Devnet mint operator wallet.");

  async function verifyWithdrawal(requiredStatus) {
    const state = await program.account.escrowWithdrawal.fetch(withdrawal, "finalized");
    const [status] = Object.keys(state.status);
    assert.equal(state.owner.toBase58(), request.owner);
    assert.equal(state.nonce.toString(), request.nonce);
    assert.equal(state.amount.toString(), request.amountBaseUnits);
    assert.equal(state.gridcoinAddress, request.gridcoinAddress);
    assert.ok(pda("withdrawal", state.owner.toBuffer(), state.nonce.toArrayLike(Buffer, "le", 8))
      .equals(withdrawal), "Withdrawal PDA does not match its owner and nonce.");
    if (requiredStatus) assert.equal(status, requiredStatus, "Withdrawal status changed.");
    if (status === "settled") {
      assert.ok(request.payout, "Withdrawal was settled outside the relayer.");
      assert.equal(Buffer.from(state.status.settled.gridcoinTxid).toString("hex"), request.payout.txid,
        "Withdrawal was settled with a different Gridcoin payout.");
    } else {
      assert.equal(status, "pending", "Withdrawal is no longer pending.");
      const escrow = await getAccount(provider.connection, vault, "finalized");
      assert.ok(escrow.owner.equals(withdrawal) && escrow.mint.equals(mint)
        && escrow.amount >= amount && !escrow.isFrozen, "Withdrawal escrow cannot fund settlement.");
    }
    return status;
  }

  const reserve = await connectTestnet(reserveAddress);
  assert.equal(reserve.address.ismine, true, "Use the dedicated Gridcoin Testnet reserve wallet RPC.");
  const { rpc } = reserve;
  const destination = await resolveGridcoinAddress(rpc, request.gridcoinAddress);
  assert.notEqual(destination.script, reserve.script, "Cannot redeem to the reserve itself.");
  if (mode === "prepare") {
    await verifyWithdrawal("pending");
    const fee = BigInt(request.feeBaseUnits);
    assert.ok(fee > 0n, "Payout fee must be positive.");
    console.log(JSON.stringify(await preparePayout(rpc, reserve, destination, minimum, amount, fee)));
    return;
  }
  const payout = request.payout;
  const tx = await rpc("decoderawtransaction", payout.signedHex);
  validateOutputs(tx, destination.script, reserve.script, amount);
  assert.equal(tx.txid, payout.txid, "Stored payout bytes no longer match the transaction ID.");
  const result = await advancePayout(rpc, payout, minimum, verifyWithdrawal, async () => {
    const signature = await program.methods.settleWithdrawal([...Buffer.from(payout.txid, "hex")])
      .accountsStrict({ bridge, mint, withdrawal, vault, mintOperator, tokenProgram: TOKEN_PROGRAM_ID })
      .rpc();
    await verifyWithdrawal("settled");
    return signature;
  }, request.payoutBlockHash);
  console.log(JSON.stringify(result));
}

module.exports = { preparePayout, advancePayout };
if (require.main === module) {
  main().catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
}
