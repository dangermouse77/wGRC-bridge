use crate::{node, process_deposit, Result};
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
    mint: Option<&str>,
    max_blocks: Option<u32>,
) -> Result<()> {
    loop {
        if scan_batch(max_blocks, || scan_next(db, reserve, minimum, start))? {
            eprintln!("Gridcoin scan batch limit reached; checkpoint saved. Remaining blocks will be scanned on the next batch.");
        }
        if let Some(mint) = mint {
            let failures = mint_discoveries(db, reserve, minimum, mint)?;
            if once && failures != 0 {
                return Err(format!("{failures} discovered deposits could not be minted or recovered.").into());
            }
        }
        if once {
            return Ok(());
        }
        thread::sleep(Duration::from_secs(15));
    }
}

// Count both scanned blocks and rewind steps so a reorg cannot monopolize a
// service cycle. scan_next commits each checkpoint before returning true.
fn scan_batch(limit: Option<u32>, mut next: impl FnMut() -> Result<bool>) -> Result<bool> {
    let mut steps = 0u32;
    loop {
        if limit.is_some_and(|limit| steps >= limit) { return Ok(true); }
        if !next()? { return Ok(false); }
        if limit.is_some() { steps += 1; }
    }
}

#[cfg(test)]
mod batch_tests {
    use super::*;

    #[test]
    fn bounds_catch_up_and_resumes_without_skipping() {
        let mut checkpoint = 100;
        for expected in [150, 200] {
            assert!(scan_batch(Some(50), || { checkpoint += 1; Ok(true) }).unwrap());
            assert_eq!(checkpoint, expected);
        }
    }

    #[test]
    fn stops_when_caught_up_and_preserves_unbounded_mode() {
        for limit in [None, Some(50)] {
            let mut calls = 0;
            assert!(!scan_batch(limit, || { calls += 1; Ok(calls <= 3) }).unwrap());
            assert_eq!(calls, 4);
        }
    }

    #[test]
    fn propagates_failure_without_treating_it_as_a_completed_batch() {
        assert!(scan_batch(Some(50), || Err("reorg requires reconciliation".into())).is_err());
    }
}

fn mint_discoveries(db: &mut Client, reserve: &str, minimum: &str, mint: &str) -> Result<usize> {
    let discoveries = db.query(
        "SELECT discovery.txid, discovery.deposit_id, block.block_hash
         FROM wgrc.gridcoin_deposit_discoveries AS discovery
         JOIN wgrc.gridcoin_blocks AS block
           ON block.reserve_address = discovery.reserve_address AND block.height = discovery.block_height
         LEFT JOIN wgrc.deposits AS mint ON mint.deposit_id = discovery.deposit_id
         WHERE discovery.reserve_address = $1 AND mint.finalized_at IS NULL
         ORDER BY discovery.block_height, discovery.txid",
        &[&reserve],
    )?;
    let mut failures = 0;
    for row in discoveries {
        let txid: &str = row.get(0);
        let deposit_id: &str = row.get(1);
        let block_hash: &str = row.get(2);
        if let Err(error) = process_deposit(db, reserve, minimum, txid, mint, Some((deposit_id, block_hash))) {
            failures += 1;
            eprintln!("Automatic mint for {txid} remains pending: {error}");
        }
    }
    Ok(failures)
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
