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
remain 10-confirmation results. Subsequent redemption and reporting verification
at 6 confirmations is recorded below; deposit minting at the new boundary remains pending.

### Cancellation coordination and six-confirmation redemption

The following operator-run tests used Gridcoin Testnet, Solana Devnet and the
development database, with the bridge service stopped and commands invoked
explicitly. They exercise the real database and chains, rather than mocked RPCs.

**Cancellation before payout preparation.** Withdrawal
`EEsegJbd8L79Bexs5eUokkdXADFf6Aqp6AEk81yjE3Fp` requested 1 wGRC and
was discovered at finalized slot 525127945. Cancellation finalized with signature
`2RMzJorEAGWycgArVF6kpLHKpLsK9h3puaorb3j8DhxRzN8vRe2iiPPMLXrqATTxMQje6LGuNC17AobSCHpvbqHa`.
An explicit payout attempt was refused with
`Cancellation requested. Resume cancel-redemption; payout is blocked.`
Supply remained 863 wGRC, total burned remained 10.00000004 wGRC, and reserve
remained 1,863.993 GRC. All pending balances returned to zero. Reconciliation
at slot 525128317 returned `reconciled`, no open issues or shortfalls, and
`minimumGridcoinConfirmations: 6`.

**Payout preparation before cancellation.** Withdrawal
`73gHL8JZ5irgxEvYH5DUGuACe7FFC8fggK1vZcwK4Dcp` requested 1 wGRC.
Processing saved and broadcast payout
`8926186296056f6d8cf99a88c460c3afc9caff19c22904cb22f5bd75b9bddcdc`.
Cancellation was refused because a saved payout existed. Repeated processing
retained that transaction ID at 0, 1, 2 and 4 confirmations, then settled at
6 confirmations with signature
`BZuGqTKLRmTWpMSMiLQoYtjxA9Y6eRqkBg1aPGdKQhgwqLUQFrVs2d9pow4xjysPv5pmXuMgT6GXbVBCvdGJg49`.
Supply decreased to 862 wGRC and total burned increased to 11.00000004 wGRC;
total minted remained 873.00000004 wGRC. Reserve decreased by the 1 GRC payout
plus 0.001 GRC fee to 1,862.992 GRC. All pending balances were zero.
Reconciliation at slot 525131573 returned `reconciled` with no open issues or
shortfalls. This verifies live redemption settlement at the new threshold,
but does not exercise deposit minting at six confirmations.

**Two concurrent cancellation/payout attempts.** For each new 1 wGRC withdrawal,
the operator discovered the request, then launched `process-redemption` and
`cancel-redemption` as background processes in the same shell, retaining separate
logs and exit codes. Both runs had the following outcome:

- Cancellation exited 0 and finalized as `cancelled`.
- Payout exited 1 with the expected cancellation-intent refusal above.
- Supply stayed 862 wGRC and reserve stayed 1,862.992 GRC, with no additional burn.
- Pending deposits, escrow and payouts were zero; reconciliation had no open
  issues, backing shortfall or spendable shortfall.

| Run | Withdrawal account | Final reconciliation slot |
| --- | --- | ---: |
| First | `DM1Nm5UaAxTY6U1gwaG4BQBpeszJYnCguaWVf3STZCvN` | 525133188 |
| Second | `41jQeogDw3aMt1MHR6XNg8tU6xttGTb7ygbPGZpPmErZ` | 525133785 |

Cancellation signatures were
`G4N6VmL8Pyo3G8TjtZ6y1mdihF9JfRCg3htMrE87CfFEG9niu42p6M2Q5YwxjRWtPtgGFgQrGVtXVfaeDux4zK2`
and `4nxi3preFM5DB4ro737N36Srt6rvFHXxwAUBTmUwHt6MkWf41kBULpuGq6jYLAHhfCAy7or6idVKtKsDwpf38NBQ`,
respectively. Both reconciliation reports retained four acknowledged historical
issues in required backing of 862.00000004 GRC, giving surplus of
1,000.99199996 GRC.

These runs verify safe cancellation-winning outcomes with concurrently launched
commands. They do not prove every internal timing interleaving: a concurrent
payout-winning run and cancellation during settlement remain untested. The
sequential payout-first case above is distinct from those races. Subsequent
timeout coverage is recorded below.

### Two service instances processing the same requests

The operator ran two bridge services concurrently against the same development
database and reserve, with the 6-confirmation setting active. Starting supply was
862 wGRC and reserve balance was 1,862.992 GRC. The workload comprised:

