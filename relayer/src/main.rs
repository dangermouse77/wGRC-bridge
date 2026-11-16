use native_tls::TlsConnector;
use postgres::Config;
use postgres_native_tls::MakeTlsConnector;
use serde::{de::DeserializeOwned, Deserialize, Serialize};
use std::{env, error::Error, process::Command, time::Duration};

type Result<T> = std::result::Result<T, Box<dyn Error>>;

#[derive(Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
struct Deposit {
    txid: String,
    vout: u32,
    deposit_id: String,
    recipient: String,
    amount_base_units: String,
    blockhash: String,
    confirmations: i64,
}

#[derive(Deserialize, Serialize)]
struct Mint {
    receipt: String,
    signature: Option<String>,
}

fn node<T: DeserializeOwned>(script: &str, args: &[&str]) -> Result<T> {
    let output = Command::new("node")
        .arg(script)
        .args(args)
        .env_remove("DATABASE_URL")
        .output()?;
    if !output.status.success() {
        return Err(format!("{script}: {}", String::from_utf8_lossy(&output.stderr).trim()).into());
    }
    Ok(serde_json::from_slice(&output.stdout)?)
}

fn run() -> Result<()> {
    let args: Vec<_> = env::args().skip(1).collect();
    let [command, txid] = args.as_slice() else {
        return Err("Usage: wgrc-relayer process-deposit TXID (run from the repository root)".into());
    };
    if command != "process-deposit"
        || txid.len() != 64
        || !txid.bytes().all(|byte| byte.is_ascii_hexdigit())
    {
        return Err("Expected process-deposit and a 64-character Gridcoin transaction ID".into());
    }
    let reserve = env::var("WGRC_TESTNET_RESERVE_ADDRESS")?;
    let minimum = env::var("WGRC_MIN_CONFIRMATIONS").unwrap_or_else(|_| "6".into());
    let mut config: Config = env::var("DATABASE_URL")?
        .parse()
        .map_err(|_| "Invalid DATABASE_URL")?;
    config.connect_timeout(Duration::from_secs(10));
    let mut db = config.connect(MakeTlsConnector::new(TlsConnector::new()?))?;

    let deposit: Deposit = node(
        "scripts/gridcoin-deposit.cjs",
        &["check", &reserve, txid, &minimum],
    )?;
    let vout = i64::from(deposit.vout);
    // Commit the original block before touching Solana. A pending row may
    // already have an on-chain mint if the previous run lost its RPC response.
    let matched = db.execute(
        "INSERT INTO wgrc.deposits AS d
            (deposit_id, txid, vout, reserve_address, recipient, amount_base_units,
             block_hash, confirmations)
         VALUES ($1, $2, $3, $4, $5, $6::text::numeric, $7, $8)
         ON CONFLICT (deposit_id) DO UPDATE SET
            confirmations = CASE WHEN d.finalized_at IS NULL THEN excluded.confirmations ELSE d.confirmations END
         WHERE (d.txid, d.vout, d.reserve_address, d.recipient, d.amount_base_units, d.block_hash)
             = (excluded.txid, excluded.vout, excluded.reserve_address, excluded.recipient,
                excluded.amount_base_units, excluded.block_hash)",
        &[&deposit.deposit_id, &deposit.txid, &vout, &reserve, &deposit.recipient,
          &deposit.amount_base_units, &deposit.blockhash, &deposit.confirmations],
    )?;
    if matched == 0 {
        return Err("Stored deposit or block differs from Gridcoin validation. Reconcile before retrying.".into());
    }

    let mut transaction = db.transaction()?;
    let locked = transaction.query_one(
        "SELECT block_hash, finalized_at IS NOT NULL FROM wgrc.deposits WHERE deposit_id = $1 FOR UPDATE",
        &[&deposit.deposit_id],
    )?;
    if locked.get::<_, String>(0) != deposit.blockhash {
        return Err("Deposit block changed during processing. Revalidate before retrying.".into());
    }
    let mode = if locked.get::<_, bool>(1) { "verify" } else { "mint" };
    let mint: Mint = node(
        "relayer/mint-devnet.cjs",
        &[mode, &reserve, &minimum, &serde_json::to_string(&deposit)?],
    )?;
    let result = transaction.query_opt(
        "UPDATE wgrc.deposits
         SET receipt_address = $2, mint_signature = COALESCE(mint_signature, $3),
             finalized_at = COALESCE(finalized_at, now())
         WHERE deposit_id = $1 AND (receipt_address IS NULL OR receipt_address = $2)
         RETURNING mint_signature",
        &[&deposit.deposit_id, &mint.receipt, &mint.signature],
    )?.ok_or("Stored receipt conflicts with the finalized Solana receipt")?;
    let signature: Option<String> = result.get(0);
    transaction.commit()?;
    println!("{}", serde_json::json!({
        "depositId": deposit.deposit_id,
        "receipt": mint.receipt,
        "signature": signature
    }));
    Ok(())
}

fn main() {
    if let Err(error) = run() {
        eprintln!("Relayer: {error}");
        std::process::exit(1);
    }
}
