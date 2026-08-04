import { Connection, PublicKey, Keypair, sendAndConfirmTransaction } from '@solana/web3.js';
import { Wallet } from '@coral-xyz/anchor';
import {
  DynamicFeeSharingClient,
  deriveFeeVaultPdaAddress,
  getTokenProgram,
  checkPositionOwnership,
  setTokenAccountOwnerTx,
  FeeVault,
} from '@meteora-ag/dynamic-fee-sharing-sdk';
import { CpAmm, validateRewardIndex } from '@meteora-ag/cp-amm-sdk';
import { DynamicBondingCurveClient } from '@meteora-ag/dynamic-bonding-curve-sdk';
import {
  getAccount,
  getMint,
  getAssociatedTokenAddressSync,
  TOKEN_2022_PROGRAM_ID,
  TOKEN_PROGRAM_ID,
  TokenAccountNotFoundError,
  TokenInvalidAccountOwnerError,
} from '@solana/spl-token';
import BN from 'bn.js';
import { FeeSharingConfig } from '../../utils/types';
import {
  getAmountInLamports,
  getAmountInTokens,
  modifyComputeUnitPriceIx,
  promptForSelection,
  runSimulateTransaction,
} from '../../helpers';
import {
  DEFAULT_COMMITMENT_LEVEL,
  DEFAULT_SEND_TX_MAX_RETRIES,
  SOL_TOKEN_MINT,
} from '../../utils/constants';
import { loadFeeVault } from './status';

/**
 * 0-SOL fee-payer guard, shared by every write action below. Returns the balance (lamports) so
 * fund() can reuse it for the native-SOL wrap sufficiency check.
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
 * Create a Dynamic Fee Sharing vault for `baseMint` (the token whose fees will be shared).
 * Reads config.feeSharingCreate: `userShares` (2-5 recipients, `share` a relative integer
 * weight — NOT required to sum to 100, docs.md-verified min/max enforced here pre-flight) and
 * `useKeypairVault` (true = createFeeVault, a fresh `feeVault` KEYPAIR co-signs once and IS the
 * vault address; false = createFeeVaultPda, a fresh `base` keypair co-signs once and the vault
 * address is a PDA derived from base + tokenMint). Either way a brand-new keypair is generated
 * in-memory purely to co-sign this one transaction — only the resulting vault ADDRESS matters
 * afterward (logged prominently below), the keypair's secret is never needed again.
 */
export async function createVault(
  config: FeeSharingConfig,
  connection: Connection,
  wallet: Wallet,
  baseMint: PublicKey
) {
  if (!config.feeSharingCreate) {
    throw new Error('Missing feeSharingCreate in configuration');
  }
  const { userShares, useKeypairVault } = config.feeSharingCreate;

  if (!Array.isArray(userShares) || userShares.length === 0) {
    throw new Error('feeSharingCreate.userShares must be a non-empty array');
  }
  if (userShares.length < 2 || userShares.length > 5) {
    throw new Error(
      `feeSharingCreate.userShares has ${userShares.length} entries — the program requires at ` +
        'least 2 and at most 5 recipients per fee vault.'
    );
  }

  const userShare = userShares.map((entry, index) => {
    if (typeof entry.share !== 'number' || !Number.isInteger(entry.share) || entry.share <= 0) {
      throw new Error(
        `feeSharingCreate.userShares[${index}].share must be a positive integer (got ${entry.share}).`
      );
    }
    try {
      return { address: new PublicKey(entry.address), share: entry.share };
    } catch {
      throw new Error(
        `feeSharingCreate.userShares[${index}].address is not a valid public key: ${entry.address}`
      );
    }
  });

  console.log('\n> Initializing Dynamic Fee Sharing vault creation...');
  await assertFunded(connection, wallet.publicKey);

  const mintAccountInfo = await connection.getAccountInfo(baseMint);
  if (!mintAccountInfo) {
    throw new Error(`Base mint account not found: ${baseMint.toString()}`);
  }
  const tokenProgram = mintAccountInfo.owner.equals(TOKEN_2022_PROGRAM_ID)
    ? TOKEN_2022_PROGRAM_ID
    : TOKEN_PROGRAM_ID;

  console.log(`- Base mint ${baseMint.toString()}`);
  console.log(
    `- Token program: ${tokenProgram.equals(TOKEN_2022_PROGRAM_ID) ? 'Token-2022' : 'SPL Token'}`
  );
  console.log(`- Recipients (${userShare.length}):`);
  for (const entry of userShare) {
    console.log(`  - ${entry.address.toString()} : share ${entry.share}`);
  }

  const client = new DynamicFeeSharingClient(connection, DEFAULT_COMMITMENT_LEVEL);

  const coSigner = Keypair.generate();
  const vaultAddress = useKeypairVault
    ? coSigner.publicKey
    : deriveFeeVaultPdaAddress(coSigner.publicKey, baseMint);

  console.log(
    `- Vault variant: ${useKeypairVault ? 'KEYPAIR (fresh feeVault keypair co-signs once)' : 'PDA (fresh base keypair co-signs once)'}`
  );

  const createTx = useKeypairVault
    ? await client.createFeeVault({
        feeVault: vaultAddress,
        tokenMint: baseMint,
        tokenProgram,
        owner: wallet.publicKey,
        payer: wallet.publicKey,
        userShare,
      })
    : await client.createFeeVaultPda({
        base: coSigner.publicKey,
        tokenMint: baseMint,
        tokenProgram,
        owner: wallet.publicKey,
        payer: wallet.publicKey,
        userShare,
      });

  modifyComputeUnitPriceIx(createTx, config.computeUnitPriceMicroLamports ?? 0);

  console.log(`\n>>> FEE VAULT ADDRESS: ${vaultAddress.toString()}`);
  if (config.dryRun) {
    console.log(
      '>>> DRY RUN — this address is a placeholder from a throwaway keypair. A NEW address will'
    );
    console.log('>>> be generated and printed when you run with dryRun=false. Do NOT save it.\n');
  } else {
    console.log('>>> Save this — every other fee-sharing-* action needs it via --vault.\n');
  }

  if (config.dryRun) {
    console.log('> Simulating fee vault creation transaction...');
    await runSimulateTransaction(connection, [wallet.payer, coSigner], wallet.publicKey, [
      createTx,
    ]);
    console.log('> Fee vault creation simulation successful');
  } else {
    console.log('>> Sending fee vault creation transaction...');
    const txHash = await sendAndConfirmTransaction(connection, createTx, [wallet.payer, coSigner], {
      commitment: connection.commitment,
      maxRetries: DEFAULT_SEND_TX_MAX_RETRIES,
    });
    console.log(`>>> Fee vault created successfully with tx hash: ${txHash}`);
    console.log(`>>> FEE VAULT ADDRESS: ${vaultAddress.toString()}`);
  }
}