- One 2 GRC deposit, transaction
  `71f197d1c1cc0e3aaf51ac3966aee080fe641986a420f14d665ba97e4e2f6ee6`,
  output 1, deposit ID
  `cbb962dac63ba753c30f4830df7c320fd6c58ff7282c6e7c423b2333e918110a`.
- One 1 wGRC withdrawal, account
  `Ht5akbrpRgQyspGBSwVSZMSkhy2mZuwXsbSKthNGXEFA`, to
  `mjdQ1AZnsTyc4HXu99doHzNEHnJJ4PC3gh`.

An intermediate supply report at slot 525136468 showed 2 GRC in one pending
deposit, 1 wGRC in withdrawal escrow, and 1 GRC awaiting payout confirmations.
The final supply report at slot 525140883 showed:

| Metric | Final result |
| --- | ---: |
| Total minted | 875.00000004 wGRC |
| Total burned | 12.00000004 wGRC |
| Outstanding supply | 863 wGRC |
| Pending deposits, withdrawal escrow, and payouts | All zero |
| Reserve balance | 1,863.991 GRC |

The operator confirmed receipt of the 1 GRC payout at the destination. Supply
matched `862 + 2 - 1 = 863`; reserve matched
`1862.992 + 2 - 1 - 0.001 fee = 1863.991`. The observed totals and payment
showed no duplicate mint, burn or payout in this two-service workload.

A subsequent Solana scan at slot 525141637 observed 16 withdrawals with zero
changes. Reconciliation at finalized slot 525141655 and Gridcoin tip
`a0665c5fb1ab22118d12095baff37b60075b12caeb6c2955b48cfb9fce4c82af`
returned `reconciled`, no open issues, no backing or spendable shortfall, no
pending escrow, and no confirmed payouts awaiting burn. Confirmed and spendable
reserve were both 1,863.991 GRC; required backing was 863.00000004 GRC, leaving
1,000.99099996 GRC surplus. Four historical acknowledgements remained counted.

This validates the observed outcome with two competing services for one deposit
and one withdrawal. Both worker logs and the payout transaction ID were not
provided for independent comparison, so no claim is made about specific lock
interleavings. The reports confirm the configured threshold was 6, but do not
establish the exact confirmation count at which the deposit minted. Sustained
load and forced failures with multiple services remain untested.

### Reserve-host migration and timeout attempt (2026-11-23)

The reserve RPC moved to `gridtestbridge:25715`, while funding remained on
`gridtestnet`. Withdrawal `5v91VtU5mRUqMvDinoE98RCdGUmpT3DwGVSfMypNA14K`
paid through transaction
`ad3ad04da4b5c9369f85ee6bdf4607760d6e8dba1d3df2562e4a9a295f91cc9d`.
A one-second worker limit completed normally; zero was rejected as invalid.
**No live timeout occurred**, so this attempt does not validate timeout recovery.
Normal retries kept the same transaction ID through five confirmations and
settled at six, with signature
`2A2C81Sj8KfFiehFQKv7BAhMztwcpXXZWMCg49vtQjKck1TLnvDiMBYyvuRguZFwVivNJhPbiVyGFeHprubdgvse`.

Final supply was 862 wGRC (875.00000004 minted, 13.00000004 burned), reserve
was 1,862.990 GRC, and all pending amounts were zero. Reconciliation at slot
525489020 returned `reconciled`, no open issues or shortfalls, required backing
862.00000004 GRC and surplus 1,000.98999996 GRC. This verifies normal redemption
and reporting using the new reserve host, not forced termination recovery.

### Controlled development worker-timeout procedure

With services stopped, create and discover a new test withdrawal, then process
it normally once to save a payout. Keep its withdrawal address and payout txid.
Against the reserve RPC, run:

```bash
WGRC_ENABLE_TEST_FAULTS=devnet \
WGRC_TEST_REDEMPTION_DELAY_SECONDS=10 \
WGRC_WORKER_TIMEOUT_SECONDS=1 \
  bash bin/wgrc process-redemption "$withdrawal"
```

Expect a `Devnet test delay` diagnostic followed by a worker timeout. The hook
only accepts public Solana Devnet, explicit fault opt-in, and advancement of an
already saved payout. It pauses before RPC or signing; it does not simulate a
lost broadcast response or a crash after settlement submission. Do not persist
these test variables in the service environment.

Retry without the three temporary variables and continue until settlement:

```bash
bash bin/wgrc process-redemption "$withdrawal"
```

