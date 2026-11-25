import { Wallet } from '@coral-xyz/anchor';
import {
  DlmmProClient,
  getAmountsFromLiquidity,
  positionTotalLiquidity,
  tickArraysForTickIds,
  type DecodedLimitOrderData,
  type DecodedPositionWithReward,
  type DecodedTick,
} from '@meteora-ag/dlmm-pro-sdk';
import { Connection, PublicKey } from '@solana/web3.js';
import BN from 'bn.js';
import { getAmountInTokens } from '../../helpers';
import {
  findLimitOrders,
  findPositions,
  formatSqrtPrice,
  formatTickPrice,
  isOpenLimitOrderTick,
  LimitOrderAccount,
  loadPool,
  PositionAccount,
} from './utils';

/**
 * Print a DLMM Pro pool's price and the wallet's positions on it (read-only)
 * @param connection - The connection to the network
 * @param wallet - The wallet that owns the positions
 * @param poolAddress - The DLMM Pro pool address
 * @returns The wallet's positions on the pool
 */
export async function getPositions(
  connection: Connection,
  wallet: Wallet,
  poolAddress: PublicKey
): Promise<PositionAccount[]> {
  const client = new DlmmProClient(connection, connection.commitment);
  const pool = await loadPool(client, poolAddress);
  const { tickCurrentId, tickSpacing, sqrtPrice } = pool.state;

  console.log(`\n> Pool ${poolAddress.toString()}`);
  console.log(`- Token X: ${pool.state.tokenXMint.toString()}`);
  console.log(`- Token Y: ${pool.state.tokenYMint.toString()}`);
  console.log(
    `- Price: ${formatSqrtPrice(pool.grid, sqrtPrice)} token Y per token X (tick ${tickCurrentId}, tick spacing ${tickSpacing})`
  );

  const positions = await findPositions(client, pool, wallet.publicKey);
  if (positions.length === 0) {
    console.log('> No positions found on this pool for this wallet');
    return positions;
  }

  for (const position of positions) {
    const claimable = await client.position.getClaimableFees({
      pool: poolAddress,
      nftMint: position.nftMint,
    });
    console.log(`\n> Position ${position.nftMint.toString()} (NFT mint)`);
    console.log(`- Position address: ${position.address.toString()}`);

    for (const [index, slot] of position.slots.entries()) {
      const { amountX, amountY } = getAmountsFromLiquidity({
        tickCurrentId,
        tickLowerId: slot.tickLowerId,
        tickUpperId: slot.tickUpperId,
        currentSqrtPrice: sqrtPrice,
        liquidity: positionTotalLiquidity(slot).neg(),
      });
      console.log(
        `- Range ${index} @ price ${formatTickPrice(pool.grid, slot.tickLowerId)} to ${formatTickPrice(pool.grid, slot.tickUpperId)} (ticks ${slot.tickLowerId} to ${slot.tickUpperId}): ${getAmountInTokens(amountX, pool.mintX.decimals)} token X + ${getAmountInTokens(amountY, pool.mintY.decimals)} token Y`
      );
      if (!slot.permanentLockedLiquidity.isZero() || !slot.vestingLiquidity.isZero()) {
        console.log(
          `  - Liquidity: ${slot.unlockedLiquidity.toString()} unlocked | ${slot.permanentLockedLiquidity.toString()} permanently locked | ${slot.vestingLiquidity.toString()} vesting`
        );
      }
    }
    console.log(
      `- Unclaimed fees: ${getAmountInTokens(claimable.feeX, pool.mintX.decimals)} token X + ${getAmountInTokens(claimable.feeY, pool.mintY.decimals)} token Y`
    );

    // The position only stores the reward credited at its last refresh. What has accrued since
    // is not known until the next claim refreshes it.
    for (const [rewardIndex, reward] of (pool.extensions.rewards ?? []).entries()) {
      if (reward.mint.equals(PublicKey.default)) {
        continue;
      }
      const pending = (position.slots as DecodedPositionWithReward[]).reduce(
        (sum, slot) => sum.add(slot.rewards[rewardIndex]?.pendingAmount ?? new BN(0)),
        new BN(0)
      );
      console.log(
        `- Reward ${rewardIndex} (${reward.mint.toString()}): ${pending.toString()} lamports credited at the last refresh`
      );
    }
  }

  return positions;
}

/**
 * How far an order's tick has filled. Each tick counts the batches of orders it has finished
 * filling, and an order records that count when it is placed, so the gap between the two tells
 * whether the order is still resting, being filled or filled.
 */
function describeFill(
  order: DecodedLimitOrderData,
  tick: DecodedTick | undefined,
  decimals: number
): string {
  if (!isOpenLimitOrderTick(order)) {
    return 'cancelled';
  }
  if (!tick) {
    return 'unknown';
  }
  const batchesSincePlaced = tick.orderAge.sub(order.age);
  if (batchesSincePlaced.isZero()) {
    return 'not filled';
  }
  if (batchesSincePlaced.eqn(1)) {
    const unfilled = order.amount
      .mul(tick.processedOrderRemainingAmount)
      .add(tick.totalProcessingOrderAmount.subn(1))
      .div(tick.totalProcessingOrderAmount);
    if (!unfilled.isZero()) {
      return `partly filled (${getAmountInTokens(order.amount.sub(unfilled), decimals)} of ${getAmountInTokens(order.amount, decimals)})`;
    }
  }
  return 'filled';
}

/**
 * Print the wallet's limit orders on a DLMM Pro pool with their fill state (read-only)
 * @param connection - The connection to the network
 * @param wallet - The wallet that owns the orders
 * @param poolAddress - The DLMM Pro pool address
 * @returns The wallet's limit orders on the pool
 */
export async function getLimitOrders(
  connection: Connection,
  wallet: Wallet,
  poolAddress: PublicKey
): Promise<LimitOrderAccount[]> {
  console.log('\n> Fetching DLMM Pro limit orders...');
  const client = new DlmmProClient(connection, connection.commitment);
  const pool = await loadPool(client, poolAddress);

  const orders = await findLimitOrders(client, poolAddress, wallet.publicKey);
  if (orders.length === 0) {
    console.log(`> No limit orders for ${wallet.publicKey.toString()} on this pool`);
    return orders;
  }

  const tickArrays = await client.state.fetchTickArraysWithTicks(
    tickArraysForTickIds(
      poolAddress,
      orders.flatMap((order) => order.ticks.map((tick) => tick.tickId)),
      pool.state.tickSpacing
    ),
    { withReward: pool.withReward }
  );
  const ticks = new Map<number, DecodedTick>(
    tickArrays.flatMap((array) => array.ticks.map((tick) => [tick.tickId, tick] as const))
  );

  console.log(`> Found ${orders.length} limit order${orders.length > 1 ? 's' : ''}:`);
  for (const order of orders) {
    console.log(`\n> Limit order ${order.nftMint.toString()} (NFT mint)`);
    console.log(`- Limit order address: ${order.address.toString()}`);
    for (const tick of order.ticks) {
      const depositMint = tick.isAsk ? pool.mintX : pool.mintY;
      console.log(
        `- Tick ${tick.tickId} @ price ${formatTickPrice(pool.grid, tick.tickId)}: ${tick.isAsk ? 'ask' : 'bid'} | deposited ${getAmountInTokens(tick.amount, depositMint.decimals)} | ${describeFill(tick, ticks.get(tick.tickId), depositMint.decimals)}`
      );
    }
  }

  return orders;
}
