# Phase 3 deposit pilot

Run the relayer on `solchain` with Gridcoin Testnet RPC on `gridtestnet`,
PostgreSQL on `pg-dsc`, and the existing wGRC deployment on Solana Devnet.
The command processes one confirmed Gridcoin transaction by ID.

## Prepare the database

Both databases live on `pg-dsc` and use the same `wgrc` schema. On `solchain`,
create the development connection file, then fill in the role and password.

```bash
install -m 600 relayer/database.dev.example.json relayer/database.dev.json
```

The relayer reads `relayer/database.dev.json` from the repository root.
An exported `DATABASE_URL` takes precedence. Unset it to use the JSON file.
For production, copy `relayer/database.prod.example.json` to
`relayer/database.prod.json` in the production environment and fill in the
production role and password. Git ignores both credential files. The deposit
pilot connects to the development database for Testnet and Devnet activity.

Apply the same SQL migration once per database, using its owner or a role that
can create the `wgrc` schema. For the pilot, run it against `wgrcbridge_dev`.
If you use a separate runtime role, grant it schema usage and table select,
insert, and update privileges.

```bash
psql -X -W -h pg-dsc -d wgrcbridge_dev -U '<migration role>' \
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
export WGRC_TESTNET_RESERVE_ADDRESS='<Phase 2 Gridcoin Testnet reserve address>'
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
