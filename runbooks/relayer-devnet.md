# Phase 3 deposit pilot

Run the relayer on `solchain` with Gridcoin Testnet RPC on `gridtestnet`,
PostgreSQL on `pg-bridge`, and the existing wGRC deployment on Solana Devnet.
The command processes one confirmed Gridcoin transaction by ID.

## Configure the bridge

Both databases use the same `wgrc` schema. For a fresh setup on `solchain`,
copy the development template and fill in the database credentials.

```bash
install -m 600 relayer/bridge.dev.example.json relayer/bridge.dev.json
```

For an existing setup, rename `relayer/database.dev.json` to
`relayer/bridge.dev.json` and copy the three public address fields from the
example. The relayer still accepts the old file for database credentials if
the new file is absent. An exported `DATABASE_URL` overrides the database
connection fields. The JSON `port` defaults to `5432` when omitted.
`WGRC_TESTNET_RESERVE_ADDRESS` or `GRC_RESERVE_ADDRESS`
can override the configured deposit address.

The development example includes the current Gridcoin Testnet deposit
address and Solana Devnet wGRC mint. Set `solana_program_upgrade_authority`
to the public upgrade authority reported for the deployed program:

```bash
solana --url devnet program show AvqkRykFXfx31fDYnJq7kPkNpgiMA6LbknavHMvjz3Zy
```

This field records the upgrade authority. The mint operator still signs
with the keypair specified by `ANCHOR_WALLET`. For production, use
`relayer/bridge.prod.example.json` to create `relayer/bridge.prod.json`
and fill in the deployment addresses when known. Git ignores both local files.

Apply the same SQL migration once per database, using its owner or a role that
can create the `wgrc` schema. For the pilot, run it against `d_wgrcbridge_dev`.
If you use a separate runtime role, grant it schema usage and table select,
insert, and update privileges.

```bash
psql -X -W -h pg-bridge -d d_wgrcbridge_dev -U '<migration role>' \
  -v ON_ERROR_STOP=1 -f relayer/migrations/001_testnet_deposits.sql
```

## Process the Testnet deposit

Run from the repository root on `solchain` with Rust and Cargo, Node.js 22 or
newer, the project npm dependencies, and the Anchor-generated
`target/idl/wgrc_bridge.json`. On Linux, the Rust PostgreSQL TLS connector
uses OpenSSL development headers. Generate the IDL with `anchor build` if
needed.

