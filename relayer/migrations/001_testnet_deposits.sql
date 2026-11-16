BEGIN;

-- Use the same schema in each environment's database.
CREATE SCHEMA wgrc;

CREATE TABLE wgrc.deposits (
    deposit_id text PRIMARY KEY CHECK (deposit_id ~ '^[0-9a-f]{64}$'),
    txid text NOT NULL UNIQUE CHECK (txid ~ '^[0-9a-f]{64}$'),
    vout bigint NOT NULL CHECK (vout BETWEEN 0 AND 4294967295),
    reserve_address text NOT NULL,
    recipient text NOT NULL,
    amount_base_units numeric(20, 0) NOT NULL
        CHECK (amount_base_units BETWEEN 1 AND 18446744073709551615),
    block_hash text NOT NULL CHECK (block_hash ~ '^[0-9a-f]{64}$'),
    confirmations bigint NOT NULL CHECK (confirmations > 0),
    first_seen_at timestamptz NOT NULL DEFAULT now(),
    receipt_address text UNIQUE,
    mint_signature text UNIQUE,
    finalized_at timestamptz,
    CHECK ((finalized_at IS NULL) = (receipt_address IS NULL)),
    CHECK (mint_signature IS NULL OR finalized_at IS NOT NULL)
);

COMMIT;
