import { Connection, PublicKey, sendAndConfirmTransaction } from '@solana/web3.js';
import { Wallet } from '@coral-xyz/anchor';
import { getAmountByShare } from '@meteora-ag/vault-sdk';
import {
  getAccount,
  getAssociatedTokenAddressSync,
  TOKEN_PROGRAM_ID,
  TokenAccountNotFoundError,
  TokenInvalidAccountOwnerError,
} from '@solana/spl-token';
import BN from 'bn.js';
import { DynamicVaultConfig } from '../../utils/types';
import {
  getAmountInLamports,
  getAmountInTokens,
  modifyComputeUnitPriceIx,
  runSimulateTransaction,
} from '../../helpers';
import { DEFAULT_SEND_TX_MAX_RETRIES, SOL_TOKEN_MINT } from '../../utils/constants';
import { loadDynamicVault } from './status';

/**
 * 0-SOL fee-payer guard, shared by deposit/withdraw. Returns the balance (lamports) so
 * deposit() can reuse it for the native-SOL wrap sufficiency check below.
 */
async function assertFunded(connection: Connection, payer: PublicKey): Promise<number> {
  const balance = await connection.getBalance(payer);
  if (balance === 0) {
    throw new Error(
      `Wallet ${payer.toString()} has 0 SOL — fund it first; even dry-run simulation requires an existing fee payer account`
    );
  }
  return balance;
}

/**
 * Deposit into the dynamic vault for `baseMint`. Reads config.dynamicVaultDeposit.amount
 * (baseMint human units, converted via the mint's own decimals). `VaultImpl.create()` keys off
 * the TOKEN MINT, not a vault address — there is one permissionless dynamic vault per mint.
 *
 * wSOL note (verified against the installed package's compiled `dist/cjs/src/vault/index.js`):
 * when `baseMint` is native SOL's wrapped mint, `deposit()` WRAPS the requested amount of SOL
 * for you internally (a `SystemProgram.transfer` + sync-native pre-instruction ahead of the
 * deposit instruction) — no pre-funded wSOL account is needed, only enough actual SOL lamports
 * in the wallet to cover the wrap amount plus rent/fees (checked below).
 */
export async function deposit(
  config: DynamicVaultConfig,
  connection: Connection,
  wallet: Wallet,
  baseMint: PublicKey
) {
  if (!config.dynamicVaultDeposit) {
    throw new Error('Missing dynamicVaultDeposit in configuration');
  }
  const { amount } = config.dynamicVaultDeposit;
  if (!(amount > 0)) {
    throw new Error(`dynamicVaultDeposit.amount must be > 0 (got ${amount})`);
  }

  console.log('\n> Initializing Dynamic Vault deposit...');
  const payerBalance = await assertFunded(connection, wallet.publicKey);

  const vaultImpl = await loadDynamicVault(connection, baseMint);
  const decimals = vaultImpl.tokenMint.decimals;
  const amountLamports = getAmountInLamports(amount, decimals);

  console.log(`- Vault ${vaultImpl.vaultPda.toString()}`);
  console.log(`- Base mint ${baseMint.toString()} (${decimals} decimals)`);

  const isNativeSol = baseMint.equals(SOL_TOKEN_MINT);
  if (isNativeSol) {
    console.log(
      '- Base mint is native SOL (wSOL) — deposit() wraps the requested amount of SOL for you ' +
        'internally; no pre-funded wSOL account is needed.'
    );
    // The wrap pre-instruction moves `amountLamports` lamports straight out of the wallet, on
    // top of the rent + fees the fee-payer guard above already confirmed the wallet can cover.
    if (payerBalance < Number(amountLamports.toString())) {
      throw new Error(
        `Wallet ${wallet.publicKey.toString()} has ${payerBalance} lamports of SOL but depositing ` +
          `${amount} SOL needs ${amountLamports.toString()} lamports to wrap, plus a little more ` +
          'for rent and fees — fund the wallet with more SOL first.'
      );
    }
  } else {
    // allowOwnerOffCurve=true + TOKEN_PROGRAM_ID mirrors the SDK's own internal
    // getAssociatedTokenAccount helper exactly (dynamic vault has no Token-2022 support — every
    // account it builds hardcodes TOKEN_PROGRAM_ID, verified against the compiled source).
    const ownerATA = getAssociatedTokenAddressSync(
      baseMint,
      wallet.publicKey,
      true,
      TOKEN_PROGRAM_ID
    );
    let ownerBalance = new BN(0);
    try {
      const account = await getAccount(connection, ownerATA, connection.commitment);
      ownerBalance = new BN(account.amount.toString());
    } catch (error) {
      if (
        !(error instanceof TokenAccountNotFoundError) &&
        !(error instanceof TokenInvalidAccountOwnerError)
      ) {
        throw error;
      }
    }
    if (ownerBalance.lt(amountLamports)) {
      throw new Error(
        `Wallet ${wallet.publicKey.toString()} holds ${getAmountInTokens(ownerBalance, decimals)} of mint ` +
          `${baseMint.toString()} but the deposit needs ${amount} — fund the wallet's token account first.`
      );
    }
  }

  console.log(`- Depositing ${amount} (${amountLamports.toString()} base units)`);

  const depositTx = await vaultImpl.deposit(wallet.publicKey, amountLamports);
  modifyComputeUnitPriceIx(depositTx, config.computeUnitPriceMicroLamports ?? 0);

  if (config.dryRun) {
    console.log('\n> Simulating deposit transaction...');
    await runSimulateTransaction(connection, [wallet.payer], wallet.publicKey, [depositTx]);
    console.log('> Deposit simulation successful');
  } else {
    console.log('\n>> Sending deposit transaction...');
    const txHash = await sendAndConfirmTransaction(connection, depositTx, [wallet.payer], {
      commitment: connection.commitment,
      maxRetries: DEFAULT_SEND_TX_MAX_RETRIES,
    });
    console.log(`>>> Deposited successfully with tx hash: ${txHash}`);
  }
}

