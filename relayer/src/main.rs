use native_tls::TlsConnector;
use postgres::{Client, Config};
use postgres_native_tls::MakeTlsConnector;
use serde::{de::DeserializeOwned, Deserialize, Serialize};
use std::{
    env, error::Error, fs, io::Write,
    process::{Command, Output, Stdio},
    time::Duration,
};

type Result<T> = std::result::Result<T, Box<dyn Error>>;

mod gridcoin_watcher;
mod reconciliation;
mod redemption;
mod solana_watcher;

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
    port: Option<u16>,
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
                format!("Invalid {path}. Expected host, database, username, password, and an optional numeric port.")
            })?;
            let mut config = Config::new();
            config
                .host(&settings.host)
                .port(settings.port.unwrap_or(5432))
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
    node_output(script, node_command(script, args).output()?)
}

fn node_command(script: &str, args: &[&str]) -> Command {
    let mut command = Command::new("node");
    command.arg("relayer/worker.cjs").arg(script).args(args).env_remove("DATABASE_URL");
    command
}

fn node_with_input<T: DeserializeOwned>(script: &str, args: &[&str], input: &[u8]) -> Result<T> {
    let mut child = node_command(script, args)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()?;
    let written = child.stdin.take().expect("stdin was piped").write_all(input);
    let output = child.wait_with_output()?;
    let result = node_output(script, output)?;
    written?;
    Ok(result)
}

fn node_output<T: DeserializeOwned>(script: &str, output: Output) -> Result<T> {
    if !output.status.success() {
        return Err(format!("{script}: {}", String::from_utf8_lossy(&output.stderr).trim()).into());
    }
    Ok(serde_json::from_slice(&output.stdout)?)
}

