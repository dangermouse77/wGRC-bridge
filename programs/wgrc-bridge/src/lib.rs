use anchor_lang::prelude::*;
use anchor_spl::metadata::{
    self, mpl_token_metadata::types::DataV2, CreateMetadataAccountsV3, Metadata,
};
use anchor_spl::token::{self, Burn, Mint, MintTo, Token, TokenAccount, Transfer};

// Replace this development address with the deployment keypair's public key.
declare_id!("AvqkRykFXfx31fDYnJq7kPkNpgiMA6LbknavHMvjz3Zy");

const WGRC_DECIMALS: u8 = 8;
const INITIAL_MAX_SUPPLY: u64 = 2_000_000 * 100_000_000;
const MAX_GRIDCOIN_ADDRESS_LEN: usize = 35;

#[program]
pub mod wgrc_bridge {
    use super::*;

    pub fn initialize(ctx: Context<Initialize>, mint_operator: Pubkey) -> Result<()> {
        require!(mint_operator != Pubkey::default(), BridgeError::InvalidAuthority);
        ctx.accounts.bridge.set_inner(Bridge {
            admin: ctx.accounts.upgrade_authority.key(),
            mint_operator,
            paused: false,
        });
        Ok(())
    }

    /// Amounts are in base units. The operator verifies the Gridcoin deposit off-chain.
    pub fn mint_deposit(
        ctx: Context<MintDeposit>,
        deposit_id: [u8; 32],
        amount: u64,
    ) -> Result<()> {
        require!(amount > 0, BridgeError::ZeroAmount);
        let next_supply = ctx.accounts.mint.supply.checked_add(amount)
            .ok_or(BridgeError::SupplyCapExceeded)?;
        require!(next_supply <= ctx.accounts.supply_limit.max_supply, BridgeError::SupplyCapExceeded);

        let mint_seeds: &[&[u8]] = &[b"mint", &[ctx.bumps.mint]];
        token::mint_to(
            CpiContext::new(
                ctx.accounts.token_program.key(),
                MintTo {
                    mint: ctx.accounts.mint.to_account_info(),
                    to: ctx.accounts.recipient_tokens.to_account_info(),
                    authority: ctx.accounts.mint.to_account_info(),
                },
            )
            .with_signer(&[mint_seeds]),
            amount,
        )?;

        ctx.accounts.deposit_receipt.set_inner(DepositReceipt {
            deposit_id,
            recipient: ctx.accounts.recipient.key(),
            amount,
        });
        Ok(())
    }

    /// The client reuses the same nonce when retrying a withdrawal.
    pub fn request_withdrawal(
        ctx: Context<RequestWithdrawal>,
        nonce: u64,
        amount: u64,
        gridcoin_address: String,
    ) -> Result<()> {
        require!(amount > 0, BridgeError::ZeroAmount);
        require!(
            gridcoin_address.len() <= MAX_GRIDCOIN_ADDRESS_LEN,
            BridgeError::InvalidGridcoinAddress
        );
        // Validate the Base58Check encoding. The client and relayer check the network
        // and address type against Gridcoin Core.
        let mut address_payload = [0u8; 25];
        let payload_len = bs58::decode(&gridcoin_address)
            .with_check(None)
            .onto(&mut address_payload[..])
            .map_err(|_| error!(BridgeError::InvalidGridcoinAddress))?;
        require!(payload_len == 21, BridgeError::InvalidGridcoinAddress);

        token::transfer(
            CpiContext::new(
                ctx.accounts.token_program.key(),
                Transfer {
                    from: ctx.accounts.owner_tokens.to_account_info(),
                    to: ctx.accounts.vault.to_account_info(),
                    authority: ctx.accounts.owner.to_account_info(),
                },
            ),
            amount,
        )?;

        ctx.accounts.withdrawal.set_inner(EscrowWithdrawal {
            owner: ctx.accounts.owner.key(),
            nonce,
            amount,
            gridcoin_address,
            status: WithdrawalStatus::Pending,
        });
        Ok(())
    }

    /// The operator attests that the Gridcoin payout has reached the required confirmations.
    pub fn settle_withdrawal(ctx: Context<ResolveWithdrawal>, gridcoin_txid: [u8; 32]) -> Result<()> {
        require!(gridcoin_txid != [0; 32], BridgeError::InvalidPayoutTxid);
        let withdrawal = &ctx.accounts.withdrawal;
        let nonce = withdrawal.nonce.to_le_bytes();
        let seeds: &[&[u8]] = &[
            b"withdrawal",
            withdrawal.owner.as_ref(),
            &nonce,
            &[ctx.bumps.withdrawal],
        ];
        token::burn(
            CpiContext::new(
                ctx.accounts.token_program.key(),
                Burn {
                    mint: ctx.accounts.mint.to_account_info(),
                    from: ctx.accounts.vault.to_account_info(),
                    authority: withdrawal.to_account_info(),
                },
            )
            .with_signer(&[seeds]),
            withdrawal.amount,
        )?;
        ctx.accounts.withdrawal.status = WithdrawalStatus::Settled { gridcoin_txid };
        Ok(())
    }