/**
 * Directly fund a fee vault from the wallet's own token account. Reads config.feeSharingFund.
 * amount (the vault's tokenMint human units, converted via the mint's own decimals). wSOL
 * note (verified against the SDK's compiled `fundFeeVault`): when the vault's tokenMint is
 * native SOL's wrapped mint, the SDK wraps the requested amount of SOL for you internally — no
 * pre-funded wSOL account is needed, only enough actual SOL lamports in the wallet.
 */
export async function fund(
  config: FeeSharingConfig,
  connection: Connection,
  wallet: Wallet,
  vault: PublicKey
) {
  if (!config.feeSharingFund) {
    throw new Error('Missing feeSharingFund in configuration');
  }
  const { amount } = config.feeSharingFund;

  console.log('\n> Initializing Dynamic Fee Sharing fund...');
  const payerBalance = await assertFunded(connection, wallet.publicKey);

  const client = new DynamicFeeSharingClient(connection, DEFAULT_COMMITMENT_LEVEL);
  const feeVaultState = await loadFeeVault(client, vault);
  const tokenProgram = getTokenProgram(feeVaultState.tokenFlag);
  const mint = await getMint(
    connection,
    feeVaultState.tokenMint,
    connection.commitment,
    tokenProgram
  );
  const decimals = mint.decimals;

  console.log(`- Vault ${vault.toString()}`);
  console.log(`- Token mint ${feeVaultState.tokenMint.toString()} (${decimals} decimals)`);

  const amountLamports = getAmountInLamports(amount, decimals);
  const isNativeSol = feeVaultState.tokenMint.equals(SOL_TOKEN_MINT);

  if (isNativeSol) {
    console.log(
      '- Token mint is native SOL (wSOL) — fundFeeVault wraps the requested amount of SOL for ' +
        'you internally; no pre-funded wSOL account is needed.'
    );
    if (payerBalance < Number(amountLamports.toString())) {
      throw new Error(
        `Wallet ${wallet.publicKey.toString()} has ${payerBalance} lamports of SOL but funding ` +
          `${amount} SOL needs ${amountLamports.toString()} lamports to wrap, plus a little more ` +
          'for rent and fees — fund the wallet with more SOL first.'
      );
    }
  } else {
    const funderATA = getAssociatedTokenAddressSync(
      feeVaultState.tokenMint,
      wallet.publicKey,
      true,
      tokenProgram
    );
    let funderBalance = new BN(0);
    try {
      const account = await getAccount(connection, funderATA, connection.commitment, tokenProgram);
      funderBalance = new BN(account.amount.toString());
    } catch (error) {
      if (
        !(error instanceof TokenAccountNotFoundError) &&
        !(error instanceof TokenInvalidAccountOwnerError)
      ) {
        throw error;
      }
    }
    if (funderBalance.lt(amountLamports)) {
      throw new Error(
        `Wallet ${wallet.publicKey.toString()} holds ${getAmountInTokens(funderBalance, decimals)} of mint ` +
          `${feeVaultState.tokenMint.toString()} but funding needs ${amount} — fund the wallet's token account first.`
      );
    }
  }

  console.log(`- Funding ${amount} (${amountLamports.toString()} base units)`);

  const fundTx = await client.fundFeeVault({
    fundAmount: amountLamports,
    feeVault: vault,
    funder: wallet.publicKey,
    feeVaultState,
  });
  modifyComputeUnitPriceIx(fundTx, config.computeUnitPriceMicroLamports ?? 0);

  if (config.dryRun) {
    console.log('\n> Simulating fund transaction...');
    await runSimulateTransaction(connection, [wallet.payer], wallet.publicKey, [fundTx]);
    console.log('> Fund simulation successful');
  } else {
    console.log('\n>> Sending fund transaction...');
    const txHash = await sendAndConfirmTransaction(connection, fundTx, [wallet.payer], {
      commitment: connection.commitment,
      maxRetries: DEFAULT_SEND_TX_MAX_RETRIES,
    });
    console.log(`>>> Funded successfully with tx hash: ${txHash}`);
  }
}

