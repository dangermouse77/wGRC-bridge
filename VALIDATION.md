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
overlapping mint completion, and failed source lookups. The live mixed-flow
result below verifies aggregate outcomes; it does not independently trace every
payout input to prove protection under all possible interleavings.

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
Taken alone, they do not verify unattended service operation, concurrent requests,
cancellation/payout races, or the new worker timeout behavior under live faults.

## Phase 4 live overlapping flows and service recovery

The operator supplied the following live results from `solchain`, using Gridcoin
Testnet, Solana Devnet, and the development PostgreSQL database. These are observed
pilot outcomes, not a load test or a guarantee for arbitrary concurrent workers.

### Two deposits and two withdrawals outstanding together

Two deposits of 2 and 3 GRC overlapped with withdrawals of 1 and 2 wGRC.
While processing was still underway, the supply report showed 82 wGRC outstanding,
3 wGRC in withdrawal escrow, 5 GRC in two pending deposits, and no payouts yet
awaiting confirmation. Historical Gridcoin scanning delayed processing.

After completion, the operator reported:

| Metric | Before completion | After completion |
| --- | ---: | ---: |
| Total minted | 86.00000004 wGRC | 91.00000004 wGRC |
| Total burned | 4.00000004 wGRC | 7.00000004 wGRC |
| Outstanding supply | 82 wGRC | 84 wGRC |
| Pending withdrawal escrow | 3 wGRC | 0 wGRC |
| Pending deposits | 5 GRC (2 deposits) | 0 GRC |
| Payouts awaiting confirmation | 0 GRC | 0 GRC |

The final supply matches `82 + 5 - 3 = 84`. The final report used finalized
Solana slot 524825335 and Gridcoin tip
`87e6947a79c02e673b1450a3b80057289b4890cf5c773c907e906f7fad1ce357`.
No excess mint or burn appeared in these totals. This exercised overlapping
requests handled by one service, not multiple independent daemon instances.

### Service restart with a payout awaiting confirmations

A subsequent 1 wGRC withdrawal used account
`81ryB76eg8bYmGG4aPBKyBgtgZuJNt9yEPRvJjau2nwN` and Gridcoin payout
`89b28d54dd7e5bc15f5093c81ebe6ce27a66f9209684acace8f696bb216448fe`.
The payout initially stayed at zero confirmations while Gridcoin Testnet stopped
advancing at height 3343641. When two blocks arrived, the relayer reported two
confirmations. After installing automatic checkpoint resume and restarting the
service, the operator reported three confirmations for the continuing payout.

Recovery settled the same payout at 10 confirmations, with Solana signature
`3tDUeZQpDA9GgQSTxxT9bjxtgkCYVTJ4Zu4mfCYVaa7h25K5kukAdywDEqdNW1PFqUVQ9PT5bxedPaP9M5xE9iHt`.
Outstanding supply decreased from 84 to 83 wGRC; total burned increased to
8.00000004 wGRC, with total minted unchanged at 91.00000004 wGRC.
Pending deposits, escrow, and payouts all returned to zero. These observations
support saved-payout recovery across a service restart without an observed
duplicate payout or burn for this withdrawal.

### Repeated interruptions during mixed deposits and withdrawals

The subsequent live test started with 860 wGRC outstanding and 1,860.995 GRC
in the configured reserve. The operator submitted deposits of 2 and 3 GRC:

- `5bb55e23c05b13a8b14b1288f0bcefbeaa37c4b1124cf5bcdf2f1252ac66dad3`
- `7dabf00b7eecb238b9e2dae6ddb3a32254f1ea6c5065286f541e968fc06314b8`

Two 1 wGRC withdrawal requests used accounts
`6nNxz9n2TJQ2yRn8S6ZPYzrQAZenH6YnXNKj8yQHr1DX` and
`3ZArBmS6rwuvJrDK78cYUqcD6oH4tfiEkwkZzPPUF3ka`.
The service began from saved Gridcoin height 3343725. The operator reported
interrupting and restarting it several times while work remained pending.
The precise interruption boundaries were not captured; this was not a controlled
forced-crash test.

An intermediate report showed 5 GRC in two pending deposits, 2 wGRC in escrow,
and one payout awaiting confirmation. Repeated recovery/processing logs checked
the same payout `d4b2f8fdb387f72e36048a482554cb1dfdb44411cee731826d7bf6958b48a4eb`
for withdrawal `6nNxz9n2TJQ2yRn8S6ZPYzrQAZenH6YnXNKj8yQHr1DX`.
Later, both deposits had minted and one withdrawal had settled: supply was
864 wGRC, escrow was 1 wGRC, and one payout still awaited confirmation.
The pending-payout line counts only outstanding confirmations, not lifetime payments.