/**
 * Withdraw from the dynamic vault for `baseMint`. Reads config.dynamicVaultWithdraw.amount.
 *
 * UNIT WARNING (verified against the installed package's compiled `dist/cjs/src/vault/index.js`
 * and the vault program's IDL — NOT the shipped `.d.ts`, whose parameter name is misleading):
 * despite the SDK naming the parameter `baseTokenAmount`, `withdraw()` actually burns VAULT LP
 * TOKENS, not base-mint tokens. Internally it computes
 * `amountToWithdraw = baseTokenAmount.mul(withdrawableAmount).div(lpSupply)` — exactly the
 * `getAmountByShare(share, withdrawableAmount, totalSupply)` formula exported by this same
 * package — before choosing a withdrawal path, and the on-chain instruction's real argument
 * names (from the vault program IDL) are `unmintAmount` + `minOutAmount`, confirming
 * `baseTokenAmount` here IS the LP/share amount to burn. `config.dynamicVaultWithdraw.amount` is
 * therefore in **vault LP token human units** — the LP mint's own decimals, which always equal
 * the base mint's decimals on-chain (`mint::decimals = token_mint.decimals` in the vault
 * program's account-init constraints), so the human-unit scale looks the same even though 1 LP
 * token generally does NOT equal 1 base-mint token once the vault has earned yield. The
 * equivalent underlying-token amount this will actually redeem is computed and printed below
 * before every send.
 */
export async function withdraw(
  config: DynamicVaultConfig,
  connection: Connection,
  wallet: Wallet,
  baseMint: PublicKey
) {
  if (!config.dynamicVaultWithdraw) {
    throw new Error('Missing dynamicVaultWithdraw in configuration');
  }
  const { amount } = config.dynamicVaultWithdraw;
  if (!(amount > 0)) {
    throw new Error(`dynamicVaultWithdraw.amount must be > 0 (got ${amount})`);
  }

  console.log('\n> Initializing Dynamic Vault withdraw...');
  await assertFunded(connection, wallet.publicKey);

  const vaultImpl = await loadDynamicVault(connection, baseMint);
  const decimals = vaultImpl.tokenMint.decimals;
  const lpDecimals = vaultImpl.tokenLpMint.decimals;

  console.log(`- Vault ${vaultImpl.vaultPda.toString()}`);
  console.log(`- Base mint ${baseMint.toString()} (${decimals} decimals)`);

  const [totalSupply, withdrawableAmount, lpBalance] = await Promise.all([
    vaultImpl.getVaultSupply(),
    vaultImpl.getWithdrawableAmount(),
    vaultImpl.getUserBalance(wallet.publicKey),
  ]);
  console.log(
    `- Current LP balance: ${getAmountInTokens(lpBalance, lpDecimals)} (${lpBalance.toString()} base units)`
  );

  const amountLamports = getAmountInLamports(amount, lpDecimals);
  if (amountLamports.gt(lpBalance)) {
    throw new Error(
      `Requested withdrawal of ${amount} LP tokens exceeds wallet ${wallet.publicKey.toString()}'s ` +
        `current LP balance of ${getAmountInTokens(lpBalance, lpDecimals)}.`
    );
  }

  const underlyingAmount = getAmountByShare(amountLamports, withdrawableAmount, totalSupply);
  console.log(
    `- Withdrawing ${amount} LP tokens (${amountLamports.toString()} base units) ≈ ` +
      `${getAmountInTokens(underlyingAmount, decimals)} of the underlying token ` +
      `(${underlyingAmount.toString()} base units) at the current virtual price`
  );
  if (baseMint.equals(SOL_TOKEN_MINT)) {
    console.log(
      '- Base mint is native SOL (wSOL) — withdraw() unwraps the redeemed SOL back to the ' +
        'wallet automatically.'
    );
  }

  const withdrawTx = await vaultImpl.withdraw(wallet.publicKey, amountLamports);
  modifyComputeUnitPriceIx(withdrawTx, config.computeUnitPriceMicroLamports ?? 0);

  if (config.dryRun) {
    console.log('\n> Simulating withdraw transaction...');
    await runSimulateTransaction(connection, [wallet.payer], wallet.publicKey, [withdrawTx]);
    console.log('> Withdraw simulation successful');
  } else {
    console.log('\n>> Sending withdraw transaction...');
    const txHash = await sendAndConfirmTransaction(connection, withdrawTx, [wallet.payer], {
      commitment: connection.commitment,
      maxRetries: DEFAULT_SEND_TX_MAX_RETRIES,
    });
    console.log(`>>> Withdrawn successfully with tx hash: ${txHash}`);
  }
}