Use the same Gridcoin Testnet RPC credentials and network connection as in
[the deposit verification procedure](../docs/protocol.md#testnet-verification).
Use the reserve address that received the Phase 2 deposit. The Devnet wallet
must be the bridge's configured mint operator and have SOL for fees and account
creation.

```bash
export WGRC_TESTNET_RESERVE_ADDRESS='mttYZdNgbn3f5767arC4i8CCzncH29z86h'
export ANCHOR_PROVIDER_URL=https://api.devnet.solana.com
export ANCHOR_WALLET='<absolute path to the Devnet mint operator keypair>'

cargo run -p wgrc-relayer -- process-deposit \
  448bd13d7db71908372e30bb40f98134506810637339161bbbf34415499bf76e
```

The deposit check, watcher and mint all default to 10 confirmations. Set
`WGRC_MIN_CONFIRMATIONS` in the shell running them to override that default.

The command records the validated amount in base units, reserve output,
recipient, and Gridcoin block before submitting the mint. It rechecks Gridcoin
before submission and reports success after verifying the finalized Solana
deposit receipt. Compare the output deposit ID with
`fd6527a1f25e38d87e815b0ad3a71dd42f767a22fe096986fce7c36d911599c2`.

Run the same command again to exercise recovery. It should return the same
receipt, and this query should show one finalized row with
`amount_base_units = 100000000`.

```sql
SELECT deposit_id, amount_base_units, recipient, receipt_address,
       mint_signature, finalized_at
FROM wgrc.deposits
WHERE txid = '448bd13d7db71908372e30bb40f98134506810637339161bbbf34415499bf76e';
```

If the process loses the submission response, rerun the same transaction ID.
The finalized receipt can recover the database state even when the transaction
signature is unavailable. If the deposit is reported in a different Gridcoin
block, reconcile the deposit and the Solana receipt before changing its
database record.

## Process discoveries automatically

Use the watcher start height already recorded for the configured reserve.
If you have never scanned that reserve, choose a start height that covers
the deposits you intend to process. The watcher processes all unfinished
discoveries for that reserve once it catches up, including discoveries saved
by earlier runs. The existing watcher tables support this mode.

On `solchain`, point Gridcoin RPC at the dedicated Testnet reserve wallet.
Use the same Solana Devnet URL and mint operator keypair as for
`process-deposit`. For a one-shot pilot at the existing Testnet reserve:

```bash
export ANCHOR_PROVIDER_URL=https://api.devnet.solana.com
export ANCHOR_WALLET='<absolute path to the Devnet mint operator keypair>'
cargo run -p wgrc-relayer -- watch-gridcoin 3339204 --once --mint
```

Before submitting a new mint, the relayer rechecks the transaction's
active-chain confirmations and requires the reserve wallet to report the
exact deposit output as spendable and unspent. The finalized on-chain
receipt prevents duplicates and lets the relayer recover an earlier mint
whose result was interrupted before the database update. Finalized rows
are skipped on subsequent automatic passes. A failed deposit remains
eligible for retry, and the watcher continues processing other discoveries.
With `--once`, any failed deposits are reported through a nonzero exit.
Omit `--once` to keep scanning and retrying on subsequent polls.
Without `--mint`, the watcher records discoveries as before.

For live verification, use a confirmed and unspent deposit with no prior
mint. After the first run, confirm that the discovery has one finalized
mint row with the expected amount and recipient:

```sql
SELECT d.txid, d.deposit_id, m.amount_base_units, m.recipient,
       m.receipt_address, m.mint_signature, m.finalized_at
FROM wgrc.gridcoin_deposit_discoveries AS d
LEFT JOIN wgrc.deposits AS m USING (deposit_id)
WHERE d.txid = '<test deposit txid>';
```

Rerun with the same arguments and verify that the receipt, signature,
and finalized timestamp are unchanged.

## Watch Solana Devnet for withdrawals

Apply migration `003` once to the development database from the repository
root on `solchain`. If you use a separate relayer role, grant it `SELECT`,
`INSERT`, and `UPDATE` on both tables created by the migration.

```bash
psql -X -W -h pg-bridge -p 5432 -d d_wgrcbridge_dev -U '<migration role>' \
  -v ON_ERROR_STOP=1 -f relayer/migrations/003_solana_watcher.sql
```

Use the development bridge config and the same Node dependencies and
generated Anchor IDL as the deposit pilot. The watcher needs Devnet RPC
access. It can run with no signing wallet or Gridcoin RPC credentials.

```bash
export ANCHOR_PROVIDER_URL=https://api.devnet.solana.com
cargo run -p wgrc-relayer -- watch-solana --once
```

The watcher reads the current finalized set of escrow withdrawal accounts.
It records each withdrawal by its Solana account address with the owner,
nonce, exact amount, Gridcoin destination, and on-chain status. The recorded
slot is when the watcher observed the state. Pending requests and requests
that already reached settlement or cancellation can all be discovered
after a restart. Older burn-first accounts require separate reconciliation.
For settled accounts, the Gridcoin transaction ID is the operator's on-chain
attestation. Verifying that payout on Gridcoin is part of redemption processing.

```sql
SELECT withdrawal_address, owner_address, nonce, amount_base_units, gridcoin_address,
       status, gridcoin_payout_txid, first_observed_slot, last_changed_slot
FROM wgrc.solana_withdrawals
ORDER BY first_observed_slot, withdrawal_address;

SELECT finalized_slot FROM wgrc.solana_withdrawal_checkpoint;
```

Compare a known finalized Devnet withdrawal with its PostgreSQL row. The
existing Devnet smoke test's escrow withdrawal can serve as a terminal-state
fixture. Use a finalized escrow request left pending to verify discovery
before settlement. Rerun the same command and expect zero new or changed
requests if no accounts changed. The row's observation slots should remain
the same. Omit `--once` to scan every 15 seconds. The watcher records
withdrawals. Gridcoin payouts and Solana settlement are separate operations.

## Process a Devnet redemption

Apply migration `004` once after the Solana watcher migration:

```bash
psql -X -W -h pg-bridge -p 5432 -d d_wgrcbridge_dev -U '<migration role>' \
  -v ON_ERROR_STOP=1 -f relayer/migrations/004_redemption_payouts.sql
```

If the relayer has a separate database role, grant it `SELECT`, `INSERT`, and
`UPDATE` on `wgrc.redemption_payouts`. Configure Gridcoin RPC for the
dedicated Testnet reserve wallet, with staking disabled. The wallet must be
able to sign the first time the payout is prepared. Use only the configured
reserve address for inputs and change. The payout fee defaults to 0.001 GRC
and can be set before preparation with `WGRC_PAYOUT_FEE_BASE_UNITS`. Fund
fees separately with a plain Gridcoin transfer to the reserve.

Create a small escrow withdrawal from the repository root using the holder's
Devnet keypair and a Gridcoin Testnet receiving address that you control.
Use an address other than the reserve and keep enough Devnet SOL to create
the escrow accounts.

```bash
export ANCHOR_PROVIDER_URL=https://api.devnet.solana.com
export ANCHOR_WALLET='<absolute path to the Devnet holder keypair>'
./bin/request_devnet_withdrawal.sh '<Testnet payout address>' 1
./bin/verify_solana_watcher.sh
```

Save the returned withdrawal address. If the request submission times out,
look up the printed address on Devnet before creating another request.
Switch `ANCHOR_WALLET` to the configured Devnet mint operator keypair
before processing the payout.

```bash
export ANCHOR_WALLET='<absolute path to the Devnet mint operator keypair>'
bash bin/process_redemption.sh '<withdrawal address>'
```

The first run saves the signed payout before broadcasting. It reports
`awaiting_confirmations` until the exact payout reaches the shared Gridcoin
threshold. Rerun the same command with the same withdrawal address to
advance it. It reuses the saved transaction across restarts and performs
the escrow burn after the Gridcoin payout confirms.

Keep one unfinished payout per reserve. Coordinate any settlement or
cancellation through the operator managing this payout. If the signed
transaction cannot confirm, keep its database record and reconcile it
before considering a replacement or refund. A broadcast timeout, RPC
error, or temporarily missing transaction cannot justify a refund.

On `settled`, check that the Gridcoin recipient received the requested
amount, then refresh the Solana watcher and verify both records:

```sql
SELECT w.withdrawal_address, w.amount_base_units, w.status,
       w.gridcoin_payout_txid, p.txid, p.payout_block_hash,
       p.settlement_signature, p.settled_at
FROM wgrc.solana_withdrawals AS w
JOIN wgrc.redemption_payouts AS p USING (withdrawal_address)
WHERE w.withdrawal_address = '<withdrawal address>';
```

Expect `status = 'settled'`, matching Gridcoin transaction IDs, and a
settlement timestamp. A rerun should retain those same IDs and timestamp.
If a settlement response was lost, the on-chain escrow status can recover
the database record even when its Solana signature is unavailable.

## Recover unfinished redemptions automatically

After preparing a payout with `process-redemption`, start the recovery worker
on `solchain` from the repository root. Export the same Gridcoin reserve RPC
credentials, Devnet URL, and mint operator wallet used for the payout.

```bash
cargo run -p wgrc-relayer -- recover-redemptions
```

The worker looks for the configured reserve's unfinished payout in PostgreSQL
every 15 seconds. It uses the saved signed transaction and settles the same
escrow when Gridcoin reaches the required confirmation depth. On errors it
reconnects and retries with delays of 15, 30, 60, and at most 120 seconds.
If the worker stops, restart it with the same config and database. It
resumes from the saved payout. Use `--once` for a single recovery pass.

Start each new payout with `process-redemption` and its explicit withdrawal
address. The worker processes existing payout records only. Repeated
conflicts with the saved payout or on-chain withdrawal require reconciliation.

For the live recovery check, start a fresh test redemption and record the
Gridcoin transaction ID once the processor reports `awaiting_confirmations`.
Start the recovery worker, stop it with Ctrl+C while the payout is still
confirming, then restart it. After the payout confirms, verify that the
worker reports `settled` with the same transaction ID and that PostgreSQL
contains one payout row for that withdrawal. Run a final `--once` pass and
expect `No unfinished payout for the configured reserve.`

## Watch Gridcoin Testnet for deposits

Apply the watcher migration once to `wgrcbridge_dev` with the database owner
or migration role. If the relayer connects as a separate role, grant it
`SELECT`, `INSERT`, and `DELETE` on `wgrc.gridcoin_blocks` and
`SELECT` and `INSERT` on `wgrc.gridcoin_deposit_discoveries`.

```bash
psql -X -W -h pg-dsc -d wgrcbridge_dev -U '<migration role>' \
  -v ON_ERROR_STOP=1 -f relayer/migrations/002_gridcoin_watcher.sql
```

Use the same Gridcoin RPC, reserve and confirmation settings as the deposit
pilot. On `gridtestnet`, obtain the Phase 2 block height from the block hash
reported by the deposit validator. For example, run the following with the
node's usual Testnet RPC configuration and take the `height` from the output.

```bash
gridcoinresearchd -testnet getblock 20f874f279b774f572339be613b211efe54278be33befea58360e9331cb4c12b
```

On `solchain`, from the repository root, replace `<start height>` with the
height of that block and run a catch-up pass.

```bash
cargo run -p wgrc-relayer -- watch-gridcoin '<start height>' --once
```

The starting block is included. Use the same starting height on subsequent
runs. The watcher resumes from the last committed block for the configured
reserve. Omit `--once` to keep polling every 15 seconds after catching up.
The watcher discovers confirmed payments without needing a Solana wallet.
The `process-deposit` command still handles minting.

```sql
SELECT d.block_height, b.block_hash, d.deposit_id, d.amount_base_units, d.recipient
FROM wgrc.gridcoin_deposit_discoveries AS d
JOIN wgrc.gridcoin_blocks AS b
  ON b.reserve_address = d.reserve_address AND b.height = d.block_height
WHERE d.txid = '448bd13d7db71908372e30bb40f98134506810637339161bbbf34415499bf76e';
```

Expect one discovery with `amount_base_units = 100000000` and the Phase 2
deposit ID. Run the catch-up command again to verify it resumes without
duplicating the discovery. On a reorganization, the watcher drops orphaned
discoveries and scans the replacement blocks. If an orphaned block already
has a mint record, reconcile it before restarting. If an RPC or database
error interrupts a scan, restart using the same command and starting height.

## Watch Gridcoin Testnet for deposits

Apply the watcher migration once to `wgrcbridge_dev` with the database owner
or migration role. If the relayer connects as a separate role, grant it
`SELECT`, `INSERT`, and `DELETE` on `wgrc.gridcoin_blocks` and
`SELECT` and `INSERT` on `wgrc.gridcoin_deposit_discoveries`.

```bash
psql -X -W -h pg-dsc -d wgrcbridge_dev -U '<migration role>' \
  -v ON_ERROR_STOP=1 -f relayer/migrations/002_gridcoin_watcher.sql
```

Use the same Gridcoin RPC, reserve and confirmation settings as the deposit
pilot. On `gridtestnet`, obtain the Phase 2 block height from the block hash
reported by the deposit validator. For example, run the following with the
node's usual Testnet RPC configuration and take the `height` from the output.

```bash
gridcoinresearchd -testnet getblock 20f874f279b774f572339be613b211efe54278be33befea58360e9331cb4c12b
```

On `solchain`, from the repository root, replace `<start height>` with the
height of that block and run a catch-up pass.

```bash
cargo run -p wgrc-relayer -- watch-gridcoin '<start height>' --once
```

The starting block is included. Use the same starting height on subsequent
runs. The watcher resumes from the last committed block for the configured
reserve. Omit `--once` to keep polling every 15 seconds after catching up.
The watcher discovers confirmed payments without needing a Solana wallet.
The `process-deposit` command still handles minting.

```sql
SELECT d.block_height, b.block_hash, d.deposit_id, d.amount_base_units, d.recipient
FROM wgrc.gridcoin_deposit_discoveries AS d
JOIN wgrc.gridcoin_blocks AS b USING (reserve_address, block_height)
WHERE d.txid = '448bd13d7db71908372e30bb40f98134506810637339161bbbf34415499bf76e';
```

Expect one discovery with `amount_base_units = 100000000` and the Phase 2
deposit ID. Run the catch-up command again to verify it resumes without
duplicating the discovery. On a reorganization, the watcher drops orphaned
discoveries and scans the replacement blocks. If an orphaned block already
has a mint record, reconcile it before restarting. If an RPC or database
error interrupts a scan, restart using the same command and starting height.
