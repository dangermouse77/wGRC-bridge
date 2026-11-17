BEGIN;

CREATE TABLE wgrc.solana_withdrawals (
    withdrawal_address text PRIMARY KEY,
    owner_address text NOT NULL,
    nonce numeric(20, 0) NOT NULL CHECK (nonce BETWEEN 0 AND 18446744073709551615),
    amount_base_units numeric(20, 0) NOT NULL
        CHECK (amount_base_units BETWEEN 1 AND 18446744073709551615),
    gridcoin_address text NOT NULL,
    status text NOT NULL CHECK (status IN ('pending', 'settled', 'cancelled')),
    gridcoin_payout_txid text CHECK (gridcoin_payout_txid ~ '^[0-9a-f]{64}$'),
    first_observed_slot bigint NOT NULL CHECK (first_observed_slot >= 0),
    last_changed_slot bigint NOT NULL CHECK (last_changed_slot >= first_observed_slot),
    CHECK ((status = 'settled') = (gridcoin_payout_txid IS NOT NULL)),
    UNIQUE (owner_address, nonce)
);

CREATE TABLE wgrc.solana_withdrawal_checkpoint (
    singleton boolean PRIMARY KEY DEFAULT true CHECK (singleton),
    finalized_slot bigint NOT NULL CHECK (finalized_slot >= 0)
);

COMMIT;
