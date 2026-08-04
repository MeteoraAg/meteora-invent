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

/** 0-SOL fee-payer guard, shared by every write action below; a dry-run still needs an existing fee payer account. */
async function assertFunded(connection: Connection, payer: PublicKey): Promise<void> {
  const balance = await connection.getBalance(payer);
  if (balance === 0) {
    throw new Error(
      `Wallet ${payer.toString()} has 0 SOL — fund it first; even dry-run simulation requires an existing fee payer account`
    );
  }
}

/** `deposit`/`withdraw`/`claim` already set a blockhash (via a "finalized" commitment) when building the tx; refreshed here since it may be stale by send time. */
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
 * The farming program's IDL hardcodes the classic Token Program (never Token-2022), so there is no owner-program detection or native-SOL wrap branch here.
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
 * Stake DAMM v1 LP tokens into `farm`. Reads config.farmStake.amount (staking-mint human units).
 * `PoolFarmImpl.deposit()` creates the caller's `user` account inline on first use, so no separate account-init step is needed.
 * @param config - The farming config
 * @param connection - The connection to the network
 * @param wallet - The wallet that owns and pays for the stake
 * @param farm - The Pool Farm address
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
 * Unstake DAMM v1 LP tokens from `farm`. Reads config.farmUnstake.amount (staking-mint human units; `null` unstakes everything currently staked).
 * Unlike `deposit()`, the SDK's `withdraw()` does not create a `user` account if one is missing, so this pre-checks the caller has a stake before sending.
 * @param config - The farming config
 * @param connection - The connection to the network
 * @param wallet - The wallet that owns the stake
 * @param farm - The Pool Farm address
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
 * Claim accrued rewards from `farm`. No config block — claims everything currently claimable, and refuses instead of sending a no-op transaction when nothing is pending.
 * @param config - The farming config
 * @param connection - The connection to the network
 * @param wallet - The wallet claiming rewards
 * @param farm - The Pool Farm address
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

/**
 * Batch-claim rewards across every farm in config.farmClaimAll.farms (farm addresses, not staking-mint/LP addresses).
 * Each chunk of up to MAX_CLAIM_ALL_ALLOWED (2) farms is an independent transaction, so chunks can be simulated or sent without depending on one another.
 * Reward amounts here are printed in raw base units, not human units.
 * @param config - The farming config
 * @param connection - The connection to the network
 * @param wallet - The wallet claiming rewards
 */
export async function claimAll(config: FarmingConfig, connection: Connection, wallet: Wallet) {
  if (!config.farmClaimAll || config.farmClaimAll.farms.length === 0) {
    throw new Error(
      'Missing farmClaimAll.farms in configuration (needs at least one farm address)'
    );
  }

  console.log('\n> Initializing Pool Farm claim-all...');
  await assertFunded(connection, wallet.publicKey);

  const farms = config.farmClaimAll.farms.map((farm) => new PublicKey(farm));
  console.log(`- Farms (${farms.length}): ${farms.map((farm) => farm.toString()).join(', ')}`);

  const claimableByFarm = await PoolFarmImpl.getClaimableRewards(
    wallet.publicKey,
    farms,
    connection
  );
  let anyClaimable = false;
  for (const farm of farms) {
    const claimable = claimableByFarm.get(farm.toString());
    const rewardA = claimable?.rewardA ?? new BN(0);
    const rewardB = claimable?.rewardB ?? new BN(0);
    if (!rewardA.isZero() || !rewardB.isZero()) {
      anyClaimable = true;
    }
    console.log(
      `  - ${farm.toString()}: reward A raw ${rewardA.toString()}, reward B raw ${rewardB.toString()}` +
        (rewardA.isZero() && rewardB.isZero() ? ' (nothing pending)' : '')
    );
  }
  if (!anyClaimable) {
    throw new Error(
      `Nothing to claim yet for wallet ${wallet.publicKey.toString()} across the ${farms.length} ` +
        'farm(s) in farmClaimAll.farms.'
    );
  }

  const cluster = guessFarmingCluster(config.rpcUrl);
  const claimAllTxs = await PoolFarmImpl.claimAll(connection, wallet.publicKey, farms, {
    cluster,
  });
  console.log(`- SDK batched this into ${claimAllTxs.length} transaction(s) (max 2 farms per tx)`);

  for (let i = 0; i < claimAllTxs.length; i++) {
    const tx = claimAllTxs[i]!;
    await refreshBlockhash(connection, tx, wallet.publicKey);
    modifyComputeUnitPriceIx(tx, config.computeUnitPriceMicroLamports ?? 0);
    await simulateOrSend(
      connection,
      wallet,
      config.dryRun,
      tx,
      `claim-all (${i + 1}/${claimAllTxs.length})`
    );
  }
}
