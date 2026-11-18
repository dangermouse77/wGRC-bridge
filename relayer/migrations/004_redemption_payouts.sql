BEGIN;

CREATE TABLE wgrc.redemption_payouts (
    withdrawal_address text PRIMARY KEY REFERENCES wgrc.solana_withdrawals,
    reserve_address text NOT NULL,
    txid text NOT NULL UNIQUE CHECK (txid ~ '^[0-9a-f]{64}$'),
    signed_hex text NOT NULL CHECK (signed_hex ~ '^([0-9a-f]{2})+$'),
    fee_base_units numeric(20, 0) NOT NULL CHECK (fee_base_units > 0),
    prepared_at timestamptz NOT NULL DEFAULT now(),
    payout_block_hash text CHECK (payout_block_hash ~ '^[0-9a-f]{64}$'),
    settlement_signature text,
    settled_at timestamptz,
    CHECK ((settled_at IS NULL) = (payout_block_hash IS NULL)),
    CHECK (settlement_signature IS NULL OR settled_at IS NOT NULL)
);

CREATE UNIQUE INDEX redemption_one_open_payout_per_reserve
    ON wgrc.redemption_payouts (reserve_address) WHERE settled_at IS NULL;

COMMIT;
