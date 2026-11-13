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
2. The Solana bridge program burns the specified amount of wGRC.
3. A withdrawal request is recorded on-chain, including the destination Gridcoin address.
4. The relayer verifies the finalized burn and withdrawal request.
5. The Gridcoin payout operator transfers the corresponding GRC from the reserve.
6. The relayer records the payout transaction and its confirmation status.

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
- Burning wGRC during redemption.
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
- Coordinate Gridcoin redemption payments.
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

# Burn 500 wGRC and request native GRC
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

The final protocol specification will define deposit identifiers, network separation, confirmation requirements, malformed payload handling, and supported transaction structures.

Gridcoin `OP_RETURN` support and transaction construction must be verified against the target Gridcoin Core version and network before production use.

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
| Burn mechanism | Bridge program instruction |
| Metadata | Planned |
| Mainnet mint address | Not deployed |

The final token precision must be compatible with the Gridcoin network's native amount representation. Conversions must be exact and must never introduce unbacked units.

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
config/
├── devnet.toml
└── mainnet.toml
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

The project will include automated tests for:

- Bridge initialization.
- Authorized and unauthorized minting.
- Duplicate deposit rejection.
- Token burning and withdrawal creation.
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

A successful burn does not automatically guarantee a Gridcoin payout. Redemption depends on the bridge's reserve custody and payout infrastructure.

### Reserve Accounting

The intended solvency invariant is:

```text
Confirmed GRC reserves
    >=
Outstanding wGRC supply
    + Unpaid GRC redemption obligations
```

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

- [ ] Implement Anchor bridge program.
- [ ] Create wGRC SPL mint.
- [ ] Implement deposit receipts and replay protection.
- [ ] Implement burn and withdrawal requests.
- [ ] Implement administration and emergency controls.
- [ ] Add automated contract tests.
- [ ] Deploy and test on Solana Devnet.

### Phase 2 — Gridcoin Deposit Protocol

- [ ] Verify `OP_RETURN` support.
- [ ] Define the final deposit payload specification.
- [ ] Implement deposit transaction creation.
- [ ] Test deposits on Gridcoin Testnet.
- [ ] Implement transaction and confirmation validation.

### Phase 3 — Relayer and PostgreSQL

- [ ] Implement Rust relayer.
- [ ] Create PostgreSQL schema and migrations.
- [ ] Implement Gridcoin watcher.
- [ ] Implement Solana watcher.
- [ ] Implement mint processing.
- [ ] Implement redemption processing.
- [ ] Implement retry and recovery logic.
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

- [ ] Publish token metadata.
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

