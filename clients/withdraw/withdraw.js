import {
  DEVNET_GENESIS, PROGRAM_ID, RPC_URL, parseAmount, validateDestination,
  verifyWithdrawal, withdrawalAddress, withdrawalInstruction,
} from "./protocol.mjs";

const byId = (id) => document.getElementById(id);
const storageKey = `wgrc:devnet:${PROGRAM_ID}:withdrawal`;
const form = byId("withdraw-form");
const controls = Object.fromEntries(
  ["connect", "submit", "check", "retry", "new-request"].map((id) => [id, byId(id)]),
);
const explorer = "https://explorer.solana.com";
let web3;
let connection;
let wallet;
let request;
let finalized = false;
let busy = false;

function message(text, error = false) {
  const status = byId("status");
  status.textContent = text;
  status.dataset.error = String(error);
}

function showLink(element, label, path) {
  element.textContent = label;
  if (path) {
    const link = document.createElement("a");
    link.href = `${explorer}/${path}/${encodeURIComponent(label)}?cluster=devnet`;
    link.textContent = label;
    element.replaceChildren(link);
  }
}

function render() {
  const owner = wallet?.publicKey?.toBase58();
  byId("wallet-label").textContent = owner ? `${owner.slice(0, 6)}…${owner.slice(-5)}` : "Disconnected";
  controls.connect.hidden = Boolean(owner);
  controls.connect.disabled = busy || !connection;
  form.hidden = Boolean(request);
  byId("saved-request").hidden = !request;
  controls.submit.disabled = !owner || busy || !connection;
  controls.check.disabled = busy || !connection;
  controls.retry.disabled = busy || !connection || !request || owner !== request.owner;
  controls.retry.hidden = finalized;
  controls["new-request"].hidden = !finalized;
  controls["new-request"].disabled = busy;
  if (request) {
    showLink(byId("request-address"), request.address, "address");
    byId("request-destination").textContent = request.destination;
    showLink(byId("request-signature"), request.signature || "Waiting for submission",
      request.signature ? "tx" : null);
  }
}

function saveRequest(updated) {
  localStorage.setItem(storageKey, JSON.stringify(updated));
  request = updated;
}

function readRequest() {
  const saved = JSON.parse(localStorage.getItem(storageKey) ?? "null");
  if (saved && (typeof saved.owner !== "string" || typeof saved.address !== "string"
    || typeof saved.destination !== "string" || !/^\d{1,20}$/.test(saved.nonce)
    || !/^\d{1,20}$/.test(saved.amount))) {
    throw new Error("The saved withdrawal could not be read.");
  }
  return saved;
}

async function requireDevnet() {
  if (await connection.getGenesisHash() !== DEVNET_GENESIS) {
    throw new Error("The RPC endpoint is on the wrong network. Use Solana Devnet.");
  }
}

async function connect() {
  wallet = window.phantom?.solana;
  if (!wallet?.isPhantom) throw new Error("Open this page in a browser with Phantom installed.");
  await wallet.connect();
  wallet.on("accountChanged", render);
  wallet.on("disconnect", render);
  message(request ? "Check the saved withdrawal or retry it with its original wallet." : "Phantom connected.");
}

async function checkStatus() {
  await requireDevnet();
  const owner = new web3.PublicKey(request.owner);
  const address = withdrawalAddress(web3, owner, request.nonce);
  if (address.toBase58() !== request.address) throw new Error("Saved withdrawal address does not match.");
  const account = await connection.getAccountInfo(address, "finalized");
  if (!account) {
    message("The saved withdrawal is awaiting finalization or submission. You can retry with the same withdrawal account.");
    return false;
  }
  const status = await verifyWithdrawal(web3, account, request);
  finalized = true;
  message({
    pending: "Escrow finalized. The bridge will process the Gridcoin payout.",
    settled: "Withdrawal settled. The bridge confirmed the Gridcoin payout.",
    cancelled: "Withdrawal cancelled. The escrowed wGRC was returned.",
  }[status]);
  return true;
}

