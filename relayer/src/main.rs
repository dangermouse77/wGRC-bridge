use native_tls::TlsConnector;
use postgres::{Client, Config};
use postgres_native_tls::MakeTlsConnector;
use serde::{de::DeserializeOwned, Deserialize, Serialize};
use std::{env, error::Error, fs, process::Command, time::Duration};

type Result<T> = std::result::Result<T, Box<dyn Error>>;

mod gridcoin_watcher;

const DEV_CONFIG: &str = "relayer/bridge.dev.json";
const LEGACY_DEV_CONFIG: &str = "relayer/database.dev.json";

#[derive(Default, Deserialize)]
struct BridgeSettings {
    gridcoin_deposit_address: Option<String>,
    wgrc_mint_address: Option<String>,
}

#[derive(Deserialize)]
struct DatabaseSettings {
    host: String,
    database: String,
    username: String,
    password: String,
}

fn database_config(bridge_config: Option<&[u8]>) -> Result<Config> {
    let mut config = match env::var("DATABASE_URL") {
        Ok(url) => url.parse::<Config>().map_err(|_| "Invalid DATABASE_URL")?,
        Err(env::VarError::NotPresent) => {
            let legacy;
            let (content, path) = match bridge_config {
                Some(content) => (content, DEV_CONFIG),
                None => {
                    legacy = fs::read(LEGACY_DEV_CONFIG).map_err(|error| {
                        format!("Cannot read {LEGACY_DEV_CONFIG}: {error}. Create {DEV_CONFIG} or set DATABASE_URL.")
                    })?;
                    (legacy.as_slice(), LEGACY_DEV_CONFIG)
                }
            };
            let settings: DatabaseSettings = serde_json::from_slice(content).map_err(|_| {
                format!("Invalid {path}. Expected host, database, username, and password.")
            })?;
            let mut config = Config::new();
            config
                .host(&settings.host)
                .dbname(&settings.database)
                .user(&settings.username)
                .password(settings.password.as_bytes());
            config
        }
        Err(error) => return Err(error.into()),
    };
    if matches!(
        config.get_dbname().or_else(|| config.get_user()),
        Some("wgrcbridge_prod" | "d_wgrcbridge_prod")
    ) {
        return Err("Use the development database for the Testnet-to-Devnet deposit pilot.".into());
    }
    config.connect_timeout(Duration::from_secs(10));
    Ok(config)
}

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
    let watch_start = match args.as_slice() {
        [command, txid]
            if command == "process-deposit"
                && txid.len() == 64
                && txid.bytes().all(|byte| byte.is_ascii_hexdigit()) => None,
        [command, height, flags @ ..]
            if command == "watch-gridcoin"
                && (flags.is_empty() || (flags.len() == 1 && flags[0] == "--once")) =>
        {
            let height: u32 = height.parse().map_err(|_| "Expected a nonnegative block height")?;
            Some((i64::from(height), !flags.is_empty()))
        }
        _ => return Err("Usage: wgrc-relayer process-deposit TXID | watch-gridcoin START_HEIGHT [--once]".into()),
    };
    let bridge_config = match fs::read(DEV_CONFIG) {
        Ok(content) => Some(content),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => None,
        Err(error) => return Err(format!("Cannot read {DEV_CONFIG}: {error}").into()),
    };
    let settings: BridgeSettings = match bridge_config.as_deref() {
        Some(content) => serde_json::from_slice(content)
            .map_err(|_| format!("Invalid bridge settings in {DEV_CONFIG}."))?,
        None => BridgeSettings::default(),
    };
    let defaults: BridgeSettings = serde_json::from_str(include_str!("../bridge.dev.example.json"))?;
    let reserve = env::var("WGRC_TESTNET_RESERVE_ADDRESS")
        .ok()
        .filter(|address| !address.is_empty())
        .or_else(|| env::var("GRC_RESERVE_ADDRESS").ok().filter(|address| !address.is_empty()))
        .or(settings.gridcoin_deposit_address)
        .or(defaults.gridcoin_deposit_address)
        .ok_or("Missing Gridcoin deposit address")?;
    let minimum = env::var("WGRC_MIN_CONFIRMATIONS")
        .unwrap_or_else(|_| include_str!("../gridcoin-min-confirmations.txt").trim().into());
    let mut db = database_config(bridge_config.as_deref())?
        .connect(MakeTlsConnector::new(TlsConnector::new()?))?;
    if let Some((height, once)) = watch_start {
        return gridcoin_watcher::watch(&mut db, &reserve, &minimum, height, once);
    }
    let mint = settings.wgrc_mint_address.or(defaults.wgrc_mint_address)
        .ok_or("Missing wGRC mint address")?;
    process_deposit(&mut db, &reserve, &minimum, &args[1], &mint)
}

fn process_deposit(db: &mut Client, reserve: &str, minimum: &str, txid: &str, mint: &str) -> Result<()> {
    let deposit: Deposit = node(
        "scripts/gridcoin-deposit.cjs",
        &["check", reserve, txid, minimum],
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
        &[mode, reserve, minimum, &serde_json::to_string(&deposit)?, mint],
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