    /// The operator must establish that no payout has occurred or can still settle.
    pub fn cancel_withdrawal(ctx: Context<CancelWithdrawal>) -> Result<()> {
        let accounts = &ctx.accounts.resolution;
        let withdrawal = &accounts.withdrawal;
        let nonce = withdrawal.nonce.to_le_bytes();
        let seeds: &[&[u8]] = &[
            b"withdrawal",
            withdrawal.owner.as_ref(),
            &nonce,
            &[ctx.bumps.resolution.withdrawal],
        ];
        token::transfer(
            CpiContext::new(
                accounts.token_program.key(),
                Transfer {
                    from: accounts.vault.to_account_info(),
                    to: ctx.accounts.refund_tokens.to_account_info(),
                    authority: withdrawal.to_account_info(),
                },
            )
            .with_signer(&[seeds]),
            withdrawal.amount,
        )?;
        ctx.accounts.resolution.withdrawal.status = WithdrawalStatus::Cancelled;
        Ok(())
    }

    pub fn create_token_metadata(ctx: Context<CreateTokenMetadata>, uri: String) -> Result<()> {
        require!(
            uri.starts_with("https://") && uri.len() > 8 && uri.len() <= 200,
            BridgeError::InvalidMetadataUri
        );
        let accounts = &ctx.accounts;
        let mint_seeds: &[&[u8]] = &[b"mint", &[ctx.bumps.mint]];
        metadata::create_metadata_accounts_v3(
            CpiContext::new(
                accounts.metadata_program.key(),
                CreateMetadataAccountsV3 {
                    metadata: accounts.metadata.to_account_info(),
                    mint: accounts.mint.to_account_info(),
                    mint_authority: accounts.mint.to_account_info(),
                    payer: accounts.admin.to_account_info(),
                    update_authority: accounts.admin.to_account_info(),
                    system_program: accounts.system_program.to_account_info(),
                    rent: accounts.rent.to_account_info(),
                },
            )
            .with_signer(&[mint_seeds]),
            DataV2 {
                name: "Wrapped Gridcoin".into(),
                symbol: "wGRC".into(),
                uri,
                seller_fee_basis_points: 0,
                creators: None,
                collection: None,
                uses: None,
            },
            true,
            true,
            None,
        )
    }

    pub fn set_paused(ctx: Context<Administer>, paused: bool) -> Result<()> {
        ctx.accounts.bridge.paused = paused;
        Ok(())
    }

    /// Separate PDA preserves the layout of existing deployed Bridge accounts.
    /// Minting fails closed until the administrator initializes this account.
    pub fn initialize_supply_limit(ctx: Context<InitializeSupplyLimit>) -> Result<()> {
        require!(ctx.accounts.mint.supply <= INITIAL_MAX_SUPPLY, BridgeError::CapBelowSupply);
        ctx.accounts.supply_limit.max_supply = INITIAL_MAX_SUPPLY;
        Ok(())
    }

    pub fn set_max_supply(ctx: Context<SetMaxSupply>, max_supply: u64) -> Result<()> {
        require!(max_supply >= ctx.accounts.mint.supply, BridgeError::CapBelowSupply);
        ctx.accounts.supply_limit.max_supply = max_supply;
        Ok(())
    }

    pub fn set_mint_operator(ctx: Context<Administer>, mint_operator: Pubkey) -> Result<()> {
        require!(mint_operator != Pubkey::default(), BridgeError::InvalidAuthority);
        ctx.accounts.bridge.mint_operator = mint_operator;
        Ok(())
    }

    pub fn transfer_admin(ctx: Context<TransferAdmin>) -> Result<()> {
        ctx.accounts.bridge.admin = ctx.accounts.new_admin.key();
        Ok(())
    }
}

