# wGRC Bridge

**An open-source, bidirectional bridge between Gridcoin and Solana.**

See [VALIDATION.md](VALIDATION.md) for test instructions, validation results, and outstanding validation milestones.

wGRC Bridge aims to bring Gridcoin (GRC) into the Solana ecosystem as **Wrapped Gridcoin (wGRC)**, an SPL token backed 1:1 by native GRC held in a publicly identifiable reserve.

The project is designed to enable Gridcoin holders to access Solana decentralized finance (DeFi), including decentralized exchanges such as Raydium, while preserving a redemption mechanism back to native Gridcoin.

> **Project status: Early development / Proof of Concept**
>
> The bridge is not production-ready. Smart contracts, relayer operations, reserve management, and security mechanisms require implementation, testing, and independent review. Do not use with real funds.

## Overview

Gridcoin is a cryptocurrency that rewards participation in scientific research through the BOINC distributed computing ecosystem.

Solana provides a high-performance blockchain supporting SPL tokens, decentralized exchanges, and programmable financial applications.

wGRC Bridge connects these ecosystems through a bidirectional wrapping mechanism.

**Gridcoin → Solana**

1. A user sends native GRC to the bridge's public Gridcoin reserve address.
2. The transaction includes an `OP_RETURN` payload identifying the recipient's Solana address.
3. The relayer detects the deposit and verifies the transaction and its confirmations.
4. An authorized operator invokes the Solana bridge program.
5. The program mints the corresponding amount of wGRC to the recipient.

**Solana → Gridcoin**

1. A user requests redemption of wGRC.
2. The Solana program locks the requested wGRC in a dedicated escrow vault and records a pending withdrawal with the Gridcoin destination.
3. The relayer verifies the finalized request and coordinates the reserve payout.
4. Once the payout reaches the required Gridcoin confirmations, the operator submits its transaction ID to Solana. The bridge burns the locked wGRC and marks the request settled in the same transaction.
5. If the operator establishes that the payout did not occur and can no longer confirm, it can cancel the request and return the locked wGRC to a token account owned by the requester.

The configured mint operator also signs settlement and cancellation. Each
request can reach one terminal state. Pending requests can be resolved while
the bridge is paused. Requests created under the original burn-first program
remain legacy records and require separate payout reconciliation.

The intended conversion ratio is:

**1 wGRC = 1 GRC**

This is a redemption target backed by bridge reserves, not a guarantee of market price or immediate liquidity.

## Architecture

The project consists of four main components.

### 1. Solana Smart Contract

Implemented in Rust using the Anchor framework.

Responsible for:

- Creating and managing the wGRC SPL token mint.
- Authorizing mint operations.
- Preventing duplicate minting of the same deposit identifier.
- Locking wGRC on request, burning it after payout confirmation, and returning it on safe cancellation.
- Recording withdrawal requests on-chain.
- Managing bridge administrators and operators.
- Supporting emergency pause functionality.

The smart contract does not communicate directly with Gridcoin or PostgreSQL.

### 2. Bridge Relayer

A Rust service responsible for monitoring both blockchains and coordinating cross-chain operations.

Planned responsibilities:

- Monitor Gridcoin blocks and transactions.
- Detect deposits to the bridge reserve address.
- Decode and validate wGRC `OP_RETURN` payloads.
- Wait for configurable Gridcoin confirmations.
- Submit authorized mint transactions to Solana.
- Monitor finalized Solana withdrawal requests.
- Coordinate Gridcoin redemption payments and submit settlement or cancellation instructions.
- Handle restarts, retries, and blockchain reorganizations.
- Reconcile reserve balances, circulating supply, and outstanding redemption obligations.

The relayer is designed to operate without a public HTTP API or web interface.

### 3. PostgreSQL Backend

PostgreSQL provides persistent operational state for the relayer.

Planned data includes:

- Gridcoin deposits and confirmation status.
- Solana mint transactions.
- Withdrawal requests.
- Gridcoin payout transactions.
- Blockchain synchronization checkpoints.
- Audit events.
- Reserve reconciliation results.

Database migrations will be version-controlled.

The blockchain records remain the authoritative source for on-chain activity. PostgreSQL is used for coordination, recovery, and operational auditing.

### 4. Command-Line Interface

A unified `wgrc` client supports deposit and withdrawal submission and read-only
status and supply reports. From the repository root on Testnet/Devnet:

