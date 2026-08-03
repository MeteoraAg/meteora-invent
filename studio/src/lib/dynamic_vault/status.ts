import VaultImpl, { getAmountByShare, getVaultPdas, PROGRAM_ID } from '@meteora-ag/vault-sdk';
import { Connection, PublicKey } from '@solana/web3.js';
import Decimal from 'decimal.js';
import { getAmountInTokens } from '../../helpers';

/**
 * The dynamic-vault program id every action in this codebase resolves against. vault-sdk
 * exports `PROGRAM_ID` as a plain STRING (unlike most other Meteora SDKs, which export a
 * PublicKey or a per-cluster map) — verified against the installed package's
 * dist/cjs/src/vault/constants.d.ts.
 */
export function defaultDynamicVaultProgramId(): PublicKey {
  return new PublicKey(PROGRAM_ID);
}

/**
 * Derive the vault / token-vault / LP-mint PDAs for `tokenMint` without requiring the vault to
 * already exist on-chain — the same derivation `VaultImpl.create()` uses internally
 * (`getVaultPdas` with the default `VAULT_BASE_KEY` seed, verified against the installed
 * package's compiled `getVaultState`). Exposed here so a "vault not found" error can still
 * show exactly which PDA was expected.
 */
export function deriveDynamicVaultAddresses(tokenMint: PublicKey) {
  return getVaultPdas(tokenMint, defaultDynamicVaultProgramId());
}

/**
 * Load a `VaultImpl` for `tokenMint` (dynamic vault SDK keys off the TOKEN MINT being
 * deposited, not a vault address — there is one permissionless vault per mint). `VaultImpl
 * .create()` throws a bare STRING (`'Cannot get vault state'`, not an `Error`) when no
 * permissionless vault exists yet for this mint — verified against the installed package's
 * compiled `dist/cjs/src/vault/index.js` (`getVaultState` does `fetchNullable` then `throw
 * 'Cannot get vault state'` on a miss). Caught here and re-thrown with the derived PDA so the
 * failure is actionable instead of a bare string bubbling up.
 */
export async function loadDynamicVault(
  connection: Connection,
  tokenMint: PublicKey
): Promise<VaultImpl> {
  try {
    return await VaultImpl.create(connection, tokenMint);
  } catch (error) {
    const { vaultPda, tokenVaultPda, lpMintPda } = deriveDynamicVaultAddresses(tokenMint);
    throw new Error(
      `No dynamic vault found for token mint ${tokenMint.toString()} ` +
        `(expected vault PDA ${vaultPda.toString()}, token vault ${tokenVaultPda.toString()}, LP mint ${lpMintPda.toString()}). ` +
        `Has a permissionless vault been created for this mint yet? ` +
        `${error instanceof Error ? error.message : String(error)}`
    );
  }
}

/**
 * Print the status of the dynamic vault for `tokenMint` (read-only, no keypair required):
 * vault PDA, total LP supply, withdrawable amount, and the virtual price (withdrawable amount
 * ÷ total LP supply — safe to divide raw base units directly because the on-chain program
 * always mints the LP token with `mint::decimals = token_mint.decimals`, verified against the
 * vault program's account-init constraints). With a wallet, also that wallet's LP balance and
 * its current underlying redemption value via `getAmountByShare`.
 */
export async function getStatus(
  connection: Connection,
  tokenMint: PublicKey,
  walletPubkey?: PublicKey
): Promise<void> {
  console.log(`\n> Token mint: ${tokenMint.toString()}`);

  const vaultImpl = await loadDynamicVault(connection, tokenMint);
  const decimals = vaultImpl.tokenMint.decimals;

  console.log(`> Vault PDA:        ${vaultImpl.vaultPda.toString()}`);
  console.log(`> Token vault PDA:  ${vaultImpl.tokenVaultPda.toString()}`);
  console.log(`> LP mint:          ${vaultImpl.vaultState.lpMint.toString()}`);
  console.log(`> Token decimals:   ${decimals}`);

  const [totalSupply, withdrawableAmount] = await Promise.all([
    vaultImpl.getVaultSupply(),
    vaultImpl.getWithdrawableAmount(),
  ]);
  const lpDecimals = vaultImpl.tokenLpMint.decimals;

  console.log(
    `> Total LP supply:     ${getAmountInTokens(totalSupply, lpDecimals)} (${totalSupply.toString()} base units)`
  );
  console.log(
    `> Withdrawable amount: ${getAmountInTokens(withdrawableAmount, decimals)} (${withdrawableAmount.toString()} base units) ` +
      `— underlying tokens claimable right now (locked profit already excluded)`
  );

  const virtualPrice = totalSupply.isZero()
    ? new Decimal(1)
    : new Decimal(withdrawableAmount.toString()).div(new Decimal(totalSupply.toString()));
  console.log(`> Virtual price:       ${virtualPrice.toString()} underlying token per LP token`);

  if (!walletPubkey) {
    return;
  }

  console.log(`\n> Wallet: ${walletPubkey.toString()}`);
  const lpBalance = await vaultImpl.getUserBalance(walletPubkey);
  const underlyingValue = getAmountByShare(lpBalance, withdrawableAmount, totalSupply);
  console.log(
    `> LP balance:       ${getAmountInTokens(lpBalance, lpDecimals)} (${lpBalance.toString()} base units)`
  );
  console.log(
    `> Underlying value: ${getAmountInTokens(underlyingValue, decimals)} (${underlyingValue.toString()} base units) ` +
      `— current redemption value of this LP balance (getAmountByShare)`
  );
}
