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
