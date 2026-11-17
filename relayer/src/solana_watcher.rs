use crate::{node, Result};
use postgres::Client;
use serde::Deserialize;
use std::{collections::HashMap, thread, time::Duration};

#[derive(Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
struct Withdrawal {
    address: String,
    owner: String,
    nonce: String,
    amount_base_units: String,
    gridcoin_address: String,
    status: String,
    gridcoin_payout_txid: Option<String>,
}

#[derive(Deserialize)]
struct Snapshot {
    slot: i64,
    withdrawals: Vec<Withdrawal>,
}

pub fn watch(db: &mut Client, once: bool) -> Result<()> {
    loop {
        let (slot, count, changes) = scan(db)?;
        if once || changes > 0 {
            eprintln!(
                "Scanned finalized Solana slot {slot}; observed {count} withdrawals, {changes} new or changed."
            );
        }
        if once {
            return Ok(());
        }
        thread::sleep(Duration::from_secs(15));
    }
}

fn scan(db: &mut Client) -> Result<(i64, usize, usize)> {
    let mut transaction = db.transaction()?;
    // Keep overlapping scans from applying snapshots in the wrong order.
    transaction.query_one("SELECT pg_advisory_xact_lock(714032, 1)", &[])?;
    let checkpoint: Option<i64> = transaction
        .query_opt(
            "SELECT finalized_slot FROM wgrc.solana_withdrawal_checkpoint WHERE singleton",
            &[],
        )?
        .map(|row| row.get(0));
    let minimum_slot = checkpoint.unwrap_or_default();
    let snapshot: Snapshot = node("relayer/scan-solana.cjs", &[&minimum_slot.to_string()])?;
    let slot = snapshot.slot;
    if slot < minimum_slot {
        return Err("Solana snapshot predates the saved checkpoint.".into());
    }

    let mut previous: HashMap<String, Withdrawal> = transaction
        .query(
            "SELECT withdrawal_address, owner_address, nonce::text, amount_base_units::text,
                    gridcoin_address, status, gridcoin_payout_txid
             FROM wgrc.solana_withdrawals",
            &[],
        )?
        .into_iter()
        .map(|row| {
            let address: String = row.get(0);
            let withdrawal = Withdrawal {
                address: address.clone(),
                owner: row.get(1),
                nonce: row.get(2),
                amount_base_units: row.get(3),
                gridcoin_address: row.get(4),
                status: row.get(5),
                gridcoin_payout_txid: row.get(6),
            };
            (address, withdrawal)
        })
        .collect();

    let mut changes = 0;
    for request in &snapshot.withdrawals {
        match previous.remove(&request.address) {
            Some(old) if old == *request => continue,
            Some(old) => {
                if old.owner != request.owner
                    || old.nonce != request.nonce
                    || old.amount_base_units != request.amount_base_units
                    || old.gridcoin_address != request.gridcoin_address
                    || old.status != "pending"
                    || !matches!(request.status.as_str(), "settled" | "cancelled")
                {
                    return Err(format!("Unexpected change to withdrawal {}.", request.address).into());
                }
                transaction.execute(
                    "UPDATE wgrc.solana_withdrawals
                     SET status = $2, gridcoin_payout_txid = $3, last_changed_slot = $4
                     WHERE withdrawal_address = $1",
                    &[&request.address, &request.status, &request.gridcoin_payout_txid, &slot],
                )?;
            }
            None => {
                transaction.execute(
                    "INSERT INTO wgrc.solana_withdrawals
                        (withdrawal_address, owner_address, nonce, amount_base_units,
                         gridcoin_address, status, gridcoin_payout_txid,
                         first_observed_slot, last_changed_slot)
                     VALUES ($1, $2, $3::text::numeric, $4::text::numeric, $5, $6, $7, $8, $8)",
                    &[
                        &request.address,
                        &request.owner,
                        &request.nonce,
                        &request.amount_base_units,
                        &request.gridcoin_address,
                        &request.status,
                        &request.gridcoin_payout_txid,
                        &slot,
                    ],
                )?;
            }
        }
        changes += 1;
    }
    // This program retains escrow account records after resolution.
    if let Some(address) = previous.keys().next() {
        return Err(format!("Finalized snapshot is missing known withdrawal {address}.").into());
    }
    if checkpoint == Some(slot) && changes != 0 {
        return Err(format!("Withdrawal snapshot changed at finalized slot {slot}.").into());
    }
    transaction.execute(
        "INSERT INTO wgrc.solana_withdrawal_checkpoint AS checkpoint (singleton, finalized_slot)
         VALUES (true, $1) ON CONFLICT (singleton) DO UPDATE
         SET finalized_slot = excluded.finalized_slot
         WHERE checkpoint.finalized_slot < excluded.finalized_slot",
        &[&slot],
    )?;
    transaction.commit()?;
    Ok((slot, snapshot.withdrawals.len(), changes))
}
