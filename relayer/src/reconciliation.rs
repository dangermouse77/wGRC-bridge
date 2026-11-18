use crate::{node_with_input, Result};
use postgres::Client;

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
