# wGRC Bridge

**An open-source, bidirectional bridge between Gridcoin and Solana.**

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

A unified `wgrc` CLI is planned for both deposit and withdrawal operations.

Example commands (proposed interface, not yet implemented):

```bash
# Deposit 1000 GRC and receive wGRC on Solana
wgrc deposit 1000 \
  --solana-address <SOLANA_ADDRESS>

# Lock 500 wGRC and request native GRC
wgrc withdraw 500 \
  --gridcoin-address <GRIDCOIN_ADDRESS>

# Inspect bridge status
wgrc status

# Inspect wrapped token supply
wgrc supply
```

The CLI will interact with Gridcoin RPC and the Solana bridge program.

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

Deposit construction and `OP_RETURN` relay were verified on Gridcoin Testnet.
Production deployment still requires verification against the target Gridcoin
Core version and network.

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
| Mint authority | Bridge program PDA |
| Burn mechanism | Operator settles an escrowed withdrawal after Gridcoin payout confirmation |
| Metadata | Metaplex metadata with a hosted JSON file and violet Gridcoin logo |
| Mainnet mint address | Not deployed |

The final token precision must be compatible with the Gridcoin network's native amount representation. Conversions must be exact and must never introduce unbacked units.

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

### Testing

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

#### Devnet smoke test

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

- wGRC transfers between Solana wallets.
- wGRC/USDT liquidity pools on Raydium.
- Decentralized token swaps.
- Integration with compatible Solana wallets.
- Additional DeFi integrations as the ecosystem develops.

Liquidity pools are independent of the bridge's reserve mechanism.

Providing liquidity introduces financial risks, including impermanent loss, token price volatility, and smart contract risk.

No liquidity pool or exchange listing is guaranteed.

## Roadmap

### Phase 1 — Solana Smart Contract

- [x] Implement Anchor bridge program.
- [x] Create wGRC SPL mint.
- [x] Implement deposit receipts and replay protection.
- [x] Implement escrowed withdrawals with payout settlement and cancellation.
- [x] Implement administration and emergency controls.
- [x] Add automated contract tests.
- [x] Deploy and test on Solana Devnet.

The localnet suite passed, including escrow cancellation and replay
protection. The Devnet smoke test passed with a synthetic payout transaction
ID. The read-only `npm run supply` command reports mint, burn, and escrow totals.

### Phase 2 — Gridcoin Deposit Protocol

- [x] Verify `OP_RETURN` support on Gridcoin Testnet.
- [x] Define the v1 deposit payload specification.
- [x] Implement deposit transaction creation.
- [x] Test deposits on Gridcoin Testnet.
- [x] Implement transaction and confirmation validation.

The deposit script constructed, signed, broadcast, and validated a 1 GRC
deposit on Gridcoin Testnet. Transaction
`448bd13d7db71908372e30bb40f98134506810637339161bbbf34415499bf76e`
carried the 37-byte payload in a one-base-unit `OP_RETURN` output and passed
the `check` command at 10 active-chain confirmations. Phase 3 reused this
deposit to verify the relayer's mint flow.

### Phase 3 — Relayer and PostgreSQL

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

- [x] Implement the Rust relayer command for a single deposit.
- [x] Create the PostgreSQL deposit schema and migration.
- [x] Verify deposit-backed Devnet minting and replay protection.
- [x] Implement Gridcoin Testnet deposit discovery with PostgreSQL checkpoints.
- [x] Verify the Gridcoin watcher against the live Testnet node.
- [x] Implement finalized Solana Devnet withdrawal discovery with PostgreSQL checkpoints.
- [x] Verify the Solana watcher against live Devnet withdrawals.
- [x] Connect Gridcoin deposit discovery to automatic Devnet mint processing.
- [x] Verify automatic mint processing and replay protection on Devnet.
- [x] Implement Testnet payout preparation, recovery, and Devnet escrow settlement.
- [ ] Verify the full redemption flow on Gridcoin Testnet and Solana Devnet.
- [ ] Implement automatic retries and recovery for the relayer.
- [ ] Implement reserve reconciliation.

### Phase 4 — CLI and Integration Testing

- [ ] Implement unified `wgrc` CLI.
- [ ] Test complete Gridcoin-to-Solana flow.
- [ ] Test complete Solana-to-Gridcoin flow.
- [ ] Test failures, restarts, and duplicate prevention.
- [ ] Publish operational documentation.

### Phase 5 — Production Readiness

- [ ] Review custody and key management.
- [ ] Perform independent security assessment.
- [ ] Define operator governance.
- [ ] Establish monitoring and recovery procedures.
- [ ] Verify reserve transparency.
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

