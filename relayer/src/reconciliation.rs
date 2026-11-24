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
    let cancellations: Vec<String> = db.query(
        "SELECT withdrawal_address FROM wgrc.redemption_cancellations", &[]
    )?.iter().map(|row| row.get(0)).collect();
    println!("{}", serde_json::json!({ "minimumConfirmations": minimum, "payouts": records, "cancellations": cancellations }));
    Ok(())
}

pub fn report(db: &mut Client, reserve: &str, minimum: &str, mint: &str, acknowledgement: Option<(String, String)>) -> Result<()> {
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
    let mut report: serde_json::Value = node_with_input(
        "relayer/reconcile-reserve.cjs",
        &[reserve, minimum, mint],
        payouts.as_bytes(),
    )?;
    if let Some((withdrawal, reason)) = acknowledgement {
        if reason.trim().is_empty() { return Err("An acknowledgement reason is required.".into()); }
        if report["backingShortfallBaseUnits"] != "0" || report["spendableShortfallBaseUnits"] != "0" {
            return Err("Cannot acknowledge while reserve backing or liquidity is insufficient.".into());
        }
        let issue = report["issues"].as_array().ok_or("Missing issues")?.iter()
            .find(|issue| issue["withdrawal"].as_str() == Some(withdrawal.as_str()))
            .ok_or("No current issue for this withdrawal.")?;
        let reason_code = issue["reason"].as_str().unwrap_or("");
        if reason_code != "Settlement has no matching relayer payout record."
            && reason_code != "Legacy burn-first withdrawal requires payout reconciliation." {
            return Err("This issue requires repair rather than acknowledgement.".into());
        }
        db.execute("INSERT INTO wgrc.reconciliation_acknowledgements (reserve_address,mint_address,issue,reason,report) VALUES ($1,$2,$3,$4,$5) ON CONFLICT DO NOTHING",
            &[&reserve,&mint,&issue.to_string(),&reason,&report.to_string()])?;
    }
    let acknowledged: Vec<String> = db.query("SELECT issue FROM wgrc.reconciliation_acknowledgements WHERE reserve_address=$1 AND mint_address=$2", &[&reserve,&mint])?
        .iter().map(|row| row.get(0)).collect();
    let issues = report["issues"].as_array_mut().ok_or("Missing issues")?;
    let before = issues.len();
    issues.retain(|issue| !acknowledged.contains(&issue.to_string()));
    let count = before - issues.len();
    let empty = issues.is_empty();
    report["acknowledgedIssueCount"] = count.into();
    report["status"] = if report["backingShortfallBaseUnits"] != "0" { "shortfall" }
        else if report["spendableShortfallBaseUnits"] != "0" { "liquidity_shortfall" }
        else if !empty { "review_required" }
        else if count > 0 { "reconciled" } else { "covered" }.into();
    println!("{}", serde_json::to_string_pretty(&report)?);
    Ok(())
}
