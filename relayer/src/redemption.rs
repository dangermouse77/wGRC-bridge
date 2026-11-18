use crate::{node, Result};
use postgres::Client;
use serde::{Deserialize, Serialize};
use std::env;

#[derive(Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
struct Payout {
    txid: String,
    signed_hex: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct Request<'a> {
    address: &'a str,
    owner: String,
    nonce: String,
    amount_base_units: String,
    gridcoin_address: String,
    mint: &'a str,
    fee_base_units: Option<String>,
    payout: Option<Payout>,
    payout_block_hash: Option<String>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct Progress {
    txid: String,
    confirmations: i64,
    block_hash: Option<String>,
    signature: Option<String>,
}

pub fn process(
    db: &mut Client,
    reserve: &str,
    minimum: &str,
    mint: &str,
    address: &str,
) -> Result<()> {
    let mut transaction = db.transaction()?;
    transaction.query_one("SELECT pg_advisory_xact_lock(714033, 1)", &[])?;
    let row = transaction.query_opt(
        "SELECT w.owner_address, w.nonce::text, w.amount_base_units::text, w.gridcoin_address,
                w.status, p.reserve_address, p.txid, p.signed_hex
         FROM wgrc.solana_withdrawals AS w
         LEFT JOIN wgrc.redemption_payouts AS p USING (withdrawal_address)
         WHERE w.withdrawal_address = $1",
        &[&address],
    )?.ok_or("Withdrawal has not been discovered. Run watch-solana --once first.")?;
    let mut request = Request {
        address,
        owner: row.get(0),
        nonce: row.get(1),
        amount_base_units: row.get(2),
        gridcoin_address: row.get(3),
        mint,
        fee_base_units: None,
        payout: None,
        payout_block_hash: None,
    };

    match row.get::<_, Option<String>>(5) {
        Some(saved_reserve) => {
            if saved_reserve != reserve {
                return Err("This payout was prepared with a different reserve address.".into());
            }
            request.payout = Some(Payout { txid: row.get(6), signed_hex: row.get(7) });
        }
        None => {
            if row.get::<_, &str>(4) != "pending" {
                return Err("Only pending escrow withdrawals can start a payout.".into());
            }
            if let Some(open) = transaction.query_opt(
                "SELECT withdrawal_address FROM wgrc.redemption_payouts
                 WHERE reserve_address = $1 AND settled_at IS NULL",
                &[&reserve],
            )? {
                return Err(format!("Resume unfinished payout for {} first.", open.get::<_, &str>(0)).into());
            }
            let fee: u64 = env::var("WGRC_PAYOUT_FEE_BASE_UNITS")
                .unwrap_or_else(|_| "100000".into())
                .parse()
                .map_err(|_| "Expected WGRC_PAYOUT_FEE_BASE_UNITS to be a positive integer.")?;
            if fee == 0 {
                return Err("Payout fee must be positive.".into());
            }
            let fee = fee.to_string();
            request.fee_base_units = Some(fee.clone());
            let payout: Payout = node(
                "relayer/redeem-devnet.cjs",
                &["prepare", reserve, minimum, &serde_json::to_string(&request)?],
            )?;
            transaction.execute(
                "INSERT INTO wgrc.redemption_payouts
                    (withdrawal_address, reserve_address, txid, signed_hex, fee_base_units)
                 VALUES ($1, $2, $3, $4, $5::text::numeric)",
                &[&address, &reserve, &payout.txid, &payout.signed_hex, &fee],
            )?;
            request.payout = Some(payout);
        }
    }
    // The signed payout must survive an interrupted broadcast or Solana submission.
    transaction.commit()?;

    let mut transaction = db.transaction()?;
    transaction.query_one("SELECT pg_advisory_xact_lock(714033, 1)", &[])?;
    let row = transaction.query_one(
        "SELECT payout_block_hash, settlement_signature
         FROM wgrc.redemption_payouts WHERE withdrawal_address = $1",
        &[&address],
    )?;
    request.payout_block_hash = row.get(0);
    let mut signature: Option<String> = row.get(1);
    let progress: Progress = node(
        "relayer/redeem-devnet.cjs",
        &["advance", reserve, minimum, &serde_json::to_string(&request)?],
    )?;
    let status = if let Some(block_hash) = &progress.block_hash {
        signature = signature.or(progress.signature);
        transaction.execute(
            "UPDATE wgrc.redemption_payouts
             SET payout_block_hash = $2, settlement_signature = $3,
                 settled_at = COALESCE(settled_at, now())
             WHERE withdrawal_address = $1",
            &[&address, &block_hash, &signature],
        )?;
        "settled"
    } else {
        "awaiting_confirmations"
    };
    transaction.commit()?;
    println!("{}", serde_json::json!({
        "withdrawalAddress": address,
        "txid": progress.txid,
        "confirmations": progress.confirmations,
        "status": status,
        "settlementSignature": signature
    }));
    Ok(())
}