Verify the original payout txid is reused, exactly one payout and burn occur,
pending balances return to zero, and reconciliation has no shortfall.
Live execution of this controlled procedure passed in the scenario below.

Local `node --test tests/worker.cjs` passed six tests, including actual supervisor
termination of the delayed child with exit 124, completion without the delay on
retry, and rejection of missing opt-in, non-Devnet, invalid delay and unsaved
payout configurations. These tests do not access PostgreSQL or either blockchain.

### Live controlled timeout recovery result (2026-11-23)

An initial invocation of the delay on already settled withdrawal
`5v91VtU5mRUqMvDinoE98RCdGUmpT3DwGVSfMypNA14K` timed out; normal retry
returned its original payout and settlement signature. This exercised termination
and settled replay, not unfinished payout recovery.

For the unfinished-payout test, the operator created a new 1 wGRC withdrawal:
`3Zs23PA1oBhf2rnnwdEQFfE4rb4pP3QPSjo8M7ovbZQE`.
The delay initially refused to run before a payout had been saved, as intended.
Normal processing then saved and broadcast transaction
`4f9226ab5fb313f8f4bf7f9f8ac08f3b8e607073586b929b2459e82df1c7eae5`
at zero confirmations. A 10-second test delay with a one-second worker limit
produced the expected delay diagnostic and `Worker timed out after 1s`.

Retrying without the fault variables resumed that same transaction at zero
confirmations. Subsequent calls reported 2, 4 and 5 confirmations, then settled
at 7 (configured minimum 6), with signature
`55ZcSoNM6rHamkoRo8arCvwwxRkTHcx3H2K6c3T78udLZwd3qGFGijrsqm1NTAe6cA347ky1Nzva7RuFHFQkyG3a`.
The Solana watcher observed the settlement at finalized slot 525493664.

Final supply at slot 525493680 was 861 wGRC: total minted remained
875.00000004 wGRC and total burned increased by one to 14.00000004 wGRC.
Reserve decreased from 1,862.990 to 1,861.989 GRC, matching a 1 GRC payout
plus 0.001 GRC fee. All pending balances were zero.

Reconciliation at slot 525493697 and Gridcoin tip
`fd52755509d198a4c77b470f1c069dedf0a81859ae9e35866140b5a5dd301502`
returned `reconciled`, no open issues or shortfalls, and confirmed/spendable
reserve of 1,861.989 GRC. Required backing was 861.00000004 GRC, including
four acknowledged historical base units, leaving 1,000.98899996 GRC surplus.

This passes live timeout recovery before advancement of an already saved payout:
the original transaction was retained and final accounting shows one payout's
reserve reduction and one burn. The supplied evidence does not include a separate
destination-wallet receipt check for this withdrawal. The hook runs before RPC
and signing, so ambiguous broadcast, post-submission settlement and database
commit failure boundaries remain untested.

### Lost payout-broadcast response recovery (2026-11-24)

Lost broadcast response test hook: on a new discovered withdrawal, use
`WGRC_ENABLE_TEST_FAULTS=devnet WGRC_TEST_LOST_BROADCAST_RESPONSE=1 bash bin/wgrc process-redemption "$withdrawal"`
for the first processing call, with all services stopped. It validates explicit
Devnet opt-in before processing and throws after Gridcoin acknowledges broadcast,
before returning a successful advancement result. Retry the same withdrawal
without the variables, verify the same payout txid and exactly one payment/burn,
then reconcile. This simulates response loss after acceptance, not a network outage.
Fourteen mocked redemption tests passed locally
(the unavailable web3 module was stubbed for these pure logic tests), including
the injected failure followed by same-transaction recovery and one broadcast.

The operator ran this hook on withdrawal
`GiocURs6aX84Z24QWV1GhE7F5XsbZ8ojY9m2C3Df1VCy`, discovered at finalized
slot 525823259. The first processing call reported that Gridcoin had accepted
payout `5536ce1987e4b6cb1940845752a199cdfd9e743a00506d32d3ff78c251b5ad16`,
then raised the simulated lost-response error. Normal retries recovered the same
transaction at zero and five confirmations. At six confirmations, settlement
completed with signature
`4gsEW2y6vngmfb7pHgRyCoiNyvsw1KSyyNZFqenCZxJdQT9HgtK5dwMwUMfHW53fuF9Wtt8hsnqphWuLmcd7Hk4i`.