/**
 * Resolve the DAMM v2 position(s) on `poolAddress` whose position-NFT account is owned by
 * `vault` — the shared discovery used by both `fundFromDammV2` and `fundFromDammV2Reward`.
 *
 * Queried via `cpAmm.getUserPositionByPool(poolAddress, vault)`: despite the SDK naming that
 * second param "user", it resolves to a plain `connection.getTokenAccountsByOwner(vault,
 * {programId: TOKEN_2022_PROGRAM_ID})` scan under the hood (verified in the installed SDK's
 * compiled `getAllPositionNftAccountByOwner`) — a read-only RPC filter that works for ANY owner
 * pubkey, including a PDA such as a `createFeeVaultPda` vault, no signature required. Pointed at
 * the vault instead of the wallet, this returns ONLY vault-held position NFTs, without ever
 * touching a wallet-owned one.
 *
 * F1 fix note: the old code queried `getUserPositionByPool(poolAddress, wallet.publicKey)` (the
 * WALLET) and then filtered those results for a position whose NFT account was owned by the
 * VAULT. Since an SPL token account has exactly one owner, those two conditions can never both
 * hold — every input hit one of the two guard errors and `fundByClaimDammV2Fee` was never
 * reached. Fixed by querying the vault directly instead of the wallet.
 *
 * Ownership must already have been transferred to the vault — via
 * `transferDammV2PositionToVault` (action: `fee-sharing-transfer-damm-v2-position`, wraps the
 * SDK's `setTokenAccountOwnerTx`) — before this finds anything. Both `fundByClaimDammV2Fee` and
 * `fundByClaimDammV2Reward` re-verify ownership internally via their own `checkPositionOwnership`
 * call and throw a raw `InvalidPositionOwnership` error if it was never transferred (verified in
 * the SDK's compiled `dfs.ts`); the check below exists only to fail fast with an actionable,
 * vault-naming message instead of that opaque SDK error.
 */
async function findVaultOwnedDammV2Position(
  connection: Connection,
  vault: PublicKey,
  poolAddress: PublicKey
): Promise<{ position: PublicKey; positionNftAccount: PublicKey }> {
  const cpAmm = new CpAmm(connection);
  const vaultPositions = await cpAmm.getUserPositionByPool(poolAddress, vault);

  console.log(`- Pool ${poolAddress.toString()}`);

  if (vaultPositions.length === 0) {
    throw new Error(
      `No DAMM v2 position owned by fee vault ${vault.toString()} on pool ${poolAddress.toString()}. ` +
        'Transfer the position NFT to the vault first — run ' +
        `fee-sharing-transfer-damm-v2-position --vault ${vault.toString()} --poolAddress ${poolAddress.toString()} ` +
        "(wraps the SDK's setTokenAccountOwnerTx) — see studio-actions.md for details."
    );
  }
  console.log(
    `- Found ${vaultPositions.length} position(s) already owned by the fee vault on the pool`
  );

  for (const candidate of vaultPositions) {
    const isOwnedByVault = await checkPositionOwnership(
      connection,
      DEFAULT_COMMITMENT_LEVEL,
      candidate.positionNftAccount,
      vault,
      TOKEN_2022_PROGRAM_ID
    );
    if (isOwnedByVault) {
      return { position: candidate.position, positionNftAccount: candidate.positionNftAccount };
    }
  }

  // Defense-in-depth only: getUserPositionByPool(vault) already filters by vault ownership via
  // getTokenAccountsByOwner, so every candidate above is expected to pass. Reaching here would
  // mean ownership changed between the query and this re-check (e.g. a concurrent transfer out).
  throw new Error(
    `None of the DAMM v2 position NFTs found for fee vault ${vault.toString()} on pool ` +
      `${poolAddress.toString()} passed re-verification — ownership may have changed since the ` +
      `query. Candidate position(s) checked: ${vaultPositions.map((p) => p.position.toString()).join(', ')}`
  );
}