enum Action<'a> {
    ProcessDeposit(&'a str),
    ProcessRedemption(&'a str),
    CancelRedemption(&'a str),
    ProcessRedemptions,
    RecoverCancellations,
    RecoverRedemptions { once: bool },
    ReconcileReserve { acknowledgement: Option<(String, String)> },
    PayoutRecords,
    WatchGridcoin { height: Option<i64>, once: bool, mint: bool, max_blocks: Option<u32> },
    WatchSolana { once: bool },
}

fn run() -> Result<()> {
    let args: Vec<_> = env::args().skip(1).collect();
    let action = match args.as_slice() {
        [command, txid]
            if command == "process-deposit"
                && txid.len() == 64
                && txid.bytes().all(|byte| byte.is_ascii_hexdigit()) => Action::ProcessDeposit(txid),
        [command, address] if command == "process-redemption" => Action::ProcessRedemption(address),
        [command, address] if command == "cancel-redemption" => Action::CancelRedemption(address),
        [command] if command == "process-redemptions" => Action::ProcessRedemptions,
        [command] if command == "recover-cancellations" => Action::RecoverCancellations,
        [command, flag, withdrawal, reason_flag, reason] if command == "reconcile-reserve" && flag == "--acknowledge" && reason_flag == "--reason" => Action::ReconcileReserve { acknowledgement: Some((withdrawal.clone(), reason.clone())) },
        [command] if command == "reconcile-reserve" => Action::ReconcileReserve { acknowledgement: None },
        [command] if command == "payout-records" => Action::PayoutRecords,
        [command, flags @ ..]
            if command == "recover-redemptions"
                && (flags.is_empty() || (flags.len() == 1 && flags[0] == "--once")) =>
        {
            Action::RecoverRedemptions { once: !flags.is_empty() }
        }
        [command, height, flags @ ..] if command == "watch-gridcoin" => {
            let height = if height == "auto" { None } else {
                Some(i64::from(height.parse::<u32>().map_err(|_| "Expected a nonnegative block height or auto")?))
            };
            let mut once = false;
            let mut mint = false;
            let mut max_blocks = None;
            let mut flags = flags.iter();
            while let Some(flag) = flags.next() {
                match flag.as_str() {
                    "--once" if !once => once = true,
                    "--mint" if !mint => mint = true,
                    "--max-blocks" if max_blocks.is_none() => {
                        let limit: u32 = flags.next().ok_or("Missing --max-blocks value")?
                            .parse().map_err(|_| "Expected --max-blocks between 1 and 10000")?;
                        if !(1..=10000).contains(&limit) {
                            return Err("Expected --max-blocks between 1 and 10000".into());
                        }
                        max_blocks = Some(limit);
                    }
                    _ => return Err(format!("Unexpected watch-gridcoin option: {flag}").into()),
                }
            }
            Action::WatchGridcoin { height, once, mint, max_blocks }
        }
        [command, flags @ ..]
            if command == "watch-solana"
                && (flags.is_empty() || (flags.len() == 1 && flags[0] == "--once")) =>
        {
            Action::WatchSolana { once: !flags.is_empty() }
        }
        _ => return Err("Usage: wgrc-relayer process-deposit TXID | process-redemption WITHDRAWAL_ADDRESS | cancel-redemption WITHDRAWAL_ADDRESS | process-redemptions | recover-cancellations | recover-redemptions [--once] | reconcile-reserve | watch-gridcoin START_HEIGHT [--once] [--mint] [--max-blocks N] | watch-solana [--once]".into()),
    };
    let bridge_config = match fs::read(DEV_CONFIG) {
        Ok(content) => Some(content),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => None,
        Err(error) => return Err(format!("Cannot read {DEV_CONFIG}: {error}").into()),
    };
    let config = database_config(bridge_config.as_deref())?;
    let connect = || -> Result<Client> {
        let mut db = config.connect(MakeTlsConnector::new(TlsConnector::new()?))?;
        db.batch_execute("SET lock_timeout = '15s'; SET statement_timeout = '30s'")?;
        Ok(db)
    };
    if let Action::WatchSolana { once } = action {
        return solana_watcher::watch(&mut connect()?, once);
    }
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
    match action {
        Action::PayoutRecords => reconciliation::payout_records(&mut connect()?, &reserve, &minimum),
        Action::WatchGridcoin { height, once, mint, max_blocks } => {
            let mint_address = settings.wgrc_mint_address.or(defaults.wgrc_mint_address);
            let automatic_mint = if mint {
                Some(mint_address.as_deref().ok_or("Missing wGRC mint address")?)
            } else {
                None
            };
            gridcoin_watcher::watch(&mut connect()?, &reserve, &minimum, height, once, automatic_mint, max_blocks)
        }
        Action::ProcessDeposit(txid) => {
            let mint = settings.wgrc_mint_address.or(defaults.wgrc_mint_address)
                .ok_or("Missing wGRC mint address")?;
            process_deposit(&mut connect()?, &reserve, &minimum, txid, &mint, None)
        }
        Action::ProcessRedemption(address) => {
            let mint = settings.wgrc_mint_address.or(defaults.wgrc_mint_address)
                .ok_or("Missing wGRC mint address")?;
            redemption::process(&mut connect()?, &reserve, &minimum, &mint, address)
        }
        Action::CancelRedemption(address) => {
            let mint = settings.wgrc_mint_address.or(defaults.wgrc_mint_address)
                .ok_or("Missing wGRC mint address")?;
            redemption::cancel(&mut connect()?, &reserve, &minimum, &mint, address)
        }
        Action::ProcessRedemptions | Action::RecoverCancellations => {
            let mint = settings.wgrc_mint_address.or(defaults.wgrc_mint_address)
                .ok_or("Missing wGRC mint address")?;
            if matches!(action, Action::ProcessRedemptions) {
                redemption::process_queue(&mut connect()?, &reserve, &minimum, &mint)
            } else {
                redemption::recover_cancellations(&mut connect()?, &reserve, &minimum, &mint)
            }
        }
        Action::RecoverRedemptions { once } => {
            let mint = settings.wgrc_mint_address.or(defaults.wgrc_mint_address)
                .ok_or("Missing wGRC mint address")?;
            redemption::recover(connect, &reserve, &minimum, &mint, once)
        }
        Action::ReconcileReserve { acknowledgement } => {
            let mint = settings.wgrc_mint_address.or(defaults.wgrc_mint_address)
                .ok_or("Missing wGRC mint address")?;
            reconciliation::report(&mut connect()?, &reserve, &minimum, &mint, acknowledgement)
        }
        Action::WatchSolana { .. } => unreachable!("Solana watcher handled above"),
    }
}

fn process_deposit(
    db: &mut Client,
    reserve: &str,
    minimum: &str,
    txid: &str,
    mint: &str,
    discovery: Option<(&str, &str)>,
) -> Result<()> {
    let deposit: Deposit = node(
        "scripts/gridcoin-deposit.cjs",
        &["check", reserve, txid, minimum],
    )?;
    if let Some((deposit_id, block_hash)) = discovery {
        if deposit.deposit_id != deposit_id || deposit.blockhash != block_hash {
            return Err("Gridcoin deposit differs from its saved discovery. Wait for the watcher to recheck the chain.".into());
        }
    }
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
    let backing_check = if discovery.is_some() { "unspent" } else { "confirmed" };
    let mint: Mint = node(
        "relayer/mint-devnet.cjs",
        &[mode, reserve, minimum, &serde_json::to_string(&deposit)?, mint, backing_check],
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
