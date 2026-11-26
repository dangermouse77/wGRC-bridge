export const RPC_URL = "https://api.devnet.solana.com";
export const DEVNET_GENESIS = "EtWTRABZaYq6iMfeYKouRu166VU2xqa1";
export const PROGRAM_ID = "AvqkRykFXfx31fDYnJq7kPkNpgiMA6LbknavHMvjz3Zy";
const MINT = "4cwiLPuXXsYqsWJCWi31HYSJVWpGMj7YySxAj3HTgF8S";
const RESERVE = "mxaRNFnUR9FwxS1Zp2EeWjwpAJ95g1wdgz";
const TOKEN_PROGRAM = "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA";
const ASSOCIATED_TOKEN_PROGRAM = "ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL";
const BASE58 = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
const encoder = new TextEncoder();
const decoder = new TextDecoder("utf-8", { fatal: true });
const u64Max = (1n << 64n) - 1n;

function equalBytes(first, second) {
  return first.length === second.length && first.every((byte, index) => byte === second[index]);
}

async function sha256(bytes) {
  return new Uint8Array(await crypto.subtle.digest("SHA-256", bytes));
}

async function discriminator(name) {
  return (await sha256(encoder.encode(name))).subarray(0, 8);
}

export function parseAmount(value) {
  if (value.length > 21 || !/^\d+(?:\.\d{1,8})?$/.test(value)) {
    throw new Error("Enter a wGRC amount with up to eight decimal places.");
  }
  const [whole, fraction = ""] = value.split(".");
  const units = BigInt(whole) * 100_000_000n + BigInt(fraction.padEnd(8, "0"));
  if (units < 1n || units > u64Max) throw new Error("Enter a positive amount within the wGRC limit.");
  return units;
}

export async function validateDestination(address) {
  const invalid = new Error("Enter a valid Gridcoin Testnet address.");
  if (address.length < 26 || address.length > 35) throw invalid;
  let value = 0n;
  for (const character of address) {
    const digit = BASE58.indexOf(character);
    if (digit < 0) throw invalid;
    value = value * 58n + BigInt(digit);
  }
  const bytes = new Uint8Array(25);
  for (let index = bytes.length - 1; index >= 0; index--) {
    bytes[index] = Number(value & 255n);
    value >>= 8n;
  }
  if (value !== 0n || address.startsWith("1") || ![111, 196].includes(bytes[0])) throw invalid;
  const checksum = await sha256(await sha256(bytes.subarray(0, 21)));
  if (!equalBytes(checksum.subarray(0, 4), bytes.subarray(21))) throw invalid;
  if (address === RESERVE) throw new Error("Use a destination outside the bridge reserve.");
}

function u64(value) {
  const bytes = new Uint8Array(8);
  new DataView(bytes.buffer).setBigUint64(0, BigInt(value), true);
  return bytes;
}

export function withdrawalAddress(web3, owner, nonce) {
  return web3.PublicKey.findProgramAddressSync(
    [encoder.encode("withdrawal"), owner.toBytes(), u64(nonce)],
    new web3.PublicKey(PROGRAM_ID),
  )[0];
}

export async function withdrawalInstruction(web3, request) {
  const { PublicKey, TransactionInstruction, SystemProgram } = web3;
  const programId = new PublicKey(PROGRAM_ID);
  const owner = new PublicKey(request.owner);
  const tokenProgram = new PublicKey(TOKEN_PROGRAM);
  const derive = (label, ...seeds) =>
    PublicKey.findProgramAddressSync([encoder.encode(label), ...seeds], programId)[0];
  const mint = derive("mint");
  if (mint.toBase58() !== MINT) throw new Error("Unexpected Devnet bridge mint.");
  const withdrawal = withdrawalAddress(web3, owner, request.nonce);
  if (withdrawal.toBase58() !== request.address) throw new Error("Saved withdrawal address does not match.");
  const [ownerTokens] = PublicKey.findProgramAddressSync(
    [owner.toBytes(), tokenProgram.toBytes(), mint.toBytes()], new PublicKey(ASSOCIATED_TOKEN_PROGRAM),
  );
  const destination = encoder.encode(request.destination);
  const data = new Uint8Array(28 + destination.length);
  data.set(await discriminator("global:request_withdrawal"));
  data.set(u64(request.nonce), 8);
  data.set(u64(request.amount), 16);
  new DataView(data.buffer).setUint32(24, destination.length, true);
  data.set(destination, 28);
  const keys = [
    { pubkey: owner, isSigner: true, isWritable: true },
    { pubkey: derive("bridge"), isSigner: false, isWritable: false },
    { pubkey: mint, isSigner: false, isWritable: false },
    { pubkey: ownerTokens, isSigner: false, isWritable: true },
    { pubkey: withdrawal, isSigner: false, isWritable: true },
    { pubkey: derive("vault", withdrawal.toBytes()), isSigner: false, isWritable: true },
    { pubkey: tokenProgram, isSigner: false, isWritable: false },
    { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
  ];
  return new TransactionInstruction({ programId, keys, data });
}

export async function verifyWithdrawal(web3, account, request) {
  const data = account.data;
  const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
  if (data.length < 61 || account.owner.toBase58() !== PROGRAM_ID
    || !equalBytes(data.subarray(0, 8), await discriminator("account:EscrowWithdrawal"))
    || new web3.PublicKey(data.subarray(8, 40)).toBase58() !== request.owner
    || view.getBigUint64(40, true) !== BigInt(request.nonce)
    || view.getBigUint64(48, true) !== BigInt(request.amount)) {
    throw new Error("On-chain withdrawal does not match the saved request.");
  }
  const length = view.getUint32(56, true);
  const statusOffset = 60 + length;
  if (length > 35 || statusOffset >= data.length
    || decoder.decode(data.subarray(60, statusOffset)) !== request.destination) {
    throw new Error("On-chain destination does not match the saved request.");
  }
  const status = ["pending", "settled", "cancelled"][data[statusOffset]];
  if (!status) throw new Error("Unknown on-chain withdrawal status.");
  return status;
}