/**
 * `fundByClaimDammV2Fee` and `fundByClaimDammV2Reward` both route through the DFS program's
 * shared `fund_by_claiming_fee` instruction, which enforces two on-chain constraints — verified
 * directly against the program's own Rust source (`ix_fund_by_claiming_fee.rs`), reached via
 * empirical localnet testing after F1's query fix and a real position transfer still hit an
 * on-chain `InvalidSigner` (0x1778) error:
 *   1. `require!(fee_vault.fee_vault_type == 1, FeeVaultError::InvalidFeeVault)` — only
 *      PDA-variant vaults are supported (`feeSharingCreate.useKeypairVault: false` /
 *      `createFeeVaultPda`); a keypair-variant vault (`useKeypairVault: true` / `createFeeVault`)
 *      is rejected outright, regardless of who signs.
 *   2. `require!(fee_vault.is_share_holder(signer), FeeVaultError::InvalidSigner)` — the
 *      transaction's `signer` must be one of the vault's registered `userShare` recipients. The
 *      vault's `owner` field (whoever ran `fee-sharing-create-vault`) is a SEPARATE concept the
 *      program never checks here — being the vault's creator/owner is not sufficient on its own
 *      unless that same wallet is also a recipient.
 * Both are checked here so a mismatched vault fails fast with an actionable message instead of
 * the program's opaque `InvalidFeeVault` / `InvalidSigner` errors.
 */
async function assertVaultSupportsClaimingFeeBridge(
  client: DynamicFeeSharingClient,
  vault: PublicKey,
  feeVaultState: FeeVault,
  signer: PublicKey
): Promise<void> {
  if (feeVaultState.feeVaultType !== 1) {
    throw new Error(
      `Fee vault ${vault.toString()} is a KEYPAIR-variant vault (feeSharingCreate.useKeypairVault: ` +
        'true when it was created) — the on-chain program only supports PDA-variant vaults for ' +
        "the DAMM v2 fee/reward bridges (fee_vault_type must be 1; this is the program's own " +
        'check, not a client-side choice). Create a new vault with useKeypairVault: false ' +
        '(fee-sharing-create-vault) and transfer the position there instead with ' +
        'fee-sharing-transfer-damm-v2-position.'
    );
  }

  const breakdown = await client.getFeeBreakdown(vault);
  const isShareHolder = breakdown.userFees.some((user) => user.address.equals(signer));
  if (!isShareHolder) {
    const shareholders =
      breakdown.userFees.map((user) => user.address.toString()).join(', ') || '(none)';
    throw new Error(
      `Wallet ${signer.toString()} is not a registered shareholder of fee vault ${vault.toString()} ` +
        "— the DAMM v2 fee/reward bridges require the transaction's signer to be one of the " +
        "vault's userShare recipients (the program's own fee_vault.is_share_holder(signer) check). " +
        "Being the vault's owner/creator alone is not enough unless that wallet is also a " +
        `recipient. Registered shareholder(s): ${shareholders}`
    );
  }
}

/**
 * Transfer a DAMM v2 position NFT's token-account ownership from this wallet to a fee vault —
 * the on-chain prerequisite `fee-sharing-fund-from-damm-v2` / `-reward` document but that no
 * studio action actually performed (F1: without it, those two actions were unreachable — every
 * input hit a guard error). Wraps the DFS SDK's own `setTokenAccountOwnerTx(tokenAccount, from,
 * to, tokenProgramId)` (verified in the SDK's own `docs.md` — "Can be used to transfer DAMM v2
 * position NFT to the fee vault" — and its `scripts/fundByClaimDammV2Fee.s.ts` fixture, which
 * performs exactly this transfer before its own fund-from-damm-v2 example runs): a plain SPL
 * Token-2022 `SetAuthority(AccountOwner)` instruction re-pointing the position NFT account's
 * owner. Only the CURRENT owner (this wallet) signs — the new owner (the vault, whether a PDA
 * from `createFeeVaultPda` or a plain keypair address from `createFeeVault`) never needs to sign
 * a SetAuthority instruction that merely names it as the new authority.
 *
 * Resolves the wallet's position(s) on `poolAddress` via `cpAmm.getUserPositionByPool` (same
 * lookup `damm-v2-get-positions` uses) and mirrors `damm_v2`'s `closePosition` disambiguation
 * convention: auto-select when there's exactly one position, otherwise prompt interactively.
 *
 * ONE-WAY DOOR for this CLI: once transferred, only the vault (via the DFS program's own
 * instructions) can move this position again — the wallet can no longer manage it with
 * `damm-v2-*` actions (close, remove liquidity, etc.). Refuses to run if the position's NFT
 * account is already owned by anyone other than this wallet or the target vault.
 */
