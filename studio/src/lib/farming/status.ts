import { PoolFarmImpl, FARM_PROGRAM_ID, FARMING_API_ENDPOINT } from '@meteora-ag/farming-sdk';
import { Connection, PublicKey } from '@solana/web3.js';
import { getMint } from '@solana/spl-token';
import BN from 'bn.js';
import { getAmountInTokens } from '../../helpers';

/** The only clusters `FARMING_API_ENDPOINT` covers; `--poolAddress` REST resolution has no localnet/testnet fallback. */
export type FarmingRestCluster = 'devnet' | 'mainnet-beta';

export interface FarmSelector {
  farm?: PublicKey;
  poolAddress?: PublicKey;
}

/** Shape of the farming program's `user` IDL account; the SDK exposes no safe fetch for it, see `getSafeFarmUserState`. */
export interface FarmUserAccount {
  pool: PublicKey;
  owner: PublicKey;
  rewardAPerTokenComplete: BN;
  rewardBPerTokenComplete: BN;
  rewardAPerTokenPending: BN;
  rewardBPerTokenPending: BN;
  balanceStaked: BN;
  nonce: number;
}

/** Guess devnet vs mainnet-beta for `rpcUrl`, for `--poolAddress` REST resolution only (`--farm` bypasses this). */
export function guessFarmingCluster(rpcUrl: string): FarmingRestCluster {
  return rpcUrl.includes('devnet') ? 'devnet' : 'mainnet-beta';
}

/** Load a `PoolFarmImpl` for `farm`, with a clearer error than the SDK's bare `"No pool state found"`. */
export async function loadFarm(
  connection: Connection,
  farm: PublicKey,
  cluster?: FarmingRestCluster
): Promise<PoolFarmImpl> {
  try {
    return await PoolFarmImpl.create(connection, farm, cluster ? { cluster } : undefined);
  } catch (error) {
    throw new Error(
      `No Pool Farm found at ${farm.toString()} (program ${FARM_PROGRAM_ID.toString()}). ` +
        `Double-check the farm address, or resolve it with --poolAddress instead. ` +
        `${error instanceof Error ? error.message : String(error)}`
    );
  }
}

/**
 * Resolve a farm address from `--farm`, or from `--poolAddress` via the REST API — there is no
 * on-chain PDA derivation from just the DAMM v1 pool address. A pool with more than one farm is
 * listed rather than picked automatically, since farms on the same pool can pay different reward
 * tokens.
 * @param selector - The `--farm`/`--poolAddress` selector
 * @param cluster - Farming REST cluster override
 * @returns The resolved farm address
 */
export async function resolveFarmAddress(
  selector: FarmSelector,
  cluster?: FarmingRestCluster
): Promise<PublicKey> {
  if (selector.farm) {
    return selector.farm;
  }
  if (!selector.poolAddress) {
    throw new Error('Please provide --farm or --poolAddress flag to do this action');
  }

  const endpoint = FARMING_API_ENDPOINT[cluster ?? 'mainnet-beta'];
  let farms: { farmAddress: PublicKey; APY: string; expired: boolean }[];
  try {
    farms = await PoolFarmImpl.getFarmAddressesByPoolAddress(selector.poolAddress, cluster);
  } catch (error) {
    throw new Error(
      `Could not resolve a farm for pool ${selector.poolAddress.toString()} via the farming ` +
        `REST API (${endpoint}): ${error instanceof Error ? error.message : String(error)}. ` +
        'This endpoint needs network access and has no localnet/offline fallback — pass ' +
        '--farm <pubkey> directly instead.'
    );
  }

  const [first] = farms;
  if (!first) {
    // Defensive: the SDK throws rather than returning empty; guards a future SDK change.
    throw new Error(
      `No farms found for pool ${selector.poolAddress.toString()} — pass --farm <pubkey> ` +
        'directly if you already know the farm address.'
    );
  }
  if (farms.length > 1) {
    const list = farms
      .map(
        (f, i) => `  ${i + 1}. ${f.farmAddress.toString()} (APY ${f.APY}%, expired: ${f.expired})`
      )
      .join('\n');
    throw new Error(
      `${farms.length} farms found for pool ${selector.poolAddress.toString()}:\n${list}\n` +
        'Pass --farm <pubkey> to pick one.'
    );
  }

  console.log(
    `> Resolved farm ${first.farmAddress.toString()} for pool ${selector.poolAddress.toString()} ` +
      `(APY ${first.APY}%, expired: ${first.expired})`
  );
  return first.farmAddress;
}

/**
 * Safely fetch the caller's `user` account on `farm`. `PoolFarmImpl.getUserBalance` throws for a
 * wallet that has never staked, and `getUserState` fetches the wallet address instead of the
 * user PDA it computes — so this derives the PDA via `getUserPda` and fetches it directly.
 * @param farm - The loaded Pool Farm
 * @param owner - The staker's wallet
 * @returns The user account, or null if `owner` has never staked
 */
