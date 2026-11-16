# Gridcoin deposit protocol v1

A deposit is an ordinary Gridcoin transaction with exactly one positive output
paying the configured reserve script and exactly one `OP_RETURN` output
carrying one base unit (0.00000001 GRC). Gridcoin Core 5.5.2.0's relay policy
rejects zero-value outputs. The carrier amount is unspendable and excluded
from the amount credited to the deposit. The reserve uses a P2PKH or P2SH
address. Other outputs may carry change.
Coinbase and coinstake transactions are excluded. Match the reserve's full
script bytes so the amount and output index refer to the actual payment.

The carrier script is exactly `6a25 || 5747524301 || recipient`. Here `6a` is
`OP_RETURN`, `25` is the minimal push opcode for 37 bytes, and `recipient` is
the 32-byte Solana public key. Reject extra data, nonminimal pushes, unsupported
versions, and ambiguous outputs. Amounts use eight decimal places and are
converted to integer base units without rounding.

## Deposit identifier

Compute SHA-256 over the following concatenation:

```text
ASCII("WGRC-DEPOSIT-V1") || 00 || genesis_hash || txid || vout_u32_le
```

Use the 32 bytes obtained by decoding each hash from Gridcoin RPC display hex,
in that order. Encode the reserve payment's zero-based output index as four
little-endian bytes. Pass the 32-byte digest to Solana as `deposit_id`. The
Gridcoin genesis hash separates networks. The relayer must also bind each
Gridcoin network and reserve to its configured Solana deployment.

## Confirmation and recovery

Use the active-chain confirmation count returned by Gridcoin Core. Require a
configured positive threshold and recheck the deposit immediately before
submitting a mint. Persist the deposit block hash, output index, amount,
recipient, and ID so retries reuse the same receipt PDA. If a reorganization
removes a deposit before minting, wait for it to qualify again. If it removes
a deposit after minting, flag a backing discrepancy and halt affected minting
for operator reconciliation.

## Testnet verification

Run from the repository root with Node.js 22 or newer, project npm
dependencies installed, and RPC access to a synced Gridcoin Core node.
The tool targets the Testnet genesis and defaults to RPC on localhost port
25715. Use a funded sender wallet and a distinct Testnet reserve address.

For a Gridcoin node on another VM, set `GRC_RPC_URL` to its reachable RPC
endpoint, for example `http://gridcoin-vm:25715`. Plain HTTP sends the RPC
credentials without encryption. To keep RPC bound to localhost on the
Gridcoin VM and encrypt traffic between the VMs, open an SSH tunnel:

```bash
ssh -N -L 127.0.0.1:25716:127.0.0.1:25715 user@gridcoin-vm
```

Leave that terminal open and set
`GRC_RPC_URL=http://127.0.0.1:25716` in the shell running the script.

```bash
export GRC_RPC_USER='<RPC username>'
read -rsp 'Gridcoin RPC password: ' GRC_RPC_PASSWORD
export GRC_RPC_PASSWORD
echo
reserve='<Gridcoin Testnet reserve address>'
recipient='<Solana Devnet recipient public key>'
node scripts/gridcoin-deposit.cjs create "$reserve" 1.00000000 "$recipient" > deposit.json
```

`create` signs the transaction, and the example saves its JSON output. If
you already ran `create`, save the JSON from that run to `deposit.json`.
Inspect the reserve, amount and recipient before broadcasting. The
`broadcast` command decodes the saved transaction, validates the reserve
output and payload, and checks that the decoded fields match the JSON.

```bash
node scripts/gridcoin-deposit.cjs broadcast "$reserve" deposit.json
```

If the RPC connection drops after submission, check the transaction by its
original ID before attempting another deposit. The `send` command builds a
new transaction and is intended for a new deposit.

After the transaction reaches the desired depth, inspect it using the
validator. The Testnet wrappers and relayer default to 10 confirmations.

```bash
node scripts/gridcoin-deposit.cjs check "$reserve" '<txid>' 10
```

For the Testnet setup used by the Bash wrappers, run
`bash bin/check_deposit.sh` from the repository root. It reads
`bin/deposit.json`. Set `WGRC_MIN_CONFIRMATIONS` to use a different threshold
for both the wrapper and the relayer. The wrapper also accepts a JSON file and
an explicit confirmation threshold for an individual check.

This prints the recipient, exact amount in base units, deposit ID, and active
block information. There is no Solana mint in this verification workflow.
