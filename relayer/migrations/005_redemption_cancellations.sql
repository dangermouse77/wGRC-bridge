BEGIN;
-- Durable intent survives an uncertain Solana submission or worker timeout.
-- All relayer decisions use the same advisory lock as payout preparation.
CREATE TABLE wgrc.redemption_cancellations (
    withdrawal_address text PRIMARY KEY REFERENCES wgrc.solana_withdrawals,
    requested_at timestamptz NOT NULL DEFAULT now(),
    finalized_at timestamptz,
    signature text
);
COMMIT;