export async function getSafeFarmUserState(
  farm: PoolFarmImpl,
  owner: PublicKey
): Promise<FarmUserAccount | null> {
  const userPda = farm.getUserPda(owner);
  // `program` is typed private in the SDK's `.d.ts` but is populated and accessible at runtime.
  const program = (farm as any).program;
  const userState = (await program.account.user.fetchNullable(userPda)) as FarmUserAccount | null;
  return userState;
}

/**
 * Print the status of a Pool Farm (read-only, DAMM v1 LP staking farms only), including staked
 * balance and claimable rewards for an optional wallet.
 * @param connection - The connection to the network
 * @param selector - The `--farm`/`--poolAddress` selector
 * @param walletPubkey - Optional wallet to show staked balance/rewards for
 * @param cluster - Farming REST cluster override
 */
export async function getStatus(
  connection: Connection,
  selector: FarmSelector,
  walletPubkey?: PublicKey,
  cluster?: FarmingRestCluster
): Promise<void> {
  const farmAddress = await resolveFarmAddress(selector, cluster);
  console.log(`\n> Farm:    ${farmAddress.toString()}`);
  console.log(`> Program: ${FARM_PROGRAM_ID.toString()}`);

  const farm = await loadFarm(connection, farmAddress, cluster);
  // `pool` is the farming program's own IDL account, distinct from the DAMM v1 AMM pool it stakes LP from.
  const pool = farm.poolState;

  const stakingMintInfo = await getMint(connection, pool.stakingMint, connection.commitment);
  const stakingDecimals = stakingMintInfo.decimals;

  const isSingleSided = pool.rewardAMint.equals(pool.rewardBMint);
  const rewardAMintInfo = await getMint(connection, pool.rewardAMint, connection.commitment);
  const rewardADecimals = rewardAMintInfo.decimals;
  const rewardBDecimals = isSingleSided
    ? rewardADecimals
    : (await getMint(connection, pool.rewardBMint, connection.commitment)).decimals;

  console.log(
    `> Staking mint (DAMM v1 LP): ${pool.stakingMint.toString()} (${stakingDecimals} decimals)`
  );
  console.log(
    `> Reward A mint:             ${pool.rewardAMint.toString()} (${rewardADecimals} decimals)`
  );
  console.log(
    isSingleSided
      ? '> Reward B mint:             same as reward A (single-sided farm)'
      : `> Reward B mint:             ${pool.rewardBMint.toString()} (${rewardBDecimals} decimals)`
  );
  console.log(`> Paused:                    ${pool.paused}`);
  console.log(
    `> Total staked:              ${getAmountInTokens(pool.totalStaked, stakingDecimals)} ` +
      `(${pool.totalStaked.toString()} base units)`
  );
  console.log(`> Reward duration:           ${pool.rewardDuration.toString()} seconds`);
  console.log(
    `> Reward duration ends:      ${new Date(pool.rewardDurationEnd.toNumber() * 1000).toISOString()} ` +
      `(unix ${pool.rewardDurationEnd.toString()})`
  );
  console.log(
    `> Reward A rate (raw):       ${pool.rewardARateU128.toString()} (internal fixed-point rate, ` +
      'not directly human units — see other-products.md)'
  );
  console.log(`> Reward B rate (raw):       ${pool.rewardBRateU128.toString()}`);
  const funders = pool.funders.filter((f) => !f.equals(PublicKey.default)).map((f) => f.toString());
  console.log(`> Authorized funders:        ${funders.length > 0 ? funders.join(', ') : '(none)'}`);

  if (!walletPubkey) {
    return;
  }

  console.log(`\n> Wallet: ${walletPubkey.toString()}`);
  const userState = await getSafeFarmUserState(farm, walletPubkey);
  if (!userState) {
    console.log('> Staked balance: 0 — this wallet has not staked in this farm yet.');
  } else {
    console.log(
      `> Staked balance: ${getAmountInTokens(userState.balanceStaked, stakingDecimals)} ` +
        `(${userState.balanceStaked.toString()} base units)`
    );
  }

  const claimableByFarm = await PoolFarmImpl.getClaimableRewards(
    walletPubkey,
    [farmAddress],
    connection
  );
  const claimable = claimableByFarm.get(farmAddress.toString());
  const rewardA = claimable?.rewardA ?? new BN(0);
  const rewardB = claimable?.rewardB ?? new BN(0);
  console.log(`> Claimable reward A: ${getAmountInTokens(rewardA, rewardADecimals)}`);
  console.log(
    isSingleSided
      ? '> Claimable reward B: same token as reward A (single-sided farm)'
      : `> Claimable reward B: ${getAmountInTokens(rewardB, rewardBDecimals)}`
  );
}
