import VaultImpl, { getAmountByShare, getVaultPdas, PROGRAM_ID } from '@meteora-ag/vault-sdk';
import { Connection, PublicKey } from '@solana/web3.js';
import Decimal from 'decimal.js';
import { getAmountInTokens } from '../../helpers';

/** vault-sdk exports `PROGRAM_ID` as a plain string, unlike most other Meteora SDKs (a `PublicKey` or a per-cluster map); normalized to a `PublicKey` here. */
export function defaultDynamicVaultProgramId(): PublicKey {
  return new PublicKey(PROGRAM_ID);
}

/** Derive the vault/token-vault/LP-mint PDAs for `tokenMint` without requiring the vault to exist on-chain, so a "vault not found" error can still show which PDA was expected. */
export function deriveDynamicVaultAddresses(tokenMint: PublicKey) {
  return getVaultPdas(tokenMint, defaultDynamicVaultProgramId());
}

/**
 * Load a `VaultImpl` for `tokenMint` (the SDK keys off the token mint, not a vault address — there is one permissionless vault per mint).
 * `VaultImpl.create()` throws a bare string, not an `Error`, when no vault exists yet; caught here and re-thrown with the derived PDA.
 * @param connection - The connection to the network
 * @param tokenMint - The vault's base token mint
 * @returns The loaded dynamic vault
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
 * Print the status of the dynamic vault for `tokenMint` (read-only, no keypair required), including the virtual price and, with a wallet, its LP balance and redemption value.
 * Dividing raw base units directly for the virtual price is safe because the vault always mints the LP token with the base mint's decimals.
 * @param connection - The connection to the network
 * @param tokenMint - The vault's base token mint
 * @param walletPubkey - Optional wallet to show LP balance/redemption value for
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