async function send(saved, fresh) {
  const owner = new web3.PublicKey(saved.owner);
  if (!wallet?.publicKey?.equals(owner)) throw new Error("Connect the Phantom wallet that owns this request.");
  await validateDestination(saved.destination);
  if (await checkStatus()) return;
  const existing = await connection.getAccountInfo(new web3.PublicKey(saved.address), "confirmed");
  if (existing) {
    await verifyWithdrawal(web3, existing, saved);
    message("Withdrawal confirmed on Devnet. Check status again after finalization.");
    return;
  }
  const instruction = await withdrawalInstruction(web3, saved);
  const bridge = await connection.getAccountInfo(instruction.keys[1].pubkey, "finalized");
  if (bridge?.owner.toBase58() !== PROGRAM_ID) throw new Error("The Devnet bridge account could not be verified.");
  const block = await connection.getLatestBlockhash("confirmed");
  const transaction = new web3.Transaction({
    feePayer: owner,
    blockhash: block.blockhash,
    lastValidBlockHeight: block.lastValidBlockHeight,
  }).add(instruction);
  if (!wallet.publicKey?.equals(owner)) throw new Error("The active Phantom account changed. Reconnect the original wallet.");
  message("Review the transaction in Phantom.");
  let result;
  try {
    result = await wallet.signAndSendTransaction(transaction);
  } catch (error) {
    if (error.code !== 4001) throw error;
    if (fresh) {
      localStorage.removeItem(storageKey);
      request = null;
    }
    message("You declined the Phantom approval.");
    return;
  }
  saveRequest({ ...saved, signature: result.signature });
  render();
  message("Submitted to Solana Devnet. Waiting for finalization.");
  const confirmation = await connection.confirmTransaction({ ...block, signature: result.signature }, "finalized");
  if (confirmation.value.err) throw new Error("Solana rejected the transaction.");
  await checkStatus();
}

async function start(event) {
  event.preventDefault();
  if (request || !wallet?.publicKey) return;
  const amount = parseAmount(byId("amount").value.trim()).toString();
  const destination = byId("destination").value.trim();
  await validateDestination(destination);
  const owner = wallet.publicKey;
  const nonce = crypto.getRandomValues(new BigUint64Array(1))[0].toString();
  const saved = { owner: owner.toBase58(), destination, amount, nonce,
    address: withdrawalAddress(web3, owner, nonce).toBase58() };
  if (readRequest()) throw new Error("A withdrawal is already saved. Reload the page to recover it.");
  saveRequest(saved);
  render();
  await send(saved, true);
}

function action(callback) {
  return async (event) => {
    event.preventDefault();
    if (busy) return;
    busy = true;
    render();
    try {
      await callback(event);
    } catch (error) {
      message(`${error.message || "The request could not be completed."}${request && !finalized ? " The withdrawal is saved. Check its status or retry the same request." : ""}`, true);
    } finally {
      busy = false;
      render();
    }
  };
}

function init() {
  web3 = window.solanaWeb3;
  try {
    request = readRequest();
    if (!web3) throw new Error("The Solana library is missing. Serve the built withdrawal page.");
    connection = new web3.Connection(RPC_URL, "confirmed");
    if (request) message("A saved withdrawal is available. Check its status or connect Phantom to retry.");
  } catch (error) {
    message(error.message, true);
  }
  controls.connect.addEventListener("click", action(connect));
  form.addEventListener("submit", action(start));
  controls.check.addEventListener("click", action(checkStatus));
  controls.retry.addEventListener("click", action(() => send(request, false)));
  controls["new-request"].addEventListener("click", action(() => {
    localStorage.removeItem(storageKey);
    request = null;
    finalized = false;
    form.reset();
    message("");
  }));
  render();
}

if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", init, { once: true });
} else {
  init();
}
