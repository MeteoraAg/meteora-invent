import { Connection, PublicKey, Transaction, sendAndConfirmTransaction } from '@solana/web3.js';
import { Wallet } from '@coral-xyz/anchor';
import { PoolFarmImpl } from '@meteora-ag/farming-sdk';
import {
  getAccount,
  getAssociatedTokenAddressSync,
  getMint,
  TOKEN_PROGRAM_ID,
  TokenAccountNotFoundError,
  TokenInvalidAccountOwnerError,
} from '@solana/spl-token';
import BN from 'bn.js';
import { FarmingConfig } from '../../utils/types';
import {
  getAmountInLamports,
  getAmountInTokens,
  modifyComputeUnitPriceIx,
  runSimulateTransaction,
} from '../../helpers';
import { DEFAULT_SEND_TX_MAX_RETRIES } from '../../utils/constants';
import { guessFarmingCluster, loadFarm, getSafeFarmUserState } from './status';

/**
 * 0-SOL fee-payer guard, shared by every write action below — matches the
 * dynamic_vault/fee_sharing/stake2earn precedent (even a dry-run simulation needs an
 * existing fee payer account).
 */
async function assertFunded(connection: Connection, payer: PublicKey): Promise<void> {
  const balance = await connection.getBalance(payer);
  if (balance === 0) {
    throw new Error(
      `Wallet ${payer.toString()} has 0 SOL — fund it first; even dry-run simulation requires an existing fee payer account`
    );
  }
}

/**
 * `PoolFarmImpl.deposit`/`withdraw`/`claim` all return a single `Transaction` with
 * `feePayer` and a blockhash ALREADY set (verified against the compiled SDK: each one calls
 * `connection.getLatestBlockhash("finalized")` internally while building the tx — a slower,
 * more-already-aged commitment than the "confirmed" this codebase sends with elsewhere). By
 * the time our own pre-checks/prompts above run, that blockhash may already be a meaningful
 * fraction of the way through its validity window, so it is unconditionally refreshed here
 * right before simulate-or-send rather than trusted as-is.
 */
async function refreshBlockhash(
  connection: Connection,
  tx: Transaction,
  feePayer: PublicKey
): Promise<void> {
  const { blockhash, lastValidBlockHeight } = await connection.getLatestBlockhash(
    connection.commitment ?? 'confirmed'
  );
  tx.recentBlockhash = blockhash;
  tx.lastValidBlockHeight = lastValidBlockHeight;
  tx.feePayer = feePayer;
}

/** Shared simulate-or-send tail used by every Pool Farm user-op below. */
async function simulateOrSend(
  connection: Connection,
  wallet: Wallet,
  dryRun: boolean,
  tx: Transaction,
  label: string
): Promise<void> {
  if (dryRun) {
    console.log(`\n> Simulating ${label} transaction...`);
    await runSimulateTransaction(connection, [wallet.payer], wallet.publicKey, [tx]);
    console.log(`> ${label} simulation successful`);
  } else {
    console.log(`\n>> Sending ${label} transaction...`);
    const txHash = await sendAndConfirmTransaction(connection, tx, [wallet.payer], {
      commitment: connection.commitment,
      maxRetries: DEFAULT_SEND_TX_MAX_RETRIES,
    });
    console.log(`>>> ${label} succeeded with tx hash: ${txHash}`);
  }
}

/**
 * Confirm `owner` holds at least `amountLamports` of `mint` in its associated token account.
 * DAMM v1 LP mints (what every Pool Farm stakes) are always classic Token Program mints — the
 * farming program's IDL hardcodes `tokenProgram` on every instruction (never parameterized for
 * Token-2022, verified against the installed IDL) — so unlike zap/fee_sharing there is no
 * owner-program detection or native-SOL wrap branch to handle here.
 */
async function assertHoldsAtLeast(
  connection: Connection,
  owner: PublicKey,
  mint: PublicKey,
  amountLamports: BN,
  decimals: number,
  humanAmount: number,
  verb: string
): Promise<void> {
  const ata = getAssociatedTokenAddressSync(mint, owner, true, TOKEN_PROGRAM_ID);
  let balance = new BN(0);
  try {
    const account = await getAccount(connection, ata, connection.commitment);
    balance = new BN(account.amount.toString());
  } catch (error) {
    if (
      !(error instanceof TokenAccountNotFoundError) &&
      !(error instanceof TokenInvalidAccountOwnerError)
    ) {
      throw error;
    }
  }
  if (balance.lt(amountLamports)) {
    throw new Error(
      `Wallet ${owner.toString()} holds ${getAmountInTokens(balance, decimals)} of the staking ` +
        `mint ${mint.toString()} but ${verb} ${humanAmount} needs ` +
        `${getAmountInTokens(amountLamports, decimals)} — fund the wallet's LP token account first.`
    );
  }
}

