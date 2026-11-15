const { createHash } = require("node:crypto");
const { readFileSync } = require("node:fs");
const { PublicKey } = require("@solana/web3.js");

const TESTNET_GENESIS = "00006e037d7b84104208ecf2a8638d23149d712ea810da604ee2f2cb39bae713";
const MAX_AMOUNT = (1n << 64n) - 1n;

function baseUnits(value) {
  const match = /^(\d+)(?:\.(\d{1,8}))?$/.exec(value);
  if (!match) throw new Error("Expected a GRC amount with up to eight decimal places.");
  const amount = BigInt(match[1]) * 100_000_000n + BigInt((match[2] ?? "").padEnd(8, "0"));
  if (amount > MAX_AMOUNT) throw new Error("Amount exceeds the wGRC u64 range.");
  return amount;
}

function deposit(tx, reserveScript, genesis = TESTNET_GENESIS) {
  if (!/^[a-f0-9]{64}$/.test(tx.txid) || !tx.vin?.length || !Array.isArray(tx.vout)
      || tx.vin.some((input) => Object.hasOwn(input, "coinbase"))
      || tx.vout[0]?.scriptPubKey?.hex === "") {
    throw new Error("Expected an ordinary Gridcoin transaction.");
  }
  const payments = tx.vout.filter((out) => out.scriptPubKey.hex === reserveScript);
  const carriers = tx.vout.filter((out) => out.scriptPubKey.hex.startsWith("6a"));
  if (payments.length !== 1 || carriers.length !== 1) {
    throw new Error("Expected exactly one reserve payment and one OP_RETURN output.");
  }
  const [payment] = payments;
  const [carrier] = carriers;
  const amount = baseUnits(payment.value);
  const payload = /^6a255747524301([a-f0-9]{64})$/.exec(carrier.scriptPubKey.hex);
  if (!payload || baseUnits(carrier.value) !== 0n || amount === 0n
      || !Number.isInteger(payment.n) || payment.n < 0 || payment.n > 0xffffffff) {
    throw new Error("Invalid v1 deposit payload or reserve payment.");
  }
  const index = Buffer.alloc(4);
  index.writeUInt32LE(payment.n);
  const depositId = createHash("sha256").update("WGRC-DEPOSIT-V1\0")
    .update(Buffer.from(genesis, "hex")).update(Buffer.from(tx.txid, "hex")).update(index).digest("hex");
  return {
    txid: tx.txid,
    vout: payment.n,
    depositId,
    recipient: new PublicKey(Buffer.from(payload[1], "hex")).toBase58(),
    amountBaseUnits: amount.toString(),
  };
}

function confirmedDeposit(tx, reserveScript, minimum) {
  const result = deposit(tx, reserveScript);
  if (!/^[a-f0-9]{64}$/.test(tx.blockhash ?? "") || !Number.isSafeInteger(tx.confirmations)
      || tx.confirmations < minimum) {
    throw new Error(`Deposit requires ${minimum} active-chain confirmations.`);
  }
  return { ...result, blockhash: tx.blockhash, confirmations: tx.confirmations };
}

