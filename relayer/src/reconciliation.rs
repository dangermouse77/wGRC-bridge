use crate::{node_with_input, Result};
use postgres::Client;

pub fn payout_records(db: &mut Client, reserve: &str, minimum: &str) -> Result<()> {
    let minimum: u32 = minimum.parse()?;
    if minimum == 0 { return Err("Expected positive minimum confirmations.".into()); }
    let records: String = db.query_one(
        "SELECT COALESCE(json_agg(json_build_object(
             'withdrawalAddress', p.withdrawal_address, 'txid', p.txid,
             'amountBaseUnits', w.amount_base_units::text, 'gridcoinAddress', w.gridcoin_address
         )), '[]'::json)::text
         FROM wgrc.redemption_payouts p
         JOIN wgrc.solana_withdrawals w USING (withdrawal_address)
         WHERE p.reserve_address = $1 AND p.settled_at IS NULL", &[&reserve],
    )?.get(0);
    let records: serde_json::Value = serde_json::from_str(&records)?;
    println!("{}", serde_json::json!({ "minimumConfirmations": minimum, "payouts": records }));
    Ok(())
}

pub fn report(db: &mut Client, reserve: &str, minimum: &str, mint: &str) -> Result<()> {
    let payouts: String = db
        .query_one(
            "SELECT COALESCE(json_agg(json_build_object(
                 'withdrawalAddress', withdrawal_address,
                 'reserveAddress', reserve_address,
                 'txid', txid,
                 'blockHash', payout_block_hash
             )), '[]'::json)::text
             FROM wgrc.redemption_payouts",
            &[],
        )?
        .get(0);
    let report: serde_json::Value = node_with_input(
        "relayer/reconcile-reserve.cjs",
        &[reserve, minimum, mint],
        payouts.as_bytes(),
    )?;
    println!("{}", serde_json::to_string_pretty(&report)?);
    Ok(())
}
