import {
  ActivationType,
  PoolType,
  VaultMode,
  VaultState,
  WhitelistMode,
} from '@meteora-ag/alpha-vault';
import { Connection, PublicKey } from '@solana/web3.js';
import { getAmountInTokens } from '../../helpers';
import { defaultAlphaVaultProgramId, formatAlphaVaultAmount, loadAlphaVault } from './utils';

export interface AlphaVaultSelector {
  vault?: PublicKey;
  poolAddress?: PublicKey;
}

/**
 * Resolve a vault address from either an explicit --vault, or a --poolAddress looked up via
 * getProgramAccounts memcmp (Vault.pool is the first field after the 8-byte discriminator, so
 * offset 8 — verified against the installed .d.ts). There is no pure PDA derivation from just
 * the pool: the vault's seed is `[base, pool]` where `base` is the creator/config keypair, not
 * recoverable from the pool alone.
 */
export async function resolveAlphaVaultAddress(
  connection: Connection,
  selector: AlphaVaultSelector,
  alphaVaultProgramId: PublicKey = defaultAlphaVaultProgramId()
): Promise<PublicKey> {
  if (selector.vault) {
    return selector.vault;
  }
  if (!selector.poolAddress) {
    throw new Error('Please provide --vault or --poolAddress flag to do this action');
  }

  const accounts = await connection.getProgramAccounts(alphaVaultProgramId, {
    filters: [{ memcmp: { offset: 8, bytes: selector.poolAddress.toBase58() } }],
  });
  const [first] = accounts;
  if (!first) {
    throw new Error(
      `No alpha vault found for pool ${selector.poolAddress.toString()} (program ${alphaVaultProgramId.toString()}). ` +
        'Pass --vault directly if you already know the vault address.'
    );
  }
  if (accounts.length > 1) {
    console.log(
      `> Warning: ${accounts.length} alpha vaults found for pool ${selector.poolAddress.toString()} — using the first: ${first.pubkey.toString()}`
    );
  }
  return first.pubkey;
}

/**
 * Print the status of an alpha vault (read-only, no keypair required): resolves the vault
 * (direct or via pool memcmp), prints mode/state/caps/totals from the on-chain `.vault`
 * fields, and — when a wallet is supplied — the wallet's interactionState() booleans plus
 * deposit/claim numbers.
 */