#[derive(Accounts)]
pub struct Initialize<'info> {
    #[account(mut)]
    pub upgrade_authority: Signer<'info>,
    #[account(constraint = program.programdata_address()? == Some(program_data.key()))]
    pub program: Program<'info, crate::program::WgrcBridge>,
    #[account(
        constraint = program_data.upgrade_authority_address == Some(upgrade_authority.key())
            @ BridgeError::Unauthorized
    )]
    pub program_data: Account<'info, ProgramData>,
    #[account(
        init,
        payer = upgrade_authority,
        space = 8 + Bridge::INIT_SPACE,
        seeds = [b"bridge"],
        bump
    )]
    pub bridge: Account<'info, Bridge>,
    #[account(
        init,
        payer = upgrade_authority,
        seeds = [b"mint"],
        bump,
        mint::decimals = WGRC_DECIMALS,
        mint::authority = mint,
        mint::token_program = token_program
    )]
    pub mint: Account<'info, Mint>,
    pub token_program: Program<'info, Token>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
#[instruction(deposit_id: [u8; 32])]
pub struct MintDeposit<'info> {
    #[account(mut)]
    pub mint_operator: Signer<'info>,
    #[account(
        seeds = [b"bridge"],
        bump,
        has_one = mint_operator @ BridgeError::Unauthorized,
        constraint = !bridge.paused @ BridgeError::Paused
    )]
    pub bridge: Account<'info, Bridge>,
    #[account(seeds = [b"supply_limit"], bump)]
    pub supply_limit: Account<'info, SupplyLimit>,
    #[account(mut, seeds = [b"mint"], bump)]
    pub mint: Account<'info, Mint>,
    /// CHECK: The recipient's key is checked against the token account's owner.
    pub recipient: UncheckedAccount<'info>,
    #[account(mut, token::mint = mint, token::authority = recipient)]
    pub recipient_tokens: Account<'info, TokenAccount>,
    #[account(
        init,
        payer = mint_operator,
        space = 8 + DepositReceipt::INIT_SPACE,
        seeds = [b"deposit", deposit_id.as_ref()],
        bump
    )]
    pub deposit_receipt: Account<'info, DepositReceipt>,
    pub token_program: Program<'info, Token>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
#[instruction(nonce: u64)]
pub struct RequestWithdrawal<'info> {
    #[account(mut)]
    pub owner: Signer<'info>,
    #[account(
        seeds = [b"bridge"],
        bump,
        constraint = !bridge.paused @ BridgeError::Paused
    )]
    pub bridge: Account<'info, Bridge>,
    #[account(seeds = [b"mint"], bump)]
    pub mint: Account<'info, Mint>,
    #[account(mut, token::mint = mint, token::authority = owner)]
    pub owner_tokens: Account<'info, TokenAccount>,
    #[account(
        init,
        payer = owner,
        space = 8 + EscrowWithdrawal::INIT_SPACE,
        seeds = [b"withdrawal", owner.key().as_ref(), &nonce.to_le_bytes()],
        bump
    )]
    pub withdrawal: Account<'info, EscrowWithdrawal>,
    #[account(
        init,
        payer = owner,
        seeds = [b"vault", withdrawal.key().as_ref()],
        bump,
        token::mint = mint,
        token::authority = withdrawal,
        token::token_program = token_program
    )]
    pub vault: Account<'info, TokenAccount>,
    pub token_program: Program<'info, Token>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct ResolveWithdrawal<'info> {
    pub mint_operator: Signer<'info>,
    #[account(seeds = [b"bridge"], bump, has_one = mint_operator @ BridgeError::Unauthorized)]
    pub bridge: Account<'info, Bridge>,
    #[account(mut, seeds = [b"mint"], bump)]
    pub mint: Account<'info, Mint>,
    #[account(
        mut,
        seeds = [b"withdrawal", withdrawal.owner.as_ref(), &withdrawal.nonce.to_le_bytes()],
        bump,
        constraint = withdrawal.status == WithdrawalStatus::Pending @ BridgeError::WithdrawalResolved
    )]
    pub withdrawal: Account<'info, EscrowWithdrawal>,
    #[account(
        mut,
        seeds = [b"vault", withdrawal.key().as_ref()],
        bump,
        token::mint = mint,
        token::authority = withdrawal
    )]
    pub vault: Account<'info, TokenAccount>,
    pub token_program: Program<'info, Token>,
}

#[derive(Accounts)]
pub struct CancelWithdrawal<'info> {
    pub resolution: ResolveWithdrawal<'info>,
    #[account(
        mut,
        constraint = refund_tokens.mint == resolution.mint.key(),
        constraint = refund_tokens.owner == resolution.withdrawal.owner
    )]
    pub refund_tokens: Account<'info, TokenAccount>,
}

