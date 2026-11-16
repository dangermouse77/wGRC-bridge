BEGIN;

CREATE TABLE wgrc.gridcoin_blocks (
    reserve_address text NOT NULL,
    height bigint NOT NULL CHECK (height >= 0),
    block_hash text NOT NULL CHECK (block_hash ~ '^[0-9a-f]{64}$'),
    scanned_at timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (reserve_address, height)
);

CREATE TABLE wgrc.gridcoin_deposit_discoveries (
    reserve_address text NOT NULL,
    block_height bigint NOT NULL,
    deposit_id text NOT NULL CHECK (deposit_id ~ '^[0-9a-f]{64}$'),
    txid text NOT NULL CHECK (txid ~ '^[0-9a-f]{64}$'),
    vout bigint NOT NULL CHECK (vout BETWEEN 0 AND 4294967295),
    recipient text NOT NULL,
    amount_base_units numeric(20, 0) NOT NULL
        CHECK (amount_base_units BETWEEN 1 AND 18446744073709551615),
    confirmations_at_scan bigint NOT NULL CHECK (confirmations_at_scan > 0),
    PRIMARY KEY (reserve_address, deposit_id),
    FOREIGN KEY (reserve_address, block_height)
        REFERENCES wgrc.gridcoin_blocks (reserve_address, height) ON DELETE CASCADE
);

CREATE INDEX gridcoin_deposit_discoveries_block_idx
    ON wgrc.gridcoin_deposit_discoveries (reserve_address, block_height);

COMMIT;
