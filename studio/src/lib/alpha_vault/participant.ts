import { Connection, PublicKey, sendAndConfirmTransaction } from '@solana/web3.js';
import { Wallet } from '@coral-xyz/anchor';
import {
  DepositWithProofParams,
  VaultMode,
  VaultState,
  WhitelistMode,
} from '@meteora-ag/alpha-vault';
import BN from 'bn.js';
import { AlphaVaultConfig } from '../../utils/types';
import {
  getAmountInLamports,
  getAmountInTokens,
  modifyComputeUnitPriceIx,
  runSimulateTransaction,
} from '../../helpers';
import { DEFAULT_SEND_TX_MAX_RETRIES } from '../../utils/constants';
import { formatAlphaVaultAmount, loadAlphaVault } from './utils';

async function assertFunded(connection: Connection, payer: PublicKey): Promise<void> {
  const balance = await connection.getBalance(payer);
  if (balance === 0) {
    throw new Error(
      `Wallet ${payer.toString()} has 0 SOL — fund it first; even dry-run simulation requires an existing fee payer account`
    );
  }
}

/**
 * Deposit into an alpha vault. Reads config.alphaVaultDeposit.amount (quote human units).
 * Auto-fetches a merkle proof when the vault is permissioned_with_merkle_proof, and pre-checks
 * interactionState().canDeposit + availableQuota so a blocked deposit fails with a clear
 * "why" (vault phase / whitelist / cap) instead of an on-chain revert.
 */