export async function transferDammV2PositionToVault(
  config: FeeSharingConfig,
  connection: Connection,
  wallet: Wallet,
  vault: PublicKey,
  poolAddress: PublicKey
) {
  console.log('\n> Initializing DAMM v2 position transfer to fee vault...');
  await assertFunded(connection, wallet.publicKey);

  const client = new DynamicFeeSharingClient(connection, DEFAULT_COMMITMENT_LEVEL);
  await loadFeeVault(client, vault);

  const cpAmm = new CpAmm(connection);
  const walletPositions = await cpAmm.getUserPositionByPool(poolAddress, wallet.publicKey);

  console.log(`- Pool ${poolAddress.toString()}`);

  if (walletPositions.length === 0) {
    throw new Error(
      `No DAMM v2 position found for wallet ${wallet.publicKey.toString()} on pool ` +
        `${poolAddress.toString()} — create one first (damm-v2-create-balanced-pool / ` +
        '-one-sided-pool, or damm-v2-add-liquidity on an existing pool).'
    );
  }
  console.log(`- Found ${walletPositions.length} position(s) owned by this wallet on the pool`);

  let chosen: (typeof walletPositions)[number] | undefined;
  if (walletPositions.length === 1) {
    chosen = walletPositions[0];
    console.log('> Only one position found, transferring that position...');
  } else {
    const options = walletPositions.map(
      (p, i) =>
        `Position ${i + 1}: ${p.position.toString()} (NFT account ${p.positionNftAccount.toString()})`
    );
    const selectedIndex = await promptForSelection(
      options,
      'Which position would you like to transfer to the fee vault?'
    );
    chosen = walletPositions[selectedIndex];
  }

  if (!chosen) {
    throw new Error('No position selected');
  }

  console.log(`- Position ${chosen.position.toString()}`);
  console.log(`- Position NFT account ${chosen.positionNftAccount.toString()}`);

  const alreadyOwnedByVault = await checkPositionOwnership(
    connection,
    DEFAULT_COMMITMENT_LEVEL,
    chosen.positionNftAccount,
    vault,
    TOKEN_2022_PROGRAM_ID
  );
  if (alreadyOwnedByVault) {
    console.log(
      `> Position NFT account is already owned by fee vault ${vault.toString()} — nothing to do.`
    );
    return;
  }

  const nftAccountInfo = await getAccount(
    connection,
    chosen.positionNftAccount,
    connection.commitment,
    TOKEN_2022_PROGRAM_ID
  );
  if (!nftAccountInfo.owner.equals(wallet.publicKey)) {
    throw new Error(
      `Position NFT account ${chosen.positionNftAccount.toString()} is owned by ` +
        `${nftAccountInfo.owner.toString()} — not this wallet (${wallet.publicKey.toString()}) and ` +
        `not the target vault (${vault.toString()}). Refusing to transfer an account this wallet doesn't own.`
    );
  }

  console.log(
    `\n> Transferring position NFT account ownership: ${wallet.publicKey.toString()} -> ${vault.toString()}`
  );
  const transferTx = setTokenAccountOwnerTx(
    chosen.positionNftAccount,
    wallet.publicKey,
    vault,
    TOKEN_2022_PROGRAM_ID
  );
  modifyComputeUnitPriceIx(transferTx, config.computeUnitPriceMicroLamports ?? 0);

  if (config.dryRun) {
    console.log('\n> Simulating position-transfer transaction...');
    await runSimulateTransaction(connection, [wallet.payer], wallet.publicKey, [transferTx]);
    console.log('> Position-transfer simulation successful');
    console.log(
      '> DRY RUN — ownership was NOT changed. Re-run with dryRun=false to transfer for real.'
    );
  } else {
    console.log('\n>> Sending position-transfer transaction...');
    const txHash = await sendAndConfirmTransaction(connection, transferTx, [wallet.payer], {
      commitment: connection.commitment,
      maxRetries: DEFAULT_SEND_TX_MAX_RETRIES,
    });
    console.log(
      `>>> Position NFT account ownership transferred successfully with tx hash: ${txHash}`
    );
    console.log(
      `>>> Now run fee-sharing-fund-from-damm-v2 (or -reward) with --vault ${vault.toString()} ` +
        `--poolAddress ${poolAddress.toString()}`
    );
  }
}