#[derive(Accounts)]
pub struct CreateTokenMetadata<'info> {
    #[account(mut)]
    pub admin: Signer<'info>,
    #[account(seeds = [b"bridge"], bump, has_one = admin @ BridgeError::Unauthorized)]
    pub bridge: Account<'info, Bridge>,
    #[account(seeds = [b"mint"], bump)]
    pub mint: Account<'info, Mint>,
    /// CHECK: The seeds validate the canonical Metaplex account for this mint.
    #[account(
        mut,
        seeds = [b"metadata", metadata_program.key().as_ref(), mint.key().as_ref()],
        bump,
        seeds::program = metadata_program.key()
    )]
    pub metadata: UncheckedAccount<'info>,
    pub metadata_program: Program<'info, Metadata>,
    pub system_program: Program<'info, System>,
    pub rent: Sysvar<'info, Rent>,
}

#[derive(Accounts)]
pub struct Administer<'info> {
    pub admin: Signer<'info>,
    #[account(mut, seeds = [b"bridge"], bump, has_one = admin @ BridgeError::Unauthorized)]
    pub bridge: Account<'info, Bridge>,
}

#[derive(Accounts)]
pub struct TransferAdmin<'info> {
    pub admin: Signer<'info>,
    pub new_admin: Signer<'info>,
    #[account(mut, seeds = [b"bridge"], bump, has_one = admin @ BridgeError::Unauthorized)]
    pub bridge: Account<'info, Bridge>,
}

#[derive(Accounts)]
pub struct InitializeSupplyLimit<'info> {
    #[account(mut)]
    pub admin: Signer<'info>,
    #[account(seeds = [b"bridge"], bump, has_one = admin @ BridgeError::Unauthorized)]
    pub bridge: Account<'info, Bridge>,
    #[account(seeds = [b"mint"], bump)]
    pub mint: Account<'info, Mint>,
    #[account(init, payer = admin, space = 8 + SupplyLimit::INIT_SPACE, seeds = [b"supply_limit"], bump)]
    pub supply_limit: Account<'info, SupplyLimit>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct SetMaxSupply<'info> {
    pub admin: Signer<'info>,
    #[account(seeds = [b"bridge"], bump, has_one = admin @ BridgeError::Unauthorized)]
    pub bridge: Account<'info, Bridge>,
    #[account(seeds = [b"mint"], bump)]
    pub mint: Account<'info, Mint>,
    #[account(mut, seeds = [b"supply_limit"], bump)]
    pub supply_limit: Account<'info, SupplyLimit>,
}

#[account]
#[derive(InitSpace)]
pub struct SupplyLimit {
    pub max_supply: u64,
}

#[account]
#[derive(InitSpace)]
pub struct Bridge {
    pub admin: Pubkey,
    pub mint_operator: Pubkey,
    pub paused: bool,
}

#[account]
#[derive(InitSpace)]
pub struct DepositReceipt {
    pub deposit_id: [u8; 32],
    pub recipient: Pubkey,
    pub amount: u64,
}

#[account]
#[derive(InitSpace)]
/// Legacy record for withdrawals that already burned tokens before the escrow upgrade.
pub struct WithdrawalRequest {
    pub owner: Pubkey,
    pub nonce: u64,
    pub amount: u64,
    #[max_len(MAX_GRIDCOIN_ADDRESS_LEN)]
    pub gridcoin_address: String,
}

#[account]
#[derive(InitSpace)]
pub struct EscrowWithdrawal {
    pub owner: Pubkey,
    pub nonce: u64,
    pub amount: u64,
    #[max_len(MAX_GRIDCOIN_ADDRESS_LEN)]
    pub gridcoin_address: String,
    pub status: WithdrawalStatus,
}

#[derive(AnchorSerialize, AnchorDeserialize, Clone, InitSpace, PartialEq, Eq)]
pub enum WithdrawalStatus {
    Pending,
    Settled { gridcoin_txid: [u8; 32] },
    Cancelled,
}

#[error_code]
pub enum BridgeError {
    #[msg("The signer is not authorized for this action.")]
    Unauthorized,
    #[msg("The bridge is paused.")]
    Paused,
    #[msg("The amount must be greater than zero.")]
    ZeroAmount,
    #[msg("The destination must be a valid Base58Check address.")]
    InvalidGridcoinAddress,
    #[msg("The authority cannot be the default public key.")]
    InvalidAuthority,
    #[msg("The withdrawal has already been settled or cancelled.")]
    WithdrawalResolved,
    #[msg("A Gridcoin payout transaction ID is required.")]
    InvalidPayoutTxid,
    #[msg("The metadata URI must be an HTTPS URL of at most 200 bytes.")]
    InvalidMetadataUri,
    #[msg("Mint would exceed the configured maximum wGRC supply.")]
    SupplyCapExceeded,
    #[msg("Maximum supply cannot be lower than the current wGRC supply.")]
    CapBelowSupply,
}