The final report at Solana slots 525124717–525124718 showed:

| Metric | Final result |
| --- | ---: |
| Total minted | 873.00000004 wGRC |
| Total burned | 10.00000004 wGRC |
| Outstanding supply | 863 wGRC |
| Pending deposits, withdrawal escrow, and payouts | All zero |
| Reserve balance | 1,863.993 GRC |

The operator confirmed that destination `mjdQ1AZnsTyc4HXu99doHzNEHnJJ4PC3gh`
received two separate 1 GRC payments. Supply matched `860 + 5 - 2 = 863`;
reserve matched `1860.995 + 5 - 2 - 0.002 fees = 1863.993`.
There was no observed excess mint, burn, or payout in this scenario.

Detailed reconciliation at finalized slot 525125328 returned `reconciled`,
no open issues, no backing or spendable shortfall, and no pending escrow or
confirmed payouts awaiting burn. Confirmed and spendable reserve were both
1,863.993 GRC; required backing was 863.00000004 GRC, leaving
1,000.99299996 GRC surplus. Four acknowledged historical issues remained included
as 0.00000004 GRC of conservative backing allowances while absent from open issues.
This also live-verified acknowledgement reporting and the simple supply coverage line.

Reports earlier rejected reads when the Gridcoin tip changed mid-inspection;
subsequent successful reports were obtained. These failures demonstrate the
consistency guard, not automatic retry (which was not tested here).

This test completed with the original 10-confirmation threshold. The development
default was subsequently reduced to 6 for future tests; historical results above
remain 10-confirmation results. Live verification at the new threshold is pending.

### Scope still outstanding

- Multiple daemon instances competing for the same database and reserve.
- Cancellation racing with payout preparation or settlement.
- Forced worker timeouts and crashes at signing, broadcast, and database commit boundaries.
- Reorganizations and ambiguous RPC responses during overlapping operations.
- Sustained load and controlled crash injection during mixed workloads.

## Validation milestones

### Bounded Gridcoin catch-up

Automatic resume is covered by a mocked service test for omitted height and a
Rust unit test for saved origins, explicit first starts, and mismatched heights.
Live no-height startup was observed with `wgrc serve --enable-payouts`: the
watcher selected `auto` and reported last scanned height 3343643, next height
3343644, and original start 3339204. That invocation initially encountered
Gridcoin RPC `ECONNREFUSED`; after connectivity was restored, the operator
confirmed receipt of a separate 777 wGRC deposit in Phantom. This is an additional
service/resume observation, not another mixed-flow concurrency test.

The service defaults to 50 scan steps per cycle and then runs the withdrawal
steps. Mocked service tests cover custom batch sizes, interleaving, unchanged
start height, and invalid settings. Rust unit tests cover batch limits,
resuming without skipping, catch-up completion, and error propagation.
Run `node --test tests/service.cjs` and
`cargo test -p wgrc-relayer batch_tests` before deployment. Live verification
should confirm `watch-solana` and payout recovery run between historical scan
batches while checkpoint heights continue advancing. Live logs showed repeated
50-step-limited watcher invocations interleaved with Solana scanning, payout
recovery, cancellation recovery, and payout processing, including a newly scanned
Gridcoin block at height 3343619. A prolonged historical backlog with a pending
payout has not yet been independently demonstrated after this batching change.

Completion states below incorporate the recorded live results above.

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
- [x] Verify overlapping deposits and withdrawals live through one service (2 + 3 GRC deposits; 1 + 2 wGRC withdrawals).
- [x] Verify service restart recovery of an awaiting-confirmation payout with the same transaction ID and expected final supply.
- [x] Verify repeated service interruptions/restarts during a mixed-flow workload, with expected totals and two separately received payouts.
- [ ] Verify fault-injected duplicate prevention at controlled failure boundaries.
- [ ] Verify development processing and reporting with the new 6-confirmation default.
- [x] Test complete Gridcoin-to-Solana CLI flow with sequential manual processing.
- [x] Test complete Solana-to-Gridcoin CLI flow with sequential manual processing.
- [ ] Test failures, restarts, and duplicate prevention.

### Phase 5 — Production Readiness

- [ ] Perform independent security assessment.
- [ ] Verify reserve transparency.

The supervised service deployment milestone remains in the README. Live service
operation and overlapping flows have the pilot coverage recorded above;
cancellation/payout races, worker timeouts, and broader fault recovery remain open.
Additional service test steps are
in [the operating guide](docs/bridge-service.md#validation-before-unattended-payouts).