/**
 * Fund a fee vault by sweeping fees straight out of a DAMM v2 position (`fundByClaimDammV2Fee`).
 * Resolves the vault's position via `findVaultOwnedDammV2Position` (queries
 * `cpAmm.getUserPositionByPool` targeted at the VAULT, not the wallet — see that function's
 * comment for the F1 fix this replaced). Ownership must already have been transferred to the
 * vault first with `fee-sharing-transfer-damm-v2-position` — if no candidate position qualifies,
 * this throws a clear, actionable error naming the vault instead of attempting a doomed
 * transaction.
 */
export async function fundFromDammV2(
  config: FeeSharingConfig,
  connection: Connection,
  wallet: Wallet,
  vault: PublicKey,
  poolAddress: PublicKey
) {
  console.log('\n> Initializing Dynamic Fee Sharing fund-from-DAMM-v2...');
  await assertFunded(connection, wallet.publicKey);

  const client = new DynamicFeeSharingClient(connection, DEFAULT_COMMITMENT_LEVEL);
  const feeVaultState = await loadFeeVault(client, vault);
  await assertVaultSupportsClaimingFeeBridge(client, vault, feeVaultState, wallet.publicKey);

  const { position, positionNftAccount } = await findVaultOwnedDammV2Position(
    connection,
    vault,
    poolAddress
  );

  console.log(
    `- Position ${position.toString()} (NFT account ${positionNftAccount.toString()}) is owned ` +
      'by the fee vault — sweeping its fees in'
  );

  const fundTx = await client.fundByClaimDammV2Fee({
    signer: wallet.publicKey,
    owner: wallet.publicKey,
    feeVault: vault,
    dammV2Pool: poolAddress,
    dammV2Position: position,
    dammV2PositionNftAccount: positionNftAccount,
  });
  modifyComputeUnitPriceIx(fundTx, config.computeUnitPriceMicroLamports ?? 0);

  if (config.dryRun) {
    console.log('\n> Simulating fund-from-DAMM-v2 transaction...');
    await runSimulateTransaction(connection, [wallet.payer], wallet.publicKey, [fundTx]);
    console.log('> Fund-from-DAMM-v2 simulation successful');
  } else {
    console.log('\n>> Sending fund-from-DAMM-v2 transaction...');
    const txHash = await sendAndConfirmTransaction(connection, fundTx, [wallet.payer], {
      commitment: connection.commitment,
      maxRetries: DEFAULT_SEND_TX_MAX_RETRIES,
    });
    console.log(`>>> Funded from DAMM v2 successfully with tx hash: ${txHash}`);
  }
}

/**
 * Fund a fee vault by sweeping a DAMM v2 position's REWARD emissions (`fundByClaimDammV2Reward`)
 * — distinct from `fundFromDammV2`'s trading fees. M4: direct analog of `fundFromDammV2`, reusing
 * the same vault-owned-position discovery (`findVaultOwnedDammV2Position`); the only extra input
 * is `feeSharingFundDammV2Reward.rewardIndex` (DAMM v2 pools have 2 reward slots, so 0 or 1).
 *
 * Validated pre-flight two ways before the SDK call: `validateRewardIndex` (bounds check,
 * cp-amm-sdk) and an `initialized` check on the pool's own reward-slot state — the SDK itself
 * indexes `poolState.rewardInfos[rewardIndex]` with no bounds/initialized check of its own
 * (verified in its compiled `dfs.ts`), so an uninitialized or out-of-range index would otherwise
 * fail deep inside the SDK with an opaque error instead of a clear one here.
 */
