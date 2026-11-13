use anchor_lang::prelude::*;
use anchor_spl::token::{self, Burn, Mint, MintTo, Token, TokenAccount};

// Replace this development address with the deployment keypair's public key.
declare_id!("AvqkRykFXfx31fDYnJq7kPkNpgiMA6LbknavHMvjz3Zy");

const WGRC_DECIMALS: u8 = 8;
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

        token::burn(
            CpiContext::new(
                ctx.accounts.token_program.key(),
                Burn {
                    mint: ctx.accounts.mint.to_account_info(),
                    from: ctx.accounts.owner_tokens.to_account_info(),
                    authority: ctx.accounts.owner.to_account_info(),
                },
            ),
            amount,
        )?;

        ctx.accounts.withdrawal.set_inner(WithdrawalRequest {
            owner: ctx.accounts.owner.key(),
            nonce,
            amount,
            gridcoin_address,
        });
        Ok(())
    }

    pub fn set_paused(ctx: Context<Administer>, paused: bool) -> Result<()> {
        ctx.accounts.bridge.paused = paused;
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
    #[account(mut, seeds = [b"mint"], bump)]
    pub mint: Account<'info, Mint>,
    #[account(mut, token::mint = mint, token::authority = owner)]
    pub owner_tokens: Account<'info, TokenAccount>,
    #[account(
        init,
        payer = owner,
        space = 8 + WithdrawalRequest::INIT_SPACE,
        seeds = [b"withdrawal", owner.key().as_ref(), &nonce.to_le_bytes()],
        bump
    )]
    pub withdrawal: Account<'info, WithdrawalRequest>,
    pub token_program: Program<'info, Token>,
    pub system_program: Program<'info, System>,
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
pub struct WithdrawalRequest {
    pub owner: Pubkey,
    pub nonce: u64,
    pub amount: u64,
    #[max_len(MAX_GRIDCOIN_ADDRESS_LEN)]
    pub gridcoin_address: String,
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
}