```bash
# Deposit 1000 GRC and receive wGRC on Solana
bash bin/wgrc deposit 1000 \
  --solana-address <SOLANA_ADDRESS>

# Lock 500 wGRC and request native GRC
bash bin/wgrc withdraw 500 --gridcoin-address <GRIDCOIN_TESTNET_ADDRESS>

# Inspect on-chain bridge settings, supply cap, and available mint capacity
bash bin/wgrc status

# Inspect minted, burned, escrowed, and outstanding token supply
bash bin/wgrc supply
```

`deposit` uses the active funded sending wallet's Gridcoin RPC, validates the
Solana supply cap, creates and signs the transaction, saves it under
`deposits/<txid>.json`, and broadcasts it. It does not wait for confirmations
or mint immediately. The bridge daemon discovers confirmed deposits and mints
wGRC. It also discovers withdrawals, pays GRC, and settles escrow after the
required confirmations when payout initiation is enabled. User commands require
Node and npm dependencies; they do not require PostgreSQL credentials or the
compiled Rust relayer. Processing commands remain in the operator section of
`wgrc --help` for manual testing and recovery, not normal user submission.

If broadcasting fails or times out, retain the saved file and retry the same
transaction with `bash bin/wgrc broadcast-deposit deposits/<txid>.json`.
Do not rerun `deposit` to recover an uncertain broadcast, since that creates a
new payment. The existing helper scripts remain available.

`withdraw` uses the token owner's `ANCHOR_WALLET` to lock wGRC in escrow.
It validates the Testnet destination through Gridcoin RPC and rejects the
configured reserve address as the destination. It submits no GRC payout.
Requests are saved under `withdrawals/<withdrawal-address>.json` before
submission. If the response is uncertain, reuse the printed nonce with the
same amount, destination, and wallet:
`bash bin/wgrc withdraw 500 --gridcoin-address <ADDRESS> --nonce <SAVED_NONCE>`.
An existing finalized matching request is returned without locking tokens
again. Omitting `--nonce` creates a new request.

`status` and `supply` need only Solana RPC access and the generated IDL; neither
prompts for a password nor signs a transaction. `status` reports finalized
bridge settings and capacity, not daemon health or proof of GRC backing.
Operators use `reconcile-reserve` and service logs for those checks.

For GRC awaiting minting, run `bash bin/wgrc supply --pending-deposits` with
Gridcoin RPC connected to the **reserve wallet**. This optional read-only
inspection prompts for the RPC password if needed and adds, for example,
`Locked in pending deposits: 77 GRC`. It totals unspent valid bridge deposit
outputs with no matching finalized Solana receipt, including unconfirmed
outputs visible to that wallet. Ordinary reserve funding, minted deposits,
and change are excluded. “Locked” here means held at the reserve awaiting
minting, not a Gridcoin script-level lock. Spent deposit outputs and deposits
not visible to the wallet are outside this figure, so it is not a complete
audit of unpaid obligations. The cross-chain reads are observational, not an
atomic snapshot. Retry if chain state changes during inspection.
Plain `supply` stays password-free and labels pending deposits as not checked.

Operators can also run `bash bin/wgrc supply --pending-payouts`, or combine
both flags, to display `GRC payouts awaiting confirmation: 1 GRC`.
This requires the updated compiled relayer, configured PostgreSQL access, and
Gridcoin Testnet RPC. It reads unfinished payout records, matches finalized
Solana withdrawals, validates payout outputs, and totals observed payments
below the configured confirmation threshold. Fees are excluded. Confirmed
payments awaiting Solana settlement are not counted in this line, even while
their wGRC remains escrowed. Saved transactions not found on Gridcoin are
reported separately as unknown, not assumed broadcast. No payouts or
settlements are submitted by this report. The figure is an observational
snapshot of recorded payouts, not a complete reserve audit.

The client interacts with Gridcoin RPC and the Solana bridge program.

## Gridcoin Deposit Protocol

The bridge is designed to use a **single public Gridcoin reserve address** for deposits.

Recipient identification is embedded in the deposit transaction using `OP_RETURN`, avoiding the need to create individual Gridcoin deposit addresses for every user.

### OP_RETURN Payload — Version 1

| Field | Size | Description |
|---|---:|---|
| Magic | 4 bytes | ASCII `WGRC` |
| Version | 1 byte | `0x01` |
| Solana recipient | 32 bytes | Raw Solana public key |

Total payload size: **37 bytes**.

Binary representation:

```text
WGRC | 0x01 | SOLANA_PUBLIC_KEY
```