The Solana watcher observed settlement at slot 525826544. The final supply report
at slot 525826564 showed total minted unchanged at 875.00000004 wGRC, total
burned increased to 15.00000004 wGRC, and outstanding supply of 860 wGRC.
All pending deposits, escrow and payouts were zero. Reserve decreased from
1,861.989 to 1,860.988 GRC, matching one 1 GRC payout plus a 0.001 GRC fee.

Reconciliation at slot 525826583 and Gridcoin tip
`cd5e317f3737833970eed13a3acfb71f4f834e53bbb73fea8ae5aba9260792ba`
returned `reconciled`, no open issues or shortfalls, and confirmed/spendable
reserve of 1,860.988 GRC. Required backing was 860.00000004 GRC and surplus
was 1,000.98799996 GRC; four historical acknowledgements remained included.

The live hook, retries and final accounting verify recovery after simulated
response loss following an accepted Gridcoin broadcast, with no observed extra
payout or burn. The operator also confirmed receipt of 1 GRC at destination
`mjdQ1AZnsTyc4HXu99doHzNEHnJJ4PC3gh`, completing the destination receipt check
for this test. This does not establish
recovery from a lost Solana settlement response, a real network outage, or a
chain reorganization.

### Lost Solana settlement-response recovery (2026-11-24)

The first attempt used withdrawal
`2jv3GFWjRL1YJSpgkdZ2bJj2ZFJc6oqjF8VMGD6oRbtJ` and payout
`d15ec962c61c04e567c126694ec722d91d435db204f8ec92fb8cd9564985f172`.
It settled normally at six confirmations because solchain had not yet received
the new hook code. The operator confirmed the missing update. This was a normal
redemption, not a successful fault-injection test, and reduced supply to 859 wGRC.

After updating the code, the operator created withdrawal
`136J4wifwj5JbuHBgiSqNiakbBPMed7n1R2bin8pmv9y`, discovered at finalized
slot 525833964. Processing with `WGRC_ENABLE_TEST_FAULTS=devnet` and
`WGRC_TEST_LOST_SETTLEMENT_RESPONSE=1` saved payout
`a64c7fa45f799bdb1db9c60cf1adaba92b5ab50703367db6b415a6ccfba9627e`.
Calls reported zero and three confirmations before the hook reported finalized
settlement and deliberately failed instead of returning success to the relayer.
The finalized settlement signature printed in the error was
`2kqEjz6Dac5KzmFFsSPcZ8mSHxxsE7t8DSAVkasXUaMq3bKocejmXZxsr1FAegi3ZsKLpYfNgX9gNKQ6KM7Z93tr`.

A normal retry returned `settled` at six confirmations with the same payout txid
and `settlementSignature: null`. This is expected for this recovery path: the
successful response was lost, and the relayer recovered from finalized on-chain
state without submitting another settlement. The signature remains in the fault
log; recovery did not reconstruct it in the database.

The watcher observed settlement at slot 525835820. Final supply at slots
525835836–525835837 was 858 wGRC, with total minted unchanged at 875.00000004
wGRC and total burned 17.00000004 wGRC (including the earlier normal attempt).
Reserve was 1,858.986 GRC, matching one further 1 GRC payout plus 0.001 GRC fee.
Pending deposits, escrow and payouts were all zero. The operator separately
confirmed receipt of 1 GRC at `mjdQ1AZnsTyc4HXu99doHzNEHnJJ4PC3gh`.

Reconciliation at slot 525835851 and Gridcoin tip
`ecac915fe45b29fca13480991e8f879c9c3ffcc0baa5a5e7602ec15d0e772667`
returned `reconciled`, no open issues or shortfalls, and confirmed/spendable
reserve of 1,858.986 GRC. Required backing was 858.00000004 GRC, leaving
1,000.98599996 GRC surplus; four historical acknowledgements remained included.

This passes recovery after simulated response loss following finalized Solana
settlement, with no observed duplicate payment or burn. It does not exercise
an actual network outage, a pre-finalization interruption, or every database
commit/crash boundary.

### Five-deposit/five-withdrawal batch with two workers (2026-11-24)

The operator ran two bridge services against the same development database and
reserve to process five 1 GRC deposits and five 1 wGRC withdrawals. Funding used
`gridtestnet`; reserve processing used `gridtestbridge`, with a six-confirmation
threshold. The baseline was 858 wGRC outstanding and 1,858.986 GRC reserve.

Intermediate reports showed all five deposits awaiting minting and five
withdrawals in escrow, with only one payout awaiting confirmation at a time.
After deposits minted, escrow decreased as each payout settled. The updated
report showed one active payout at 2 of 6 confirmations with two withdrawals
queued, then one at 5 of 6 with one queued. This exercised competing workers
and queue draining while payouts remained serialized per reserve.

