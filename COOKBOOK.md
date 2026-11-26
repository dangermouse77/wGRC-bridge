# Cookbook

## Reconciliation acknowledgements

Reserve RPC settings belong in the local, git-ignored `relayer/bridge.dev.json`:

```json
{
  "GRC_BRIDGE_RPC_URL": "http://gridtestbridge:25715",
  "GRC_BRIDGE_RPC_USER": "dangermousebridge",
  "GRC_BRIDGE_RPC_PASSWORD": "your-reserve-rpc-password"
}
```

Merge these fields into the existing JSON alongside the database and bridge
settings. Dedicated `GRC_BRIDGE_RPC_*` environment variables override JSON;
missing/empty values fall back to legacy `GRC_RPC_*` variables. If the password
is still absent, interactive wrappers prompt. Clear an exported funding
`GRC_RPC_PASSWORD` when leaving the bridge password blank to avoid that fallback.
Reserve operations (watchers, mint processing, redemption, withdrawal validation,
and reserve reports) use these settings. `wgrc deposit`, `broadcast-deposit`,
`create_deposit.sh`, and `broadcast_deposit.sh` keep using funding `GRC_RPC_*`
credentials. Keep real passwords in the ignored file, not example files; restrict
the local file to its service owner (`chmod 600 relayer/bridge.dev.json`).
Rebuild the Rust relayer and restart services after installing this revision.
The production example includes the same fields, but production execution is
not enabled by this configuration change.

Apply `relayer/migrations/006_reconciliation_acknowledgements.sql` before running reserve reconciliation with this revision, then rebuild the relayer.

After independently reviewing a historical withdrawal, acknowledge its current issue:

```bash
bash bin/wgrc reconcile-reserve --acknowledge WITHDRAWAL_ADDRESS --reason "Reviewed historical operation; backing retained"
```

This supports missing settlement records and legacy burn-first records. It requires sufficient confirmed and spendable backing. Reviewed issues disappear from the open issues list; when all issues are acknowledged and backing is sufficient, status becomes `reconciled`. Their conservative backing allowances remain included: acknowledgement does not prove payment, cancel a withdrawal, or release reserves. Changed issue details require a new review, and shortfalls remain visible.

The audit table `wgrc.reconciliation_acknowledgements` retains the original report, reason, database user and timestamp. Inspect it with `SELECT * FROM wgrc.reconciliation_acknowledgements ORDER BY acknowledged_at;`. Existing Devnet/Testnet restrictions still apply; this does not enable Mainnet operation.
