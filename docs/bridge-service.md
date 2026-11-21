# Testnet bridge service on solchain

This initial Phase 4 service uses Gridcoin Testnet and Solana Devnet. It does
not deploy or upgrade the smart contract. Run all commands from the repository
root. Stop older workers before switching to this service and apply migrations
001 through 005 in order (only those not already applied).

## Build and run

```bash
npm install
cargo build --release -p wgrc-relayer
bash bin/wgrc --help
bash bin/wgrc serve 3339204 --once
```

On an existing reserve, omit the height: `bash bin/wgrc serve --enable-payouts`.
The watcher reads its saved original start and latest checkpoint automatically
and logs the last scanned block and next height. Supply an explicit height
only for the first run on a reserve with no checkpoint. If you supply one
later, it must match the original start, not the current chain tip. A missing
checkpoint fails closed instead of silently starting at the tip.

The launcher reads
`relayer/bridge.dev.json` and the existing environment overrides. It prompts
for the Gridcoin RPC password only in an interactive terminal; otherwise set
`GRC_RPC_PASSWORD`. `WGRC_RELAYER_BIN` can select another prebuilt binary.

Omit `--once` for continuous operation. Each cycle runs Gridcoin discovery and
minting, Solana discovery, saved payout recovery, and cancellation recovery.
Reconciliation runs on the first cycle and then approximately every five
minutes. Successful cycles wait 15 seconds; failures increase that delay up
to 120 seconds. Commands run sequentially. Gridcoin scanning is limited to
50 block/rewind steps per cycle by default, followed by discovered-deposit
minting and the withdrawal steps even when historical catch-up is incomplete.
Set `WGRC_GRIDCOIN_BATCH_SIZE` to an integer from 1 to 10000 to change this.
Every scanned block retains its normal committed checkpoint; no blocks are
skipped. A batch boundary is not evidence that the watcher is caught up.
This bounds scan work, not total cycle time: RPC latency and pending mint
processing can still lengthen a cycle.

For example, `WGRC_GRIDCOIN_BATCH_SIZE=20 bash bin/wgrc serve 3339204
--enable-payouts` uses 20-block batches. Standalone `watch-gridcoin` retains
its full catch-up behavior unless given `--max-blocks N`; with `--once` it
returns after that batch and its mint attempts. Rebuild the relayer before
restarting the updated service. No database migration or checkpoint reset is
needed.

New payouts remain disabled by default. For a deliberate Devnet queue test:

```bash
bash bin/wgrc serve 3339204 --once --enable-payouts
```

This authorizes processing pending withdrawals, not merely scanning them.
The queue attempts at most one withdrawal per cycle, oldest observed first,
and resumes an existing unfinished payout before starting another. It excludes
cancellation intents and previously prepared payouts. The existing payout
lock and one-open-payout constraint remain authoritative. A failing oldest
withdrawal can hold up the queue; inspect the error and resolve it rather than
deleting records. Failed discovery or recovery skips new payout initiation for
that cycle. Reconciliation is an advisory report, not an automatic solvency
gate; inspect its JSON status and issues before enabling payouts.

## Install as a service

Review the paths, user, start height, and Node PATH in `deploy/` first. Store
credentials outside the repository:

```bash
mkdir -p ~/.config/wgrc-bridge
chmod 700 ~/.config/wgrc-bridge
install -m 600 deploy/service.env.example ~/.config/wgrc-bridge/service.env
# Edit service.env to set the real RPC password and executable paths.
sudo install -m 644 deploy/wgrc-bridge.service /etc/systemd/system/wgrc-bridge.service
sudo systemctl daemon-reload
sudo systemctl enable --now wgrc-bridge
journalctl -u wgrc-bridge -f
```

The supplied unit leaves new payouts disabled. After live validation, adding
`--enable-payouts` to ExecStart enables them. Reload systemd and restart after
changing the unit. Do not run a second scheduler alongside it.

`systemctl stop wgrc-bridge` asks the supervisor to finish its active command
and stop. After 180 seconds systemd kills remaining processes in the service
cgroup. Blockchain outcomes can still be uncertain after interruption; saved
payout bytes and cancellation intents must be retained for recovery. Node
worker deadlines default to 120 seconds. Watcher checkpoints and finalized
receipts are reused after restart. Reports and errors go to the journal.

## Validation before unattended payouts

```bash
node --test tests/service.cjs tests/worker.cjs tests/redemption.cjs
cargo check -p wgrc-relayer
```

On Testnet/Devnet, verify two deposits and two withdrawals together. Check
that each deposit mints once, pending deposit outputs stay unspent, each
withdrawal gets one payout, and escrow burns only after payout confirmation.
Interrupt and restart during payout confirmation; confirm the original txid
is reused. Try cancellation before payout preparation, then attempt payout
and confirm it is blocked. For a different withdrawal, prepare its payout
first and confirm cancellation is refused. Re-run discovery and reconciliation
after each scenario. The local service tests mock commands; they do not replace
these PostgreSQL and blockchain checks.