During the run, a reporting error rejected missing/null payout confirmations.
The report was corrected to treat these as zero, matching redemption processing,
while retaining errors for negative or malformed values. Seven local reporting
tests passed. Subsequent live reports displayed confirmation progress and queue
counts successfully. The original RPC response was not captured, so missing/null
confirmations remain the likely explanation, not a directly verified cause.

Final supply at slot 525855441 showed:

| Metric | Baseline | Final result |
| --- | ---: | ---: |
| Total minted | 875.00000004 wGRC | 880.00000004 wGRC |
| Total burned | 17.00000004 wGRC | 22.00000004 wGRC |
| Outstanding supply | 858 wGRC | 858 wGRC |
| Reserve | 1,858.986 GRC | 1,858.981 GRC |

All pending deposits, withdrawal escrow, payouts awaiting confirmations and
queued payouts were zero. Reserve matched `1858.986 + 5 - 5 - 0.005 fees`.
The operator confirmed reserve changes in the explorer and receipt of five
separate 1 GRC payments at the destination.

A subsequent Solana scan at slot 525856341 observed 26 withdrawals with zero
changes. Reconciliation at slot 525856359 and Gridcoin tip
`3db101c0e30c686728625ada3cc411a791c7abc89145a085d7aef71d02747f30`
returned `reconciled`, no open issues, no backing or spendable shortfall, no
pending escrow and no confirmed payouts awaiting burn. Confirmed/spendable
reserve was 1,858.981 GRC, required backing was 858.00000004 GRC and surplus
was 1,000.98099996 GRC. Four historical acknowledgements remained included.

This modest batch passed on observed accounting and operator-confirmed receipts,
with no excess mint, burn or payment. Individual deposit/withdrawal identifiers
and both full worker logs were not supplied for independent per-request review.
It is not sustained-load, throughput, or exhaustive interleaving validation.

### Scope still outstanding

- Sustained workloads and forced failures with multiple daemon instances.
- Concurrent payout-winning cancellation race and cancellation during settlement.
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
- [x] Verify cancellation-first and payout-first protection against PostgreSQL and Devnet.
- [x] Verify concurrent cancellation-winning processing (two live runs).
- [x] Verify two service instances sharing the database and reserve for one 2 GRC deposit and one 1 wGRC withdrawal, with expected totals, received payout and clean reconciliation.
- [x] Verify a five-deposit/five-withdrawal batch with two services, drained queue, expected accounting, five operator-confirmed payments and clean reconciliation.
- [ ] Verify concurrent payout-winning races and settlement races.
- [x] Verify controlled timeout before advancement of a saved unfinished payout, followed by same-transaction recovery and reconciled settlement.
- [x] Verify overlapping deposits and withdrawals live through one service (2 + 3 GRC deposits; 1 + 2 wGRC withdrawals).
- [x] Verify service restart recovery of an awaiting-confirmation payout with the same transaction ID and expected final supply.
- [x] Verify repeated service interruptions/restarts during a mixed-flow workload, with expected totals and two separately received payouts.
- [ ] Verify fault-injected duplicate prevention at controlled failure boundaries.
- [x] Verify same-payout recovery and reconciled settlement after simulated loss of an accepted Gridcoin broadcast response.
- [x] Verify recovery after simulated loss of a finalized Solana settlement response, with unchanged payout txid, expected accounting and operator-confirmed 1 GRC receipt.
- [x] Obtain operator confirmation of the destination-wallet receipt for the lost-broadcast-response test (1 GRC received).
- [x] Verify development redemption settlement and reporting with the new 6-confirmation default.
- [ ] Verify deposit minting at the new 6-confirmation boundary.
- [x] Test complete Gridcoin-to-Solana CLI flow with sequential manual processing.
- [x] Test complete Solana-to-Gridcoin CLI flow with sequential manual processing.
- [ ] Test failures, restarts, and duplicate prevention.

### Phase 5 — Production Readiness

- [ ] Perform independent security assessment.
- [ ] Verify reserve transparency.

The supervised service deployment milestone remains in the README. Live service
operation and overlapping flows have the pilot coverage recorded above;
the remaining cancellation/payout interleavings, timeouts at other failure boundaries, and broader
fault recovery remain open.
Additional service test steps are
in [the operating guide](docs/bridge-service.md#validation-before-unattended-payouts).
