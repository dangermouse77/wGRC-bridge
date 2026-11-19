# Validation

Test procedures, recorded results, and outstanding validation work for wGRC Bridge.
See [README.md](README.md) for architecture, operation, and the implementation roadmap.

Results below describe the versions and environments tested at the time; earlier
passes do not establish that every later change has been tested. Mocked tests,
localnet tests, and live Testnet/Devnet verification have different scopes.

## Gridcoin protocol verification

Deposit construction and `OP_RETURN` relay were verified on Gridcoin Testnet.
Production deployment still requires verification against the target Gridcoin
Core version and network.

## Supply-cap test coverage

Validate with `anchor test` on localnet before upgrading Devnet.
Contract tests cover authority checks,
the exact boundary, rejection without a receipt, escrow accounting, burns,
and competing mints at the final available base unit.

## Running the test suites

### Localnet integration tests

Run the bridge integration test from the repository root on a machine with
Node.js, npm, Anchor, and `solana-test-validator` installed:

```bash
npm install
anchor test --provider.cluster localnet --validator legacy
```

The test uses a fresh local validator and the wallet in `Anchor.toml` as the
program's upgrade authority. It covers minting, redemption, unauthorized mint
attempts, invalid withdrawal addresses, deposit and withdrawal replays,
escrow settlement, cancellation, and rejection of a second resolution.

If Anchor times out waiting for RPC, start the legacy validator separately.
In one terminal, launch a fresh ledger and leave the validator running:

```bash
solana-test-validator --version
solana-test-validator --ledger "$(mktemp -d)" --bind-address 127.0.0.1
```

In a second terminal, from the repository root, check RPC, fund the wallet
configured in `Anchor.toml` with local SOL, and run the suite:

```bash
solana --url http://127.0.0.1:8899 cluster-version
wallet="$HOME/.config/solana/devnet.json"
solana --url http://127.0.0.1:8899 airdrop 10 "$(solana-keygen pubkey "$wallet")"
anchor test --provider.cluster localnet --validator legacy --skip-local-validator
```

Use a fresh validator ledger for each run because the test initializes the
bridge. If the validator exits or RPC stays unavailable, check the output
in the first terminal. With a compatible Surfpool installation, you can
also run `anchor test --provider.cluster localnet` on Anchor's default backend.

### Devnet smoke test

From the repository root, use the funded wallet configured as the mint
operator on the initialized Devnet bridge:

```bash
anchor build
export ANCHOR_PROVIDER_URL=https://api.devnet.solana.com
export ANCHOR_WALLET="$HOME/.config/solana/devnet.json"
export WGRC_TESTNET_GRIDCOIN_ADDRESS='<your Gridcoin Testnet address>'
npm run test:devnet
```

If the earlier Devnet run left a temporary operator in bridge settings,
set `ANCHOR_WALLET` to the bridge admin wallet and run
`WGRC_ROTATE_DEVNET_OPERATOR=1 npm run test:devnet` once. This switches the
configured operator to the admin wallet until the admin changes it again.

Use a development deployment with payout processing disabled. The smoke
test mints, locks, and settles one base unit in the same transaction and
verifies the synthetic deposit receipt, withdrawal record, and ending token
balance. The payout transaction ID is synthetic. Upgrade the Devnet program
to the escrow version before running this test.

The project will include automated tests for:

- Bridge initialization.
- Authorized and unauthorized minting.
- Duplicate deposit rejection.
- Escrow locking, withdrawal creation, settlement burns, and cancellation refunds.
- Invalid withdrawal parameters.
- Emergency pause behavior.
- Administrative authority transfers.
- Transaction retry and crash recovery.
- Database consistency.
- Blockchain reorganizations.
- Reserve reconciliation.

## Phase 1 results

The localnet suite passed, including escrow cancellation and replay
protection. The Devnet smoke test passed with a synthetic payout transaction
ID. The read-only `npm run supply` command reports mint, burn, and escrow totals.

## Phase 2 results

The deposit script constructed, signed, broadcast, and validated a 1 GRC
deposit on Gridcoin Testnet. Transaction
`448bd13d7db71908372e30bb40f98134506810637339161bbbf34415499bf76e`
carried the 37-byte payload in a one-base-unit `OP_RETURN` output and passed
the `check` command at 10 active-chain confirmations. Phase 3 reused this
deposit to verify the relayer's mint flow.

## Phase 3 results

The Rust relayer on `solchain` processed the confirmed Phase 2 deposit by
transaction ID, minted 1 wGRC on Solana Devnet, and recorded the finalized
receipt in `wgrcbridge_dev` on `pg-dsc`. Reprocessing the deposit returned the
same receipt and mint signature without minting again. The
[deposit pilot runbook](runbooks/relayer-devnet.md) covers setup and verification.

