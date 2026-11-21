CREATE TABLE wgrc.reconciliation_acknowledgements (
    reserve_address text NOT NULL,
    mint_address text NOT NULL,
    issue text NOT NULL,
    reason text NOT NULL CHECK (length(trim(reason)) > 0),
    acknowledged_at timestamptz NOT NULL DEFAULT now(),
    acknowledged_by text NOT NULL DEFAULT current_user,
    report text NOT NULL,
    PRIMARY KEY (reserve_address, mint_address, issue)
);