Hexadecimal prefix:

```text
5747524301
```

The relayer must validate the transaction, its destination, its amount, and the payload before authorizing minting.

The [v1 deposit specification](docs/protocol.md) defines the transaction
format, network-separated deposit ID, confirmation rules, and commands to
create and validate a deposit on Gridcoin Testnet.

## Token Specification

| Property | Value |
|---|---|
| Token name | Wrapped Gridcoin |
| Symbol | wGRC |
| Blockchain | Solana |
| Token standard | SPL Token |
| Decimals | 8 (proposed) |
| Backing asset | Native Gridcoin (GRC) |
| Target backing ratio | 1:1 |
| Initial maximum outstanding supply | 2,000,000 wGRC; configurable by the bridge administrator |
| Mint authority | Bridge program PDA |
| Burn mechanism | Operator settles an escrowed withdrawal after Gridcoin payout confirmation |
| Metadata | Metaplex metadata with a hosted JSON file and violet Gridcoin logo |
| Mainnet mint address | Not deployed |

The final token precision must be compatible with the Gridcoin network's native amount representation. Conversions must be exact and must never introduce unbacked units.

### Configurable supply cap

The bridge enforces an initial maximum outstanding supply of **2,000,000 wGRC**
(200,000,000,000,000 base units), matching the operator's stated initial GRC
backing capacity from Deep Space Computing AG. This limit is an issuance
control, not evidence that reserves have been funded; reserve reconciliation
remains necessary.

Every mint checks `current SPL supply + deposit amount <= maximum` on-chain.
An excess mint fails atomically without issuing tokens or creating a deposit
receipt. Concurrent mints cannot exceed the cap because they write the same
mint account. Escrowed withdrawals still count toward supply; completed burns
free capacity again. Only the current bridge administrator (`bridge.admin`)
can change the cap, including after an admin transfer. The mint operator alone
cannot. The cap cannot be lowered below existing supply.

The deposit scripts check finalized Solana capacity before creating and before
broadcasting a Gridcoin deposit. These checks do not reserve capacity. Another
deposit or an admin cap change can consume it before minting. Solana cannot
reject or reverse a native Gridcoin transaction: a deposit already broadcast
can still confirm, while its excess mint is rejected and stays pending in the
relayer for operator review. There is no automatic GRC refund. Resolve backing
and capacity before retrying; a guaranteed cross-chain rejection would require
a separate reservation/refund protocol.

**Deployment required:** these changes are not active on the deployed program
until it is upgraded. Stop mint workers, run `anchor build` to regenerate the
program and IDL, and upgrade the existing program using the upgrade authority.
Then use the bridge administrator wallet to initialize the separate supply-limit
PDA. The existing bridge account layout is unchanged. Both fresh deployments
and upgrades require this one-time initialization; minting fails closed until
it completes. Update all mint clients to include the `supplyLimit` account.

```bash
# ANCHOR_WALLET must point to the current bridge administrator's keypair.
bash bin/supply_limit.sh initialize       # Initial cap: 2,000,000 wGRC
bash bin/supply_limit.sh show             # Supply and cap in base units
bash bin/supply_limit.sh set 2000000      # Change cap in whole wGRC or up to 8 decimals
```

These scripts currently target Devnet. Use plain numbers without thousands
separators. No PostgreSQL migration is needed.

### Read the Devnet supply

From the repository root, run `npm install`, `anchor build` to generate the
IDL, and then `npm run supply`. The command defaults to Devnet and accepts
an RPC override through `ANCHOR_PROVIDER_URL`. It needs no wallet.

The report sums deposit receipts for total minted and pending requests for
locked wGRC. It subtracts the SPL mint supply from total minted to count
burns, including direct SPL burns. Circulating supply (minted minus burned)
includes escrowed wGRC. The report also shows supply outside pending
escrow. The escrow figure counts the requested amounts.

### Publish the Devnet token icon

Host `metadata/wgrc.json` at a public HTTPS URL. The JSON references the
official violet Gridcoin logo. If a wallet requires a raster image, use a
public PNG URL for its `image` field.

Build and deploy the upgrade with the Devnet program upgrade authority. Then
create the metadata account once using the bridge admin wallet:

```bash
anchor build
anchor deploy --provider.cluster devnet
export ANCHOR_PROVIDER_URL=https://api.devnet.solana.com
export ANCHOR_WALLET="$HOME/.config/solana/devnet.json"
node scripts/create-token-metadata.cjs '<public HTTPS URL of wgrc.json>'
```

