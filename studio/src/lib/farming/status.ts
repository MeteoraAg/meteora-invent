import { PoolFarmImpl, FARM_PROGRAM_ID, FARMING_API_ENDPOINT } from '@meteora-ag/farming-sdk';
import { Connection, PublicKey } from '@solana/web3.js';
import { getMint } from '@solana/spl-token';
import BN from 'bn.js';
import { getAmountInTokens } from '../../helpers';

/** The only two clusters `FARMING_API_ENDPOINT` has entries for (verified against the
 * installed `.d.ts`) — there is no `localhost`/`testnet` key, so `--poolAddress` REST
 * resolution is never available on a local validator regardless of this guess. */
export type FarmingRestCluster = 'devnet' | 'mainnet-beta';

export interface FarmSelector {
  farm?: PublicKey;
  poolAddress?: PublicKey;
}

/**
 * Shape of the farming program's `user` account (IDL account name `user`), typed here because
 * the installed SDK never safely exposes a fetch for it — see `getSafeFarmUserState` below.
 * Field names/types verified against the installed `@meteora-ag/farming-sdk@1.0.18` `.d.ts`
 * (this is also, word for word, the SDK's own — unreliable — `getUserState` return type).
 */
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

/**
 * Best-effort guess of which farming REST endpoint (devnet vs mainnet-beta) matches
 * `rpcUrl`, for the `--poolAddress` -> `getFarmAddressesByPoolAddress` resolution path only.
 * `--farm` bypasses this entirely. Custom RPC providers (Helius/QuickNode/etc.) and localnet
 * URLs aren't detectable this way and fall back to `mainnet-beta` — the SDK's own default.
 */
export function guessFarmingCluster(rpcUrl: string): FarmingRestCluster {
  return rpcUrl.includes('devnet') ? 'devnet' : 'mainnet-beta';
}

/**
 * Load a `PoolFarmImpl` for `farm`, with a clearer error than the SDK's own bare
 * `"No pool state found"` (verified against the compiled `PoolFarmImpl.create` — it throws
 * that exact message with no address context when `program.account.pool.fetchNullable(farm)`
 * comes back null).
 */
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
 * Resolve a farm address from either an explicit `--farm`, or a `--poolAddress` looked up via
 * the SDK's `getFarmAddressesByPoolAddress` (a REST call to `amm.meteora.ag` / the devnet
 * mirror — there is no on-chain PDA derivation from just the DAMM v1 pool address). That call
 * THROWS both on a genuine network/offline failure and when the REST API is reachable but has
 * no farms for this pool (verified against the compiled source: `if (!farms.length) throw ...`)
 * — both cases are caught here and turned into one clear message pointing at `--farm`, since a
 * user can't tell those two failure modes apart from the SDK's raw error anyway and the fix is
 * identical either way. A pool with more than one farm is listed rather than guessed at (unlike
 * alpha-vault's pool->vault resolution) because different farms on the same pool can pay out
 * different reward tokens — silently picking one could stake into the wrong reward program.
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
    // Not expected (the SDK throws instead of returning empty — see the doc comment above),
    // but guarded in case a future SDK version changes that.
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
 * Safely fetch the caller's `user` account on `farm`, working around TWO verified SDK bugs
 * rather than using either of the SDK's own accessors:
 *  - `PoolFarmImpl.getUserBalance(owner)` does `fetchNullable(...).balanceStaked` with no null
 *    guard — throws a raw `TypeError: Cannot read properties of null` for anyone who has never
 *    staked in this farm.
 *  - `PoolFarmImpl.getUserState(owner)` computes the correct PDA via `getUserPda(owner)` and
 *    then ignores it, calling `fetchNullable(owner)` — i.e. it fetches the WALLET address
 *    itself, not the user PDA, so it returns null (or garbage) even for an active staker.
 * Both verified by reading the installed package's compiled `dist/index.js`.
 *
 * The fix (also this function's implementation): derive the PDA ourselves via the SDK's own
 * (correct, public) `getUserPda(owner)`, then fetch it directly through the farm's Anchor
 * `program` — which the `.d.ts` marks `private` (an `as any` boundary cast, same policy as
 * `lib/damm_v1`, is needed to reach it; its own compiled type is untyped, hence the manual
 * `FarmUserAccount` cast).
 */
export async function getSafeFarmUserState(
  farm: PoolFarmImpl,
  owner: PublicKey
): Promise<FarmUserAccount | null> {
  const userPda = farm.getUserPda(owner);
  const program = (farm as any).program;
  const userState = (await program.account.user.fetchNullable(userPda)) as FarmUserAccount | null;
  return userState;
}

/**
 * Print the status of a Pool Farm (read-only, DAMM v1 LP staking farms only): resolves the
 * farm (direct `--farm`, or `--poolAddress` via the REST lookup above), prints the farm's
 * `pool` account summary (IDL account name is `pool` — this is the farming program's OWN
 * account for the farm, distinct from the DAMM v1 AMM pool it stakes LP from), and — with a
 * wallet — that wallet's staked balance (via the safe fetch above) and claimable rewards (via
 * the SDK's static `getClaimableRewards`, which is itself null-safe for a never-staked wallet:
 * it just omits the farm from the returned map instead of throwing).
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