export async function fundFromDammV2Reward(
  config: FeeSharingConfig,
  connection: Connection,
  wallet: Wallet,
  vault: PublicKey,
  poolAddress: PublicKey
) {
  if (!config.feeSharingFundDammV2Reward) {
    throw new Error('Missing feeSharingFundDammV2Reward in configuration');
  }
  const { rewardIndex } = config.feeSharingFundDammV2Reward;
  validateRewardIndex(rewardIndex);

  console.log('\n> Initializing Dynamic Fee Sharing fund-from-DAMM-v2-reward...');
  await assertFunded(connection, wallet.publicKey);

  const client = new DynamicFeeSharingClient(connection, DEFAULT_COMMITMENT_LEVEL);
  const feeVaultState = await loadFeeVault(client, vault);
  await assertVaultSupportsClaimingFeeBridge(client, vault, feeVaultState, wallet.publicKey);

  const { position, positionNftAccount } = await findVaultOwnedDammV2Position(
    connection,
    vault,
    poolAddress
  );

  const cpAmm = new CpAmm(connection);
  const poolState = await cpAmm.fetchPoolState(poolAddress);
  const rewardInfo = poolState.rewardInfos[rewardIndex];
  if (!rewardInfo || !rewardInfo.initialized) {
    throw new Error(
      `Reward index ${rewardIndex} is not initialized on pool ${poolAddress.toString()} — pick ` +
        'an initialized reward index or double check feeSharingFundDammV2Reward.rewardIndex.'
    );
  }

  console.log(
    `- Position ${position.toString()} (NFT account ${positionNftAccount.toString()}) is owned ` +
      `by the fee vault — sweeping reward index ${rewardIndex} (mint ${rewardInfo.mint.toString()}) in`
  );

  const fundTx = await client.fundByClaimDammV2Reward({
    signer: wallet.publicKey,
    rewardIndex,
    feeVault: vault,
    dammV2Pool: poolAddress,
    dammV2Position: position,
    dammV2PositionNftAccount: positionNftAccount,
  });
  modifyComputeUnitPriceIx(fundTx, config.computeUnitPriceMicroLamports ?? 0);

  if (config.dryRun) {
    console.log('\n> Simulating fund-from-DAMM-v2-reward transaction...');
    await runSimulateTransaction(connection, [wallet.payer], wallet.publicKey, [fundTx]);
    console.log('> Fund-from-DAMM-v2-reward simulation successful');
  } else {
    console.log('\n>> Sending fund-from-DAMM-v2-reward transaction...');
    const txHash = await sendAndConfirmTransaction(connection, fundTx, [wallet.payer], {
      commitment: connection.commitment,
      maxRetries: DEFAULT_SEND_TX_MAX_RETRIES,
    });
    console.log(`>>> Funded from DAMM v2 reward successfully with tx hash: ${txHash}`);
  }
}

/**
 * Fund a fee vault by sweeping fees out of a DBC pool. Reads config.feeSharingFundDbc: `role`
 * ("creator" | "partner") x `source` ("tradingFee" | "surplus" | "migrationFee") routes to the
 * matching bridge — ALWAYS the `2`-suffixed trading-fee variants
 * (`fundByClaimDbcCreatorTradingFee2` / `fundByClaimDbcPartnerTradingFee2`), never the
 * unsuffixed ones. The DBC pool is resolved from `baseMint` via
 * `DynamicBondingCurveClient.state.getPoolByBaseMint`, mirroring `lib/dbc`. The fee vault must
 * already be set as the pool config's creator (role "creator") or feeClaimer (role "partner")
 * — the SDK itself validates this and throws a clear `InvalidCreator` / `InvalidFeeClaimer`
 * error otherwise.
 */
