# Phase 3 deposit pilot

Run the relayer on `solchain` with Gridcoin Testnet RPC on `gridtestnet`,
PostgreSQL on `pg-dsc`, and the existing wGRC deployment on Solana Devnet.
The command processes one confirmed Gridcoin transaction by ID.

## Prepare the database

On `solchain`, export `DATABASE_URL` for a dedicated development database on
`pg-dsc`. Configure the host, database, role, and TLS settings for that server.
Keep credentials out of shell history and the repository. Apply the migration
once with the database owner or a role that can create the `wgrc` schema.
If you use a separate runtime role, grant it schema usage and table select,
insert, and update privileges.

```bash
psql -X -v ON_ERROR_STOP=1 -f relayer/migrations/001_testnet_deposits.sql "$DATABASE_URL"
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
export WGRC_MIN_CONFIRMATIONS=6
export ANCHOR_PROVIDER_URL=https://api.devnet.solana.com
export ANCHOR_WALLET='<absolute path to the Devnet mint operator keypair>'

cargo run -p wgrc-relayer -- process-deposit \
  448bd13d7db71908372e30bb40f98134506810637339161bbbf34415499bf76e
```

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
