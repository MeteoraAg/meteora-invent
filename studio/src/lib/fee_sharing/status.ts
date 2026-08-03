import { Connection, PublicKey } from '@solana/web3.js';
import {
  DynamicFeeSharingClient,
  FeeVault,
  getTokenProgram,
} from '@meteora-ag/dynamic-fee-sharing-sdk';
import { getMint } from '@solana/spl-token';
import { getAmountInTokens } from '../../helpers';
import { DEFAULT_COMMITMENT_LEVEL } from '../../utils/constants';

/**
 * Fetch a fee vault's on-chain state. `getFeeVault` is typed as returning `FeeVault` (never
 * null), but is actually built on Anchor's `fetchNullable` under the hood (verified against
 * the installed package's compiled `getAccountData` helper) — it resolves to `null` for a
 * missing account despite the `.d.ts`. Caught here and re-thrown with a clear message instead
 * of a bare TypeError bubbling up from the first downstream `.tokenMint` access.
 */
export async function loadFeeVault(
  client: DynamicFeeSharingClient,
  feeVault: PublicKey
): Promise<FeeVault> {
  const state = await client.getFeeVault(feeVault);
  if (!state) {
    throw new Error(
      `No fee vault found at ${feeVault.toString()} — double-check the --vault address (create ` +
        'one first with fee-sharing-create-vault).'
    );
  }
  return state;
}

/**
 * Print the status of a Dynamic Fee Sharing vault (read-only, no keypair required to inspect a
 * known --vault; a wallet is only used to also highlight its own row / do the reverse lookup):
 * - with `vault`: vault header + getFeeBreakdown totals + a per-user shares/claimed/unclaimed
 *   table.
 * - without `vault` but with `wallet`: reverse-lookup every vault the wallet holds a share in
 *   via getRecipientDfsVault and list them (re-run with --vault for the full breakdown).
 */
export async function getStatus(
  connection: Connection,
  vault?: PublicKey,
  wallet?: PublicKey
): Promise<void> {
  const client = new DynamicFeeSharingClient(connection, DEFAULT_COMMITMENT_LEVEL);

  if (vault) {
    const state = await loadFeeVault(client, vault);
    const tokenProgram = getTokenProgram(state.tokenFlag);
    const mint = await getMint(connection, state.tokenMint, connection.commitment, tokenProgram);
    const decimals = mint.decimals;

    console.log(`\n> Fee vault:   ${vault.toString()}`);
    console.log(`> Owner:       ${state.owner.toString()}`);
    console.log(`> Token mint:  ${state.tokenMint.toString()} (${decimals} decimals)`);
    console.log(`> Token vault: ${state.tokenVault.toString()}`);
    console.log(`> Total share: ${state.totalShare}`);

    const breakdown = await client.getFeeBreakdown(vault);
    console.log(
      `\n> Total funded:    ${getAmountInTokens(breakdown.totalFundedFee, decimals)} (${breakdown.totalFundedFee.toString()} base units)`
    );
    console.log(
      `> Total claimed:   ${getAmountInTokens(breakdown.totalClaimedFee, decimals)} (${breakdown.totalClaimedFee.toString()} base units)`
    );
    console.log(
      `> Total unclaimed: ${getAmountInTokens(breakdown.totalUnclaimedFee, decimals)} (${breakdown.totalUnclaimedFee.toString()} base units)`
    );

    console.log('\n> Per-user breakdown (share / total / claimed / unclaimed):');
    if (breakdown.userFees.length === 0) {
      console.log('  (no users with a non-zero share)');
    }
    for (const user of breakdown.userFees) {
      const marker = wallet && user.address.equals(wallet) ? '  <- this wallet' : '';
      console.log(
        `  - ${user.address.toString()} | ` +
          `total=${getAmountInTokens(user.totalFee, decimals)} | ` +
          `claimed=${getAmountInTokens(user.feeClaimed, decimals)} | ` +
          `unclaimed=${getAmountInTokens(user.feeUnclaimed, decimals)}${marker}`
      );
    }
    return;
  }

  if (!wallet) {
    throw new Error(
      'Provide --vault to inspect a specific fee vault, or configure a usable keypairFilePath ' +
        'so this can reverse-lookup vaults by wallet.'
    );
  }

  console.log(`\n> Wallet: ${wallet.toString()}`);
  const vaults = await client.getRecipientDfsVault(wallet);
  if (vaults.length === 0) {
    console.log('> No fee vaults found where this wallet holds a share.');
    return;
  }

  console.log(`> Found ${vaults.length} fee vault(s) where this wallet holds a share:`);
  for (const v of vaults) {
    console.log(`  - ${v.toString()}`);
  }
  console.log(
    '\n> Re-run with --vault <ADDRESS> for the full per-user breakdown of any vault above.'
  );
}