/**
 * Stake DAMM v1 LP tokens into `farm`. Reads config.farmStake.amount (staking-mint human
 * units, converted via the mint's own decimals — `farm.poolState.stakingMint` -> `getMint`).
 * `PoolFarmImpl.deposit()` already creates the caller's `user` account inline on first use
 * (verified against the compiled SDK's `createUserInstruction` — despite calling the SDK's own
 * buggy `getUserState` internally, its call chain happens to resolve the correct address in
 * THIS one call path, so first-time stakers are safe going through `deposit()` itself; see
 * `getSafeFarmUserState` in `status.ts` for why nothing here relies on that bug-for-bug
 * accident directly), so no separate account-init step or extra transaction is needed.
 */
export async function stake(
  config: FarmingConfig,
  connection: Connection,
  wallet: Wallet,
  farm: PublicKey
): Promise<void> {
  if (!config.farmStake) {
    throw new Error('Missing farmStake in configuration');
  }
  const { amount } = config.farmStake;
  if (!(amount > 0)) {
    throw new Error(`farmStake.amount must be > 0 (got ${amount})`);
  }

  console.log('\n> Initializing Pool Farm stake...');
  await assertFunded(connection, wallet.publicKey);

  const cluster = guessFarmingCluster(config.rpcUrl);
  const farmImpl = await loadFarm(connection, farm, cluster);
  const pool = farmImpl.poolState;
  const decimals = (await getMint(connection, pool.stakingMint, connection.commitment)).decimals;

  console.log(`- Farm ${farm.toString()}`);
  console.log(`- Staking mint (DAMM v1 LP) ${pool.stakingMint.toString()} (${decimals} decimals)`);

  // Never-staked-safe: uses the safe fetch (getUserPda + direct program.account.user read),
  // NOT the SDK's own getUserBalance/getUserState (both buggy — see status.ts).
  const existing = await getSafeFarmUserState(farmImpl, wallet.publicKey);
  if (existing) {
    console.log(`- Existing staked amount: ${getAmountInTokens(existing.balanceStaked, decimals)}`);
  } else {
    console.log(
      '- No existing stake for this wallet in this farm — a user account will be created ' +
        'automatically by this transaction.'
    );
  }

  const amountLamports = getAmountInLamports(amount, decimals);
  await assertHoldsAtLeast(
    connection,
    wallet.publicKey,
    pool.stakingMint,
    amountLamports,
    decimals,
    amount,
    'staking'
  );

  console.log(`- Staking ${amount} (${amountLamports.toString()} base units)`);

  const stakeTx = await farmImpl.deposit(wallet.publicKey, amountLamports);
  await refreshBlockhash(connection, stakeTx, wallet.publicKey);
  modifyComputeUnitPriceIx(stakeTx, config.computeUnitPriceMicroLamports ?? 0);

  await simulateOrSend(connection, wallet, config.dryRun, stakeTx, 'stake');
}

/**
 * Unstake DAMM v1 LP tokens from `farm`. Reads config.farmUnstake.amount (staking-mint human
 * units; `null` = unstake everything currently staked). Unlike `deposit()`, the SDK's
 * `withdraw()` does NOT create a `user` account if one is missing — it would fail on-chain
 * against an uninitialized account — so this pre-checks the caller actually has a stake at all
 * via the SAME safe fetch `stake()` uses, refusing clearly instead of sending a doomed tx.
 */
