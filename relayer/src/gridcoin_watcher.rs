use crate::{node, Result};
use postgres::Client;
use serde::Deserialize;
use std::{thread, time::Duration};

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct Discovery {
    deposit_id: String,
    txid: String,
    vout: u32,
    recipient: String,
    amount_base_units: String,
}

#[derive(Deserialize)]
#[serde(tag = "status", rename_all = "lowercase")]
enum Scan {
    Waiting,
    Reorg,
    Block {
        hash: String,
        confirmations: i64,
        deposits: Vec<Discovery>,
    },
}

pub fn watch(
    db: &mut Client,
    reserve: &str,
    minimum: &str,
    start: i64,
    once: bool,
) -> Result<()> {
    loop {
        if scan_next(db, reserve, minimum, start)? {
            continue;
        }
        if once {
            return Ok(());
        }
        thread::sleep(Duration::from_secs(15));
    }
}

fn scan_next(db: &mut Client, reserve: &str, minimum: &str, start: i64) -> Result<bool> {
    let mut transaction = db.transaction()?;
    // Serialize watcher updates for the same reserve, including its first block.
    transaction.query_one(
        "SELECT pg_advisory_xact_lock(714031, hashtext($1))",
        &[&reserve],
    )?;
    let first: Option<i64> = transaction
        .query_one(
            "SELECT min(height) FROM wgrc.gridcoin_blocks WHERE reserve_address = $1",
            &[&reserve],
        )?
        .get(0);
    if let Some(first) = first {
        if first != start {
            return Err(format!("Watcher already started at height {first} for this reserve.").into());
        }
    }
    let cursor = transaction.query_opt(
        "SELECT height, block_hash FROM wgrc.gridcoin_blocks
         WHERE reserve_address = $1 ORDER BY height DESC LIMIT 1",
        &[&reserve],
    )?;
    let (height, previous_hash) = match cursor {
        Some(row) => (row.get::<_, i64>(0) + 1, row.get::<_, String>(1)),
        None => (start, String::new()),
    };
    let scan: Scan = node(
        "relayer/scan-gridcoin.cjs",
        &[reserve, &height.to_string(), minimum, &previous_hash],
    )?;

    match scan {
        Scan::Waiting => {
            transaction.commit()?;
            return Ok(false);
        }
        Scan::Reorg => {
            let orphan_height = height - 1;
            let has_mint_record: bool = transaction
                .query_one(
                    "SELECT EXISTS (
                         SELECT 1 FROM wgrc.deposits
                         WHERE reserve_address = $1 AND block_hash = $2
                     )",
                    &[&reserve, &previous_hash],
                )?
                .get(0);
            if has_mint_record {
                return Err(format!(
                    "Gridcoin reorg at height {orphan_height} ({previous_hash}) affects a mint record. Reconcile before restarting."
                )
                .into());
            }
            transaction.execute(
                "DELETE FROM wgrc.gridcoin_blocks WHERE reserve_address = $1 AND height = $2",
                &[&reserve, &orphan_height],
            )?;
            transaction.commit()?;
            eprintln!("Rewound orphaned Gridcoin block {orphan_height} ({previous_hash}).");
        }
        Scan::Block {
            hash,
            confirmations,
            deposits,
        } => {
            transaction.execute(
                "INSERT INTO wgrc.gridcoin_blocks (reserve_address, height, block_hash)
                 VALUES ($1, $2, $3)",
                &[&reserve, &height, &hash],
            )?;
            for deposit in &deposits {
                transaction.execute(
                    "INSERT INTO wgrc.gridcoin_deposit_discoveries
                        (reserve_address, block_height, deposit_id, txid, vout, recipient,
                         amount_base_units, confirmations_at_scan)
                     VALUES ($1, $2, $3, $4, $5, $6, $7::text::numeric, $8)",
                    &[
                        &reserve,
                        &height,
                        &deposit.deposit_id,
                        &deposit.txid,
                        &i64::from(deposit.vout),
                        &deposit.recipient,
                        &deposit.amount_base_units,
                        &confirmations,
                    ],
                )?;
            }
            transaction.commit()?;
            eprintln!(
                "Scanned Gridcoin block {height} ({hash}); found {} deposits.",
                deposits.len()
            );
        }
    }
    Ok(true)
}