The admin wallet becomes the Metaplex update authority. If bridge
administration changes, transfer metadata authority separately.

## Network Environments

The bridge supports two independently configured environments.

| Development | Production |
|---|---|
| Gridcoin Testnet | Gridcoin Mainnet |
| Solana Devnet | Solana Mainnet Beta |
| PostgreSQL development database | PostgreSQL production database |
| Test reserve and keys | Production reserve and keys |
| Test SPL mint | Production SPL mint |

Configuration files:

```text
relayer/
├── bridge.dev.example.json
└── bridge.prod.example.json
```

Sensitive information must never be committed to the repository.

Database credentials, Gridcoin RPC authentication, and private key material must be supplied through secure runtime configuration.

Production minting and withdrawals should remain disabled until the bridge has passed its security and operational readiness checks.

## Repository Structure

Planned layout:

```text
wgrc-bridge/
├── programs/
│   └── wgrc-bridge/
│       └── src/
│           └── lib.rs
├── cli/
│   └── wgrc/
├── relayer/
│   ├── Cargo.toml
│   └── src/
│       ├── main.rs
│       ├── config.rs
│       ├── gridcoin.rs
│       ├── solana.rs
│       ├── deposits.rs
│       ├── withdrawals.rs
│       ├── database.rs
│       └── reconciliation.rs
├── migrations/
├── config/
│   ├── devnet.toml
│   └── mainnet.toml
├── tests/
├── docs/
│   ├── protocol.md
│   ├── architecture.md
│   ├── security.md
│   └── recovery.md
├── .github/
│   └── workflows/
│       └── ci.yml
├── Anchor.toml
├── Cargo.toml
├── LICENSE
└── README.md
```

## Development

### Requirements

The intended development stack includes:

- Linux
- Rust and Cargo
- Solana CLI
- Anchor framework
- Node.js and a JavaScript package manager for Anchor tests
- Gridcoin Core with JSON-RPC access
- PostgreSQL
- Git

Exact supported versions will be documented as the implementation stabilizes.

### Building the Solana Program

Once the Anchor workspace is initialized:

```bash
anchor build
```

Inspect the configured program IDs:

```bash
anchor keys list
```

The program ID must be consistent across the source code, Anchor configuration, deployment keypair, and relayer configuration.

Development and production must use separate keys, token mints, databases, and reserve addresses.

## Security Model

**wGRC Bridge is initially designed as an operator-managed bridge, not a trustless cross-chain protocol.**

The Solana program cannot independently verify Gridcoin consensus or prove that GRC reserves exist.

Authorized bridge operators and the relayer are responsible for validating deposits and executing redemptions.

The initial design therefore includes important trust assumptions:

- Authorized mint operators must not issue wGRC without valid GRC deposits.
- Gridcoin reserve custodians must safeguard the backing assets.
- Redemption operators must honor valid withdrawal obligations.
- Infrastructure must prevent duplicate payouts.
- Administrative keys must be protected.
- The bridge must remain solvent.

Planned security controls include:

- Deterministic deposit identifiers.
- On-chain replay protection.
- Persistent transaction state.
- Idempotent transaction broadcasting.
- Separate operational and administrative permissions.
- Emergency pause controls.
- Reserve and supply reconciliation.
- Detailed audit logging.
- Independent security review before production deployment.

The Solana program trusts the operator's payout confirmation and cancellation
decisions. Users depend on the operator to resolve pending requests. The relayer
must serialize payout and cancellation decisions per request and persist a
payout transaction before broadcasting it, so a restart can resume tracking
the same transaction. A timeout alone cannot authorize cancellation. Once a
payout has confirmed, the relayer must retry Solana settlement if needed.

### Reserve Accounting

The intended solvency invariant is:

```text
Confirmed GRC reserves
    >=
Total wGRC supply
    - wGRC escrowed for confirmed payouts awaiting Solana settlement
    + Unpaid legacy burn-first redemption obligations
```