export async function fundFromDbc(
  config: FeeSharingConfig,
  connection: Connection,
  wallet: Wallet,
  vault: PublicKey,
  baseMint: PublicKey
) {
  if (!config.feeSharingFundDbc) {
    throw new Error('Missing feeSharingFundDbc in configuration');
  }
  const { role, source } = config.feeSharingFundDbc;
  if (role !== 'creator' && role !== 'partner') {
    throw new Error(`feeSharingFundDbc.role must be "creator" or "partner" (got "${role}")`);
  }
  if (source !== 'tradingFee' && source !== 'surplus' && source !== 'migrationFee') {
    throw new Error(
      `feeSharingFundDbc.source must be "tradingFee", "surplus", or "migrationFee" (got "${source}")`
    );
  }

  console.log('\n> Initializing Dynamic Fee Sharing fund-from-DBC...');
  await assertFunded(connection, wallet.publicKey);

  const client = new DynamicFeeSharingClient(connection, DEFAULT_COMMITMENT_LEVEL);
  await loadFeeVault(client, vault);

  const dbcClient = new DynamicBondingCurveClient(connection, DEFAULT_COMMITMENT_LEVEL);
  const pool = await dbcClient.state.getPoolByBaseMint(baseMint);
  if (!pool) {
    throw new Error(`No DBC pool found for base mint ${baseMint.toString()}`);
  }
  const virtualPool = pool.publicKey;
  const poolConfig = pool.account.poolState.config;

  console.log(`- DBC pool ${virtualPool.toString()}`);
  console.log(`- DBC pool config ${poolConfig.toString()}`);
  console.log(`- Role: ${role} | Source: ${source}`);

  let fundTx;
  if (source === 'tradingFee') {
    fundTx =
      role === 'creator'
        ? await client.fundByClaimDbcCreatorTradingFee2({
            signer: wallet.publicKey,
            creator: wallet.publicKey,
            feeVault: vault,
            poolConfig,
            virtualPool,
          })
        : await client.fundByClaimDbcPartnerTradingFee2({
            signer: wallet.publicKey,
            feeClaimer: wallet.publicKey,
            feeVault: vault,
            poolConfig,
            virtualPool,
          });
  } else if (source === 'surplus') {
    fundTx =
      role === 'creator'
        ? await client.fundByWithdrawDbcCreatorSurplus({
            signer: wallet.publicKey,
            feeVault: vault,
            poolConfig,
            virtualPool,
          })
        : await client.fundByWithdrawDbcPartnerSurplus({
            signer: wallet.publicKey,
            feeVault: vault,
            poolConfig,
            virtualPool,
          });
  } else {
    fundTx = await client.fundByWithdrawDbcMigrationFee({
      signer: wallet.publicKey,
      isPartner: role === 'partner',
      feeVault: vault,
      poolConfig,
      virtualPool,
    });
  }

  modifyComputeUnitPriceIx(fundTx, config.computeUnitPriceMicroLamports ?? 0);

  if (config.dryRun) {
    console.log('\n> Simulating fund-from-DBC transaction...');
    await runSimulateTransaction(connection, [wallet.payer], wallet.publicKey, [fundTx]);
    console.log('> Fund-from-DBC simulation successful');
  } else {
    console.log('\n>> Sending fund-from-DBC transaction...');
    const txHash = await sendAndConfirmTransaction(connection, fundTx, [wallet.payer], {
      commitment: connection.commitment,
      maxRetries: DEFAULT_SEND_TX_MAX_RETRIES,
    });
    console.log(`>>> Funded from DBC successfully with tx hash: ${txHash}`);
  }
}

/**
 * Claim the wallet's own share of a fee vault via `claimUserFee2` (receiver = the wallet; the
 * `2`-variant's receiver does not need to sign, unlike `claimUserFee`). Prints the wallet's
 * allocated/claimed/claimable amounts first and refuses to send a pointless transaction when
 * nothing is claimable yet.
 */
export async function claim(
  config: FeeSharingConfig,
  connection: Connection,
  wallet: Wallet,
  vault: PublicKey
) {
  console.log('\n> Initializing Dynamic Fee Sharing claim...');
  await assertFunded(connection, wallet.publicKey);

  const client = new DynamicFeeSharingClient(connection, DEFAULT_COMMITMENT_LEVEL);
  const feeVaultState = await loadFeeVault(client, vault);
  const tokenProgram = getTokenProgram(feeVaultState.tokenFlag);
  const mint = await getMint(
    connection,
    feeVaultState.tokenMint,
    connection.commitment,
    tokenProgram
  );
  const decimals = mint.decimals;

  console.log(`- Vault ${vault.toString()}`);

  const breakdown = await client.getFeeBreakdown(vault);
  const userRow = breakdown.userFees.find((user) => user.address.equals(wallet.publicKey));
  if (!userRow) {
    throw new Error(
      `Wallet ${wallet.publicKey.toString()} does not hold a share in fee vault ${vault.toString()}.`
    );
  }

  console.log(`- Total allocated: ${getAmountInTokens(userRow.totalFee, decimals)}`);
  console.log(`- Already claimed: ${getAmountInTokens(userRow.feeClaimed, decimals)}`);
  console.log(`- Claimable now:   ${getAmountInTokens(userRow.feeUnclaimed, decimals)}`);

  if (userRow.feeUnclaimed.lten(0)) {
    throw new Error(`Nothing to claim right now for wallet ${wallet.publicKey.toString()}.`);
  }

  const claimTx = await client.claimUserFee2({
    feeVault: vault,
    user: wallet.publicKey,
    payer: wallet.publicKey,
    receiver: wallet.publicKey,
  });
  modifyComputeUnitPriceIx(claimTx, config.computeUnitPriceMicroLamports ?? 0);

  if (config.dryRun) {
    console.log('\n> Simulating claim transaction...');
    await runSimulateTransaction(connection, [wallet.payer], wallet.publicKey, [claimTx]);
    console.log('> Claim simulation successful');
  } else {
    console.log('\n>> Sending claim transaction...');
    const txHash = await sendAndConfirmTransaction(connection, claimTx, [wallet.payer], {
      commitment: connection.commitment,
      maxRetries: DEFAULT_SEND_TX_MAX_RETRIES,
    });
    console.log(`>>> Claimed successfully with tx hash: ${txHash}`);
  }
}