export async function deposit(
  config: AlphaVaultConfig,
  connection: Connection,
  wallet: Wallet,
  vault: PublicKey
) {
  if (!config.alphaVaultDeposit) {
    throw new Error('Missing alphaVaultDeposit in configuration');
  }
  const { amount } = config.alphaVaultDeposit;

  console.log('\n> Initializing Alpha Vault deposit...');
  await assertFunded(connection, wallet.publicKey);

  const alphaVault = await loadAlphaVault(connection, vault);
  const quoteDecimals = alphaVault.quoteMintInfo.mint.decimals;

  console.log(`- Vault ${vault.toString()}`);
  console.log(`- Mode: ${VaultMode[alphaVault.mode]}`);
  console.log(`- Vault state: ${VaultState[alphaVault.vaultState]}`);
  console.log(`- Whitelist mode: ${WhitelistMode[alphaVault.vault.whitelistMode]}`);

  let merkleProof: DepositWithProofParams | undefined;
  if (alphaVault.vault.whitelistMode === WhitelistMode.PermissionWithMerkleProof) {
    console.log('- Vault requires a merkle proof — fetching it from the Meteora proof API...');
    const proof = await alphaVault.getMerkleProofForDeposit(wallet.publicKey);
    if (!proof) {
      throw new Error(
        `No merkle proof found for wallet ${wallet.publicKey.toString()} on vault ${vault.toString()}. ` +
          "This vault is permissioned_with_merkle_proof — the wallet must be on the vault's whitelist " +
          'and the proof must already be published (merkle proof metadata / KV upload done by the ' +
          'vault creator) before it can deposit.'
      );
    }
    merkleProof = proof;
    console.log(
      `- Merkle proof found — this wallet's cap: ${getAmountInTokens(proof.maxCap, quoteDecimals)}`
    );
  }

  const escrow = await alphaVault.getEscrow(wallet.publicKey);
  const state = await alphaVault.interactionState(escrow, merkleProof);

  console.log(
    `- Available deposit quota: ${formatAlphaVaultAmount(state.availableQuota, quoteDecimals)}`
  );

  if (!state.canDeposit) {
    const reasons: string[] = [];
    if (!state.isWhitelisted) {
      if (alphaVault.vault.whitelistMode === WhitelistMode.PermissionWithMerkleProof) {
        reasons.push('wallet is not whitelisted (no usable merkle proof)');
      } else if (alphaVault.vault.whitelistMode === WhitelistMode.PermissionWithAuthority) {
        reasons.push(
          'wallet has no stake escrow on this vault yet — in permissioned_with_authority mode only the ' +
            'vault authority can create one (there is nothing this action can do about it)'
        );
      } else {
        reasons.push('wallet is not whitelisted');
      }
    }
    if (alphaVault.vaultState !== VaultState.DEPOSITING) {
      reasons.push(
        `vault is not in the depositing phase right now (current phase: ${VaultState[alphaVault.vaultState]})`
      );
    }
    if (state.availableQuota.lten(0)) {
      reasons.push('the deposit cap (individual or vault-wide) has already been reached');
    }
    if (reasons.length === 0) {
      reasons.push('unknown — re-check the vault and escrow state with alpha-vault-get-status');
    }
    throw new Error(
      `Cannot deposit into vault ${vault.toString()} right now:\n` +
        reasons.map((reason) => `  - ${reason}`).join('\n')
    );
  }

  const amountLamports = getAmountInLamports(amount, quoteDecimals);
  if (amountLamports.gt(state.availableQuota)) {
    throw new Error(
      `Requested deposit ${amount} exceeds the remaining quota of ` +
        `${formatAlphaVaultAmount(state.availableQuota, quoteDecimals)} for this wallet on this vault.`
    );
  }
  console.log(`- Depositing ${amount} (${amountLamports.toString()} base units)`);

  const depositTx = await alphaVault.deposit(amountLamports, wallet.publicKey, merkleProof);
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
 * Withdraw from an alpha vault during the deposit phase. Reads config.alphaVaultWithdraw.amount
 * (quote human units). Only valid for prorata-mode vaults while still DEPOSITING — guarded on
 * interactionState().canWithdraw.
 */
export async function withdraw(
  config: AlphaVaultConfig,
  connection: Connection,
  wallet: Wallet,
  vault: PublicKey
) {
  if (!config.alphaVaultWithdraw) {
    throw new Error('Missing alphaVaultWithdraw in configuration');
  }
  const { amount } = config.alphaVaultWithdraw;

  console.log('\n> Initializing Alpha Vault withdraw...');
  await assertFunded(connection, wallet.publicKey);

  const alphaVault = await loadAlphaVault(connection, vault);
  const quoteDecimals = alphaVault.quoteMintInfo.mint.decimals;

  console.log(`- Vault ${vault.toString()}`);
  console.log(`- Mode: ${VaultMode[alphaVault.mode]}`);
  console.log(`- Vault state: ${VaultState[alphaVault.vaultState]}`);

  const escrow = await alphaVault.getEscrow(wallet.publicKey);
  if (!escrow) {
    throw new Error(
      `No escrow found for wallet ${wallet.publicKey.toString()} on vault ${vault.toString()} — deposit first.`
    );
  }
  console.log(`- Current deposit: ${getAmountInTokens(escrow.totalDeposit, quoteDecimals)}`);

  const state = await alphaVault.interactionState(escrow);
  if (!state.canWithdraw) {
    const reasons: string[] = [];
    if (alphaVault.mode !== VaultMode.PRORATA) {
      reasons.push('withdraw is only allowed on prorata-mode vaults (this vault is FCFS)');
    }
    if (alphaVault.vaultState !== VaultState.DEPOSITING) {
      reasons.push(
        `vault is not in the depositing phase right now (current phase: ${VaultState[alphaVault.vaultState]})`
      );
    }
    if (escrow.totalDeposit.lten(0)) {
      reasons.push('escrow has no deposit to withdraw');
    }
    if (reasons.length === 0) {
      reasons.push('unknown — re-check the vault and escrow state with alpha-vault-get-status');
    }
    throw new Error(
      `Cannot withdraw from vault ${vault.toString()} right now:\n` +
        reasons.map((reason) => `  - ${reason}`).join('\n')
    );
  }

  const amountLamports = getAmountInLamports(amount, quoteDecimals);
  if (amountLamports.gt(escrow.totalDeposit)) {
    throw new Error(
      `Requested withdrawal ${amount} exceeds the escrow's current deposit of ` +
        `${getAmountInTokens(escrow.totalDeposit, quoteDecimals)}.`
    );
  }
  console.log(`- Withdrawing ${amount} (${amountLamports.toString()} base units)`);

  const withdrawTx = await alphaVault.withdraw(amountLamports, wallet.publicKey);
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

/**
 * Claim vested/bought tokens from an alpha vault. Guarded on claimInfo.totalClaimable > 0
 * (surfaced via interactionState().canClaim). When config.alphaVaultClaim.closeEscrowWhenDone
 * is set and a real (non-dry-run) claim lands, refreshes state and closes the escrow afterwards
 * if — and only if — vesting has ended and everything has now been claimed.
 */
export async function claim(
  config: AlphaVaultConfig,
  connection: Connection,
  wallet: Wallet,
  vault: PublicKey
) {
  console.log('\n> Initializing Alpha Vault claim...');
  await assertFunded(connection, wallet.publicKey);

  const alphaVault = await loadAlphaVault(connection, vault);
  const baseDecimals = alphaVault.baseMintInfo.mint.decimals;

  console.log(`- Vault ${vault.toString()}`);
  console.log(`- Vault state: ${VaultState[alphaVault.vaultState]}`);

  const escrow = await alphaVault.getEscrow(wallet.publicKey);
  if (!escrow) {
    throw new Error(
      `No escrow found for wallet ${wallet.publicKey.toString()} on vault ${vault.toString()} — nothing to claim.`
    );
  }

  const state = await alphaVault.interactionState(escrow);
  console.log(
    `- Total allocated: ${getAmountInTokens(state.claimInfo.totalAllocated, baseDecimals)}`
  );
  console.log(
    `- Total claimed:   ${getAmountInTokens(state.claimInfo.totalClaimed, baseDecimals)}`
  );
  console.log(
    `- Claimable now:   ${getAmountInTokens(state.claimInfo.totalClaimable, baseDecimals)}`
  );

  if (state.claimInfo.totalClaimable.lten(0)) {
    const reason = [VaultState.VESTING, VaultState.ENDED].includes(alphaVault.vaultState)
      ? 'nothing left to claim right now (fully claimed already, or nothing has vested yet at this instant)'
      : `vesting has not started yet (current phase: ${VaultState[alphaVault.vaultState]}, starts at point ${alphaVault.vault.startVestingPoint.toString()})`;
    throw new Error(`Cannot claim from vault ${vault.toString()} right now:\n  - ${reason}`);
  }

  const claimTx = await alphaVault.claimToken(wallet.publicKey);
  modifyComputeUnitPriceIx(claimTx, config.computeUnitPriceMicroLamports ?? 0);

  if (config.dryRun) {
    console.log('\n> Simulating claim transaction...');
    await runSimulateTransaction(connection, [wallet.payer], wallet.publicKey, [claimTx]);
    console.log('> Claim simulation successful');
    if (config.alphaVaultClaim?.closeEscrowWhenDone) {
      console.log(
        '> Note: alphaVaultClaim.closeEscrowWhenDone is set — this only takes effect on a real ' +
          '(non-dry-run) claim, and only once vesting has ended with everything claimed.'
      );
    }
    return;
  }

  console.log('\n>> Sending claim transaction...');
  const txHash = await sendAndConfirmTransaction(connection, claimTx, [wallet.payer], {
    commitment: connection.commitment,
    maxRetries: DEFAULT_SEND_TX_MAX_RETRIES,
  });
  console.log(`>>> Claimed successfully with tx hash: ${txHash}`);

  if (!config.alphaVaultClaim?.closeEscrowWhenDone) {
    return;
  }

  await alphaVault.refreshState();
  const refreshedEscrow = await alphaVault.getEscrow(wallet.publicKey);
  const refreshedClaimInfo = alphaVault.getClaimInfo(refreshedEscrow);
  const fullyClaimed =
    alphaVault.vaultState === VaultState.ENDED && refreshedClaimInfo.totalClaimable.lten(0);

  if (!fullyClaimed) {
    console.log(
      '> alphaVaultClaim.closeEscrowWhenDone is set, but vesting has not ended and/or there is ' +
        'still more to claim later — leaving the escrow open.'
    );
    return;
  }

  console.log(
    '\n> closeEscrowWhenDone is set and everything has been claimed — closing the escrow...'
  );
  const closeTx = await alphaVault.closeEscrow(wallet.publicKey);
  modifyComputeUnitPriceIx(closeTx, config.computeUnitPriceMicroLamports ?? 0);
  const closeTxHash = await sendAndConfirmTransaction(connection, closeTx, [wallet.payer], {
    commitment: connection.commitment,
    maxRetries: DEFAULT_SEND_TX_MAX_RETRIES,
  });
  console.log(`>>> Escrow closed successfully with tx hash: ${closeTxHash}`);
}

/**
 * Withdraw an escrow's unused ("remaining") deposit after the vault has finished buying —
 * prorata overflow refunds. Guarded on interactionState().canWithdrawRemainingQuote.
 */
export async function withdrawRemainingQuote(
  config: AlphaVaultConfig,
  connection: Connection,
  wallet: Wallet,
  vault: PublicKey
) {
  console.log('\n> Initializing Alpha Vault withdraw-remaining-quote...');
  await assertFunded(connection, wallet.publicKey);

  const alphaVault = await loadAlphaVault(connection, vault);
  const quoteDecimals = alphaVault.quoteMintInfo.mint.decimals;

  console.log(`- Vault ${vault.toString()}`);
  console.log(`- Vault state: ${VaultState[alphaVault.vaultState]}`);

  const escrow = await alphaVault.getEscrow(wallet.publicKey);
  if (!escrow) {
    throw new Error(
      `No escrow found for wallet ${wallet.publicKey.toString()} on vault ${vault.toString()} — nothing to withdraw.`
    );
  }

  const state = await alphaVault.interactionState(escrow);
  const remainingQuote = alphaVault.vault.totalDeposit.sub(alphaVault.vault.swappedAmount);
  console.log(
    `- Vault's unused deposit: ${getAmountInTokens(remainingQuote.isNeg() ? new BN(0) : remainingQuote, quoteDecimals)}`
  );

  if (!state.canWithdrawRemainingQuote) {
    const reasons: string[] = [];
    if (
      ![VaultState.LOCKING, VaultState.VESTING, VaultState.ENDED].includes(alphaVault.vaultState)
    ) {
      reasons.push(
        `vault has not finished its purchasing phase yet (current phase: ${VaultState[alphaVault.vaultState]})`
      );
    }
    if (remainingQuote.lten(0)) {
      reasons.push(
        'the vault swapped its entire deposit — there is no unused quote left to refund'
      );
    }
    if (escrow.refunded !== 0) {
      reasons.push('this escrow has already withdrawn its remaining quote');
    }
    if (reasons.length === 0) {
      reasons.push('unknown — re-check the vault and escrow state with alpha-vault-get-status');
    }
    throw new Error(
      `Cannot withdraw remaining quote from vault ${vault.toString()} right now:\n` +
        reasons.map((reason) => `  - ${reason}`).join('\n')
    );
  }

  const withdrawTx = await alphaVault.withdrawRemainingQuote(wallet.publicKey);
  modifyComputeUnitPriceIx(withdrawTx, config.computeUnitPriceMicroLamports ?? 0);

  if (config.dryRun) {
    console.log('\n> Simulating withdraw-remaining-quote transaction...');
    await runSimulateTransaction(connection, [wallet.payer], wallet.publicKey, [withdrawTx]);
    console.log('> Withdraw-remaining-quote simulation successful');
  } else {
    console.log('\n>> Sending withdraw-remaining-quote transaction...');
    const txHash = await sendAndConfirmTransaction(connection, withdrawTx, [wallet.payer], {
      commitment: connection.commitment,
      maxRetries: DEFAULT_SEND_TX_MAX_RETRIES,
    });
    console.log(`>>> Remaining quote withdrawn successfully with tx hash: ${txHash}`);
  }
}

/**
 * Crank the vault to buy tokens from the pool with deposited quote — permissionless; anyone can
 * call it. Loops fillVault(payer) until it returns null/undefined (fully filled, or the pool ran
 * out of the liquidity the vault needed). Under dryRun this can only simulate the FIRST
 * transaction (each subsequent fill depends on the previous one having actually landed), so it
 * simulates once and stops with a note instead of looping.
 */
export async function crankFill(
  config: AlphaVaultConfig,
  connection: Connection,
  wallet: Wallet,
  vault: PublicKey
) {
  console.log('\n> Initializing Alpha Vault crank (fillVault)...');
  await assertFunded(connection, wallet.publicKey);

  const alphaVault = await loadAlphaVault(connection, vault);
  console.log(`- Vault ${vault.toString()}`);
  console.log(`- Mode: ${VaultMode[alphaVault.mode]}`);
  console.log(`- Vault state: ${VaultState[alphaVault.vaultState]}`);

  let iteration = 0;
  for (;;) {
    iteration += 1;
    const fillTx = await alphaVault.fillVault(wallet.publicKey);
    if (!fillTx) {
      console.log(
        `\n>>> Crank complete after ${iteration - 1} fill transaction(s) — fillVault returned null ` +
          '(vault fully filled, or the pool ran out of the liquidity it needed).'
      );
      break;
    }

    modifyComputeUnitPriceIx(fillTx, config.computeUnitPriceMicroLamports ?? 0);

    if (config.dryRun) {
      console.log(`\n> Simulating fill vault transaction (iteration ${iteration})...`);
      await runSimulateTransaction(connection, [wallet.payer], wallet.publicKey, [fillTx]);
      console.log(
        '> Fill vault simulation successful. Cranking is a multi-transaction loop where each ' +
          'transaction depends on the previous one having landed on-chain — dry run only simulates ' +
          'this FIRST transaction and stops here. Set dryRun to false to actually crank the vault to ' +
          'completion (the action then keeps sending fillVault transactions until it returns null).'
      );
      break;
    }

    console.log(`\n>> Sending fill vault transaction (iteration ${iteration})...`);
    const txHash = await sendAndConfirmTransaction(connection, fillTx, [wallet.payer], {
      commitment: connection.commitment,
      maxRetries: DEFAULT_SEND_TX_MAX_RETRIES,
    });
    console.log(`>>> Fill vault iteration ${iteration} landed: ${txHash}`);

    // fillVault() reads off the cached this.vault snapshot — without refreshing, every
    // iteration would rebuild the exact same (now stale) transaction. Matches the SDK's own
    // fillVaultDlmm.ts example.
    await alphaVault.refreshState();
  }
}