The live Gridcoin watcher found the 1 GRC deposit to the dedicated Testnet
reserve at height 3339204 and recorded it once in PostgreSQL. A second run
resumed from its checkpoint and scanned only the two newly eligible blocks.

The live Solana watcher recorded three finalized Devnet escrow withdrawals
at slot 523320940. A second run advanced the PostgreSQL checkpoint to slot
523321721 and observed the same three withdrawals with zero changes.

The Gridcoin watcher discovered a confirmed 2 GRC deposit in Testnet block
3340013 and automatically minted 2 wGRC on Solana Devnet. A second run skipped
the finalized deposit without submitting another mint.

The live redemption pilot paid 1 GRC on Gridcoin Testnet and burned 1 wGRC
from Solana Devnet escrow after the payout reached 14 confirmations. Replaying
the command returned the original payout transaction ID and settlement
signature. The Solana watcher recorded the transition to settled once, and
PostgreSQL held one relayer payout row for the withdrawal.

The recovery worker was stopped while a live payout had 8 Gridcoin
confirmations. After restart it resumed the saved payout transaction and
settled the Devnet escrow automatically at 10 confirmations.

Live reserve reconciliation reported 30,000.998 confirmed and spendable GRC
against 1 wGRC in finalized Devnet supply. The report included four
unresolved historical base units in required backing of 1.00000004 GRC
and found no backing or spendable shortfall. The summary displayed the same
figures as the detailed report.

## Payout input protection tests

Mocked redemption tests cover protected deposits, finalized input release,
overlapping mint completion, and failed source lookups. Live mixed-flow
verification remains outstanding.

## Phase 4 sequential CLI results

Live sequential CLI verification on Gridcoin Testnet and Solana Devnet passed
on 2026-11-18 with the daemon stopped and processing invoked manually:

- `wgrc deposit` submitted 77 GRC. Validation rejected 7 and 9 confirmations,
  accepted 10, and `process-deposit` minted 77 wGRC, increasing outstanding
  supply from 6 to 83 wGRC. The pending-deposit report showed 77 GRC before
  minting and zero afterward.
- `wgrc withdraw` escrowed 1 wGRC. Repeated `process-redemption` calls tracked
  the same Gridcoin payout through 0, 1, 4, 6, and 7 confirmations and settled
  at 11 confirmations. Settlement burned 1 wGRC, leaving 82 wGRC outstanding.
  The Solana watcher observed settlement, and pending escrow, deposits, and
  payouts all returned to zero in the supply report.
- A separate deposit replay returned the original receipt and signature
  without changing the 6 wGRC supply at that time.

These results verify both sequential CLI flows and the live pending reports.
They do not yet verify unattended service operation, concurrent requests,
cancellation/payout races, or the new worker timeout behavior under live faults.

## Validation milestones

Completion states below were moved from the README without changing their status.

### Phase 1 — Solana Smart Contract

- [x] Add automated contract tests.
- [x] Test on Solana Devnet.

### Phase 2 — Gridcoin Deposit Protocol

- [x] Verify `OP_RETURN` support on Gridcoin Testnet.
- [x] Test deposits on Gridcoin Testnet.

### Phase 3 — Relayer and PostgreSQL

- [x] Verify deposit-backed Devnet minting and replay protection.
- [x] Verify the Gridcoin watcher against the live Testnet node.
- [x] Verify the Solana watcher against live Devnet withdrawals.
- [x] Verify automatic mint processing and replay protection on Devnet.
- [x] Verify the full redemption flow on Gridcoin Testnet and Solana Devnet.
- [x] Verify redemption recovery after interrupting and restarting the worker.
- [x] Verify reserve reconciliation against the live Testnet reserve and Devnet mint.

### Phase 4 — CLI and Integration Testing

- [x] Verify pending-deposit and pending-payout supply reports live.
- [ ] Verify cancellation/payout races and timeout recovery against PostgreSQL and Devnet.
- [ ] Verify overlapping deposits and withdrawals live, including worker restarts and duplicate prevention, before enabling automatic payout initiation.
- [x] Test complete Gridcoin-to-Solana CLI flow with sequential manual processing.
- [x] Test complete Solana-to-Gridcoin CLI flow with sequential manual processing.
- [ ] Test failures, restarts, and duplicate prevention.

### Phase 5 — Production Readiness

- [ ] Perform independent security assessment.
- [ ] Verify reserve transparency.

The supervised service deployment milestone remains in the README. Live service
operation, cancellation/payout races, worker timeouts, and mixed concurrent flows
still require verification as described above. Additional service test steps are
in [the operating guide](docs/bridge-service.md#validation-before-unattended-payouts).