async function main() {
  const [command, reserveAddress, value, extra, ...rest] = process.argv.slice(2);
  const broadcast = command === "broadcast";
  if (!reserveAddress || !value || (broadcast ? extra !== undefined : !extra) || rest.length
      || !["create", "send", "broadcast", "check"].includes(command)) {
    throw new Error("Usage: gridcoin-deposit.cjs create|send RESERVE GRC SOLANA_RECIPIENT\n"
      + "       gridcoin-deposit.cjs broadcast RESERVE DEPOSIT_JSON_FILE\n"
      + "       gridcoin-deposit.cjs check RESERVE TXID MIN_CONFIRMATIONS");
  }
  const prepared = broadcast ? JSON.parse(readFileSync(value, "utf8")) : null;
  if (broadcast && (typeof prepared?.signedHex !== "string"
      || !/^(?:[0-9a-fA-F]{2})+$/.test(prepared.signedHex))) {
    throw new Error("Expected a deposit JSON file containing signedHex from create.");
  }
  const { GRC_RPC_USER, GRC_RPC_PASSWORD, GRC_RPC_URL = "http://127.0.0.1:25715" } = process.env;
  if (!GRC_RPC_USER || !GRC_RPC_PASSWORD) throw new Error("Set GRC_RPC_USER and GRC_RPC_PASSWORD.");
  const endpoint = new URL(GRC_RPC_URL);
  if (!["http:", "https:"].includes(endpoint.protocol) || endpoint.username || endpoint.password) {
    throw new Error("Set GRC_RPC_URL to an HTTP(S) endpoint and supply credentials separately.");
  }
  async function rpc(method, ...params) {
    const response = await fetch(endpoint, {
      method: "POST",
      redirect: "error",
      headers: {
        Authorization: `Basic ${Buffer.from(`${GRC_RPC_USER}:${GRC_RPC_PASSWORD}`).toString("base64")}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ jsonrpc: "1.0", id: "wgrc", method, params }),
      signal: AbortSignal.timeout(30_000),
    }).catch((error) => {
      const reason = error.cause?.code ?? error.name;
      throw new Error(`${method}: cannot reach Gridcoin RPC at ${endpoint.origin} (${reason})`);
    });
    const body = await response.text();
    let reply;
    try {
      reply = JSON.parse(body, (key, entry, context) =>
        key === "value" && typeof entry === "number" ? context.source : entry);
    } catch (error) {
      if (!(error instanceof SyntaxError)) throw error;
      throw new Error(`${method}: Gridcoin RPC at ${endpoint.origin} returned HTTP ${response.status} without a JSON response.`);
    }
    if (!response.ok || reply.error) {
      throw new Error(`${method}: ${reply.error?.message ?? `HTTP ${response.status}`}`);
    }
    return reply.result;
  }

  if (await rpc("getblockhash", 0) !== TESTNET_GENESIS) throw new Error("Gridcoin Testnet required.");
  const address = await rpc("validateaddress", reserveAddress);
  if (!address.isvalid || !address.address) {
    throw new Error("Expected a valid Testnet P2PKH or P2SH reserve address.");
  }
  // Gridcoin validateaddress does not expose scriptPubKey. Ask Core to encode
  // the destination in an unsigned, unfunded template and decode that output.
  const template = await rpc("createrawtransaction", [], { [address.address]: "1" });
  const script = (await rpc("decoderawtransaction", template)).vout[0]?.scriptPubKey?.hex;
  if (!/^(76a914[a-f0-9]{40}88ac|a914[a-f0-9]{40}87)$/.test(script ?? "")) {
    throw new Error("Expected a Testnet P2PKH or P2SH reserve script.");
  }

  async function broadcastDeposit(record, signedHex) {
    console.error(`Broadcasting Gridcoin Testnet transaction ${record.txid}`);
    const acknowledgedTxid = await rpc("sendrawtransaction", signedHex);
    if (acknowledgedTxid !== record.txid) {
      throw new Error(`Unexpected RPC result after broadcast. Look up ${record.txid} before retrying.`);
    }
  }

  if (broadcast) {
    const record = deposit(await rpc("decoderawtransaction", prepared.signedHex), script);
    if (Object.entries(record).some(([field, actual]) => prepared[field] !== actual)) {
      throw new Error("The signed transaction does not match the deposit JSON.");
    }
    await broadcastDeposit(record, prepared.signedHex);
    console.log(JSON.stringify(record, null, 2));
    return;
  }

  if (command === "check") {
    const minimum = Number(extra);
    if (!/^[a-fA-F0-9]{64}$/.test(value) || !/^\d+$/.test(extra)
        || !Number.isSafeInteger(minimum) || minimum < 1) {
      throw new Error("Provide a transaction ID and a positive confirmation threshold.");
    }
    const tx = await rpc("getrawtransaction", value, true);
    if (tx.txid !== value.toLowerCase()) throw new Error("Gridcoin RPC returned a different transaction.");
    console.log(JSON.stringify(confirmedDeposit(tx, script, minimum), null, 2));
    return;
  }

  const amount = baseUnits(value);
  if (amount === 0n) throw new Error("The deposit amount must be positive.");
  const recipient = new PublicKey(extra);
  const payload = "5747524301" + recipient.toBuffer().toString("hex");
  const raw = await rpc("createrawtransaction", [], { [address.address]: value, data: payload });
  const { hex } = await rpc("fundrawtransaction", raw);
  const { hex: signedHex, complete } = await rpc("signrawtransaction", hex);
  if (!complete) throw new Error("Gridcoin wallet could not fully sign the transaction.");
  const record = deposit(await rpc("decoderawtransaction", signedHex), script);
  if (record.amountBaseUnits !== amount.toString() || record.recipient !== recipient.toBase58()) {
    throw new Error("The signed transaction differs from the requested deposit.");
  }
  if (command === "send") {
    await broadcastDeposit(record, signedHex);
  }
  console.log(JSON.stringify({ ...record, signedHex }, null, 2));
}

module.exports = { baseUnits, deposit, confirmedDeposit };
if (require.main === module) {
  main().catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
}