Pending escrow is included in SPL supply and counts once. Track and reconcile
confirmed payouts awaiting settlement against their specific escrow records.
Any reserve assets committed to other obligations must be excluded from available backing.
The [Testnet reconciliation report](runbooks/relayer-devnet.md#reconcile-the-reserve)
also counts escrow settlements without a verifiable payout as unresolved obligations.

### Gridcoin Staking

The project aims to investigate whether the native GRC reserve can participate in Gridcoin staking while maintaining full backing and redemption liquidity.

Any staking rewards must be accounted for separately from the GRC required to back outstanding wGRC and unpaid withdrawals.

Staking participation must not compromise reserve safety or redemption availability.

## Decentralization Roadmap

The initial bridge will use a limited number of trusted operators.

Long-term goals include:

- Independent relayer implementations.
- Multiple bridge operators.
- Transparent reserve monitoring.
- Shared operational governance.
- Reduced dependence on a single administrator.
- More robust key management and authorization policies.
- Community participation in bridge governance.

Open-source software alone does not make a bridge decentralized. Custody, mint authorization, and operational control must also evolve.

## DeFi Integration

One of the project's primary goals is to make Gridcoin accessible to Solana DeFi.

Potential applications include:

- wGRC transfers between Solana wallets at lightning speed.
- wGRC/USDT liquidity pools on Raydium.
- wGRC Faucet as Smart Contract
- Decentralized token swaps.
- Integration with compatible Solana wallets.
- Write any smart contract backed by wGRC
- Additional DeFi integrations as the ecosystem develops.

Liquidity pools are independent of the bridge's reserve mechanism.

Providing liquidity introduces financial risks, including impermanent loss, token price volatility, and smart contract risk.

No liquidity pool or exchange listing is guaranteed.

## Roadmap

Validation milestones and their completion status are tracked in [VALIDATION.md](VALIDATION.md#validation-milestones).

### Phase 1 — Solana Smart Contract

- [x] Implement Anchor bridge program.
- [x] Create wGRC SPL mint.
- [x] Implement deposit receipts and replay protection.
- [x] Implement escrowed withdrawals with payout settlement and cancellation.
- [x] Implement administration and emergency controls.
- [x] Deploy on Solana Devnet.

### Phase 2 — Gridcoin Deposit Protocol

- [x] Define the v1 deposit payload specification.
- [x] Implement deposit transaction creation.
- [x] Implement transaction and confirmation validation.

### Phase 3 — Relayer and PostgreSQL

- [x] Implement the Rust relayer command for a single deposit.
- [x] Create the PostgreSQL deposit schema and migration.
- [x] Implement Gridcoin Testnet deposit discovery with PostgreSQL checkpoints.
- [x] Implement finalized Solana Devnet withdrawal discovery with PostgreSQL checkpoints.
- [x] Connect Gridcoin deposit discovery to automatic Devnet mint processing.
- [x] Implement Testnet payout preparation, recovery, and Devnet escrow settlement.
- [x] Implement automatic retries and recovery for unfinished redemption payouts.
- [x] Implement a read-only reserve reconciliation report.

### Phase 4 — CLI and Integration Testing

The initial unified CLI and service runner are implemented. Build with
`cargo build --release -p wgrc-relayer`, then run
`bash bin/wgrc serve 3339204 --once` for one cycle, or omit `--once` for
continuous operation. For subsequent starts, omit the height with
`bash bin/wgrc serve --enable-payouts`; the saved checkpoint is used automatically.
An explicit start height is required only when the reserve has no checkpoint. The service
coordinates discovery, minting, payout and cancellation recovery, and periodic
reconciliation. Gridcoin scans yield after 50 block/rewind steps per cycle
(configurable with `WGRC_GRIDCOIN_BATCH_SIZE`) so catch-up does not occupy
the entire scan phase until the chain tip is reached. Checkpoints are preserved.
New payouts require explicit `--enable-payouts` and should stay
disabled for unattended operation until the live concurrency checks pass.
See [bridge service operations](docs/bridge-service.md) for the systemd
template, configuration, shutdown behavior, and live validation procedure.

Stop existing relayer workers, apply
`relayer/migrations/005_redemption_cancellations.sql`, and restart with the
updated code. Cancel an unpaid withdrawal with
`bash bin/cancel_redemption.sh WITHDRAWAL_ADDRESS`. Cancellation and payout
preparation share the same PostgreSQL advisory lock. Cancellation refuses
any saved payout, including an unconfirmed one, and commits a permanent intent
before submitting to Solana. The intent blocks payouts even after a timeout.
Retry the same cancellation command to finish or recover it, then run the
Solana watcher to refresh withdrawal status. Do not delete cancellation intents
or bypass this command with direct operator cancellation transactions.
This coordination requires all workers to use the updated relayer and the same
database; it does not change the smart contract or restrict direct operator calls.

Node workers have a 120-second deadline, configurable with
`WGRC_WORKER_TIMEOUT_SECONDS` (1–3600). The supervisor terminates timed-out
workers and their process tree, including on Linux `solchain`. Database lock
waits are limited to 15 seconds and statements to 30 seconds. A timeout does
not prove a blockchain submission failed. Resume the same operation; payout
recovery reuses saved bytes, and mint/cancellation retries check finalized
state. Continuous redemption recovery retries automatically. The service retries
failed watcher commands on its next cycle; standalone watchers can still exit
on errors.

Payout preparation checks the source transaction of each candidate reserve
output. Outputs from transactions containing `OP_RETURN` remain protected
until that exact outpoint has a committed finalized mint record in
`wgrc.deposits`. This covers deposits that the watcher has not discovered yet
and mints awaiting database recovery. Ordinary reserve funding and payout
change remain eligible. Unknown or malformed data transactions are also
protected conservatively. If eligible funds cannot cover the payout and fee,
preparation stops before signing; finish mint processing or fund the reserve
separately, then retry. Existing saved payouts retain their original bytes
and inputs during recovery. This protection applies to relayer payout
preparation; external wallet spending and staking require separate controls.

Deposit input protection itself requires no migration; cancellation
coordination requires migration 005 above.

- [x] Implement initial unified `wgrc` operator CLI.
- [x] Implement user-facing `deposit`, `withdraw`, `status`, and `supply` commands.
- [x] Implement a service runner and systemd template with opt-in queued payouts.
- [x] Coordinate relayer cancellation with payouts using durable cancellation intent.
- [x] Bound worker execution and database lock waits.
- [ ] Run the whole bridge as a supervised service on `solchain`, coordinating discovery, minting, queued payouts, recovery, and periodic reconciliation with graceful shutdown and restart.
- [x] Protect unminted deposit outputs from relayer payout input selection, including deposits not yet discovered by the watcher.
- [ ] Publish operational documentation.

### Phase 5 — Production Readiness

- [ ] Review custody and key management.
- [ ] Define operator governance.
- [ ] Establish monitoring and recovery procedures.
- [ ] Deploy to production after readiness approval.

### Phase 6 — Ecosystem Integration

- [x] Publish token metadata on Solana Devnet.
- [ ] Publish production token metadata after the mainnet mint is deployed.
- [ ] Improve wallet recognition.
- [ ] Explore Raydium liquidity integration.
- [ ] Expand community participation.
- [ ] Investigate multioperator architecture.

## Contributing

Contributions, code reviews, testing, documentation improvements, and security feedback are welcome.

The project aims to remain transparent, reproducible, and accessible to the Gridcoin and Solana developer communities.

Please open an issue before proposing substantial architectural changes.

Security-sensitive vulnerabilities should be reported privately rather than disclosed through public issues. A dedicated security reporting policy will be added.

## License

**Apache License 2.0 (proposed).**

See `LICENSE` once the license file has been added to the repository.

## Disclaimer

wGRC Bridge is experimental software.

It is provided for research, development, and educational purposes.

The project does not guarantee asset redemption, reserve solvency, smart contract security, or the availability of decentralized exchange liquidity.

**Do not use real funds until the bridge has undergone comprehensive testing, security review, and operational validation.**

---

*Connecting scientific computing and decentralized finance, one blockchain at a time.*

# Reconciliation acknowledgements

Apply `relayer/migrations/006_reconciliation_acknowledgements.sql` before running reserve reconciliation with this revision, then rebuild the relayer.

After independently reviewing a historical withdrawal, acknowledge its current issue:

```bash
bash bin/wgrc reconcile-reserve --acknowledge WITHDRAWAL_ADDRESS --reason "Reviewed historical operation; backing retained"
```

This supports missing settlement records and legacy burn-first records. It requires sufficient confirmed and spendable backing. Reviewed issues disappear from the open issues list; when all issues are acknowledged and backing is sufficient, status becomes `reconciled`. Their conservative backing allowances remain included: acknowledgement does not prove payment, cancel a withdrawal, or release reserves. Changed issue details require a new review, and shortfalls remain visible.

The audit table `wgrc.reconciliation_acknowledgements` retains the original report, reason, database user and timestamp. Inspect it with `SELECT * FROM wgrc.reconciliation_acknowledgements ORDER BY acknowledged_at;`. Existing Devnet/Testnet restrictions still apply; this does not enable Mainnet operation.