export async function unstake(
  config: FarmingConfig,
  connection: Connection,
  wallet: Wallet,
  farm: PublicKey
): Promise<void> {
  if (!config.farmUnstake) {
    throw new Error('Missing farmUnstake in configuration');
  }
  const { amount } = config.farmUnstake;

  console.log('\n> Initializing Pool Farm unstake...');
  await assertFunded(connection, wallet.publicKey);

  const cluster = guessFarmingCluster(config.rpcUrl);
  const farmImpl = await loadFarm(connection, farm, cluster);
  const pool = farmImpl.poolState;
  const decimals = (await getMint(connection, pool.stakingMint, connection.commitment)).decimals;

  console.log(`- Farm ${farm.toString()}`);

  const userState = await getSafeFarmUserState(farmImpl, wallet.publicKey);
  if (!userState || userState.balanceStaked.isZero()) {
    throw new Error(
      `Wallet ${wallet.publicKey.toString()} has no stake in farm ${farm.toString()} — nothing ` +
        'to unstake. Stake first with farm-stake.'
    );
  }
  console.log(`- Currently staked: ${getAmountInTokens(userState.balanceStaked, decimals)}`);

  let amountLamports: BN;
  if (amount === null || amount === undefined) {
    amountLamports = userState.balanceStaked;
    console.log(
      `- amount omitted (null) -> unstaking everything: ${getAmountInTokens(amountLamports, decimals)}`
    );
  } else {
    if (!(amount > 0)) {
      throw new Error(`farmUnstake.amount must be > 0 or null (got ${amount})`);
    }
    amountLamports = getAmountInLamports(amount, decimals);
    if (amountLamports.gt(userState.balanceStaked)) {
      throw new Error(
        `Requested unstake of ${amount} exceeds the current staked amount of ` +
          `${getAmountInTokens(userState.balanceStaked, decimals)}.`
      );
    }
    console.log(`- Unstaking ${amount} (${amountLamports.toString()} base units)`);
  }

  const unstakeTx = await farmImpl.withdraw(wallet.publicKey, amountLamports);
  await refreshBlockhash(connection, unstakeTx, wallet.publicKey);
  modifyComputeUnitPriceIx(unstakeTx, config.computeUnitPriceMicroLamports ?? 0);

  await simulateOrSend(connection, wallet, config.dryRun, unstakeTx, 'unstake');
}

/**
 * Claim accrued rewards from `farm`. No config block — claims everything currently claimable,
 * computed the same way `farm-get-status` displays it (`PoolFarmImpl.getClaimableRewards`,
 * null-safe for a never-staked wallet on its own) and printed before sending; refuses with a
 * clear message instead of a no-op transaction when both reward sides are zero, or when the
 * wallet has never staked in this farm at all (safe fetch, same as stake/unstake).
 */
export async function claim(
  config: FarmingConfig,
  connection: Connection,
  wallet: Wallet,
  farm: PublicKey
): Promise<void> {
  console.log('\n> Initializing Pool Farm claim...');
  await assertFunded(connection, wallet.publicKey);

  const cluster = guessFarmingCluster(config.rpcUrl);
  const farmImpl = await loadFarm(connection, farm, cluster);
  const pool = farmImpl.poolState;

  console.log(`- Farm ${farm.toString()}`);

  const userState = await getSafeFarmUserState(farmImpl, wallet.publicKey);
  if (!userState) {
    throw new Error(
      `Wallet ${wallet.publicKey.toString()} has no stake in farm ${farm.toString()} — nothing ` +
        'to claim. Stake first with farm-stake.'
    );
  }

  const isSingleSided = pool.rewardAMint.equals(pool.rewardBMint);
  const rewardADecimals = (await getMint(connection, pool.rewardAMint, connection.commitment))
    .decimals;
  const rewardBDecimals = isSingleSided
    ? rewardADecimals
    : (await getMint(connection, pool.rewardBMint, connection.commitment)).decimals;

  const claimableByFarm = await PoolFarmImpl.getClaimableRewards(
    wallet.publicKey,
    [farm],
    connection
  );
  const claimable = claimableByFarm.get(farm.toString());
  const rewardA = claimable?.rewardA ?? new BN(0);
  const rewardB = claimable?.rewardB ?? new BN(0);
  console.log(`- Pending reward A: ${getAmountInTokens(rewardA, rewardADecimals)}`);
  if (!isSingleSided) {
    console.log(`- Pending reward B: ${getAmountInTokens(rewardB, rewardBDecimals)}`);
  }

  if (rewardA.isZero() && rewardB.isZero()) {
    throw new Error(
      `Nothing to claim yet for wallet ${wallet.publicKey.toString()} on farm ${farm.toString()}.`
    );
  }

  const claimTx = await farmImpl.claim(wallet.publicKey);
  await refreshBlockhash(connection, claimTx, wallet.publicKey);
  modifyComputeUnitPriceIx(claimTx, config.computeUnitPriceMicroLamports ?? 0);

  await simulateOrSend(connection, wallet, config.dryRun, claimTx, 'claim');
}