export async function getStatus(
  connection: Connection,
  selector: AlphaVaultSelector,
  walletPubkey?: PublicKey
) {
  const alphaVaultProgramId = defaultAlphaVaultProgramId();
  const vaultAddress = await resolveAlphaVaultAddress(connection, selector, alphaVaultProgramId);
  console.log(`\n> Vault:           ${vaultAddress.toString()}`);

  const alphaVault = await loadAlphaVault(connection, vaultAddress, alphaVaultProgramId);
  const v = alphaVault.vault;
  const quoteDecimals = alphaVault.quoteMintInfo.mint.decimals;
  const baseDecimals = alphaVault.baseMintInfo.mint.decimals;
  const pointUnit = v.activationType === ActivationType.SLOT ? 'slot' : 'unix seconds';

  console.log(`> Pool:            ${v.pool.toString()}`);
  console.log(`> Pool type:       ${PoolType[v.poolType]}`);
  console.log(`> Mode:            ${VaultMode[alphaVault.mode]}`);
  console.log(`> Vault state:     ${VaultState[alphaVault.vaultState]}`);
  console.log(`> Whitelist mode:  ${WhitelistMode[v.whitelistMode]}`);
  console.log(`> Base mint:       ${v.baseMint.toString()}`);
  console.log(`> Quote mint:      ${v.quoteMint.toString()}`);
  console.log(`> Vault authority: ${v.vaultAuthority.toString()}`);
  console.log(`> Activation type: ${ActivationType[v.activationType]}`);
  console.log(`> Depositing point:     ${v.depositingPoint.toString()} (${pointUnit})`);
  console.log(`> Start vesting point:  ${v.startVestingPoint.toString()} (${pointUnit})`);
  console.log(`> End vesting point:    ${v.endVestingPoint.toString()} (${pointUnit})`);

  if (alphaVault.mode === VaultMode.FCFS) {
    console.log(
      `> Max depositing cap (vault-wide):  ${getAmountInTokens(v.maxDepositingCap, quoteDecimals)}`
    );
    console.log(
      `> Individual depositing cap:        ${getAmountInTokens(v.individualDepositingCap, quoteDecimals)}`
    );
  } else {
    console.log(
      `> Max buying cap (vault-wide):       ${getAmountInTokens(v.maxBuyingCap, quoteDecimals)}`
    );
  }
  console.log(`> Total deposited (quote):    ${getAmountInTokens(v.totalDeposit, quoteDecimals)}`);
  console.log(`> Total escrows opened:       ${v.totalEscrow.toString()}`);
  console.log(`> Swapped amount (quote):     ${getAmountInTokens(v.swappedAmount, quoteDecimals)}`);
  console.log(`> Bought token (base):        ${getAmountInTokens(v.boughtToken, baseDecimals)}`);
  console.log(`> Total refunded (quote):     ${getAmountInTokens(v.totalRefund, quoteDecimals)}`);
  console.log(
    `> Total claimed (base):       ${getAmountInTokens(v.totalClaimedToken, baseDecimals)}`
  );
  console.log(`> Escrow fee (quote):         ${getAmountInTokens(v.escrowFee, quoteDecimals)}`);
  console.log(
    `> Total escrow fees collected (quote): ${getAmountInTokens(v.totalEscrowFee, quoteDecimals)}`
  );

  if (!walletPubkey) {
    return;
  }

  console.log(`\n> Wallet: ${walletPubkey.toString()}`);
  const escrow = await alphaVault.getEscrow(walletPubkey);
  if (!escrow) {
    console.log('> No escrow found for this wallet on this vault (it has not deposited yet).');
  }

  // Merkle-gated vaults need the proof to correctly report isWhitelisted/canDeposit/
  // availableQuota below — fetch it the same way alpha-vault-deposit does. getMerkleProofForDeposit
  // never throws (it swallows fetch errors internally and resolves to null), so no try/catch needed.
  const merkleProof =
    v.whitelistMode === WhitelistMode.PermissionWithMerkleProof
      ? await alphaVault.getMerkleProofForDeposit(walletPubkey)
      : null;

  const state = await alphaVault.interactionState(escrow, merkleProof);

  console.log(`> isWhitelisted:                 ${state.isWhitelisted}`);
  console.log(`> canDeposit:                    ${state.canDeposit}`);
  console.log(`> canWithdraw:                   ${state.canWithdraw}`);
  console.log(`> canWithdrawDepositOverflow:    ${state.canWithdrawDepositOverflow}`);
  console.log(`> canWithdrawRemainingQuote:     ${state.canWithdrawRemainingQuote}`);
  console.log(`> canClaim:                      ${state.canClaim}`);
  console.log(`> hadDeposited:                  ${state.hadDeposited}`);
  console.log(`> hadClaimed:                    ${state.hadClaimed}`);
  console.log(`> hadWithdrawnRemainingQuote:    ${state.hadWithdrawnRemainingQuote}`);
  console.log(
    `> Available deposit quota (quote):    ${formatAlphaVaultAmount(state.availableQuota, quoteDecimals)}`
  );
  console.log(
    `> Available deposit overflow (quote): ${getAmountInTokens(state.availableDepositOverflow, quoteDecimals)}`
  );
  console.log(
    `> Deposit info — total (quote):    ${getAmountInTokens(state.depositInfo.totalDeposit, quoteDecimals)}`
  );
  console.log(
    `> Deposit info — filled (quote):   ${getAmountInTokens(state.depositInfo.totalFilled, quoteDecimals)}`
  );
  console.log(
    `> Deposit info — returned (quote): ${getAmountInTokens(state.depositInfo.totalReturned, quoteDecimals)}`
  );
  console.log(
    `> Claim info — allocated (base):   ${getAmountInTokens(state.claimInfo.totalAllocated, baseDecimals)}`
  );
  console.log(
    `> Claim info — claimed (base):     ${getAmountInTokens(state.claimInfo.totalClaimed, baseDecimals)}`
  );
  console.log(
    `> Claim info — claimable (base):   ${getAmountInTokens(state.claimInfo.totalClaimable, baseDecimals)}`
  );
}
