import { Cluster, Connection, PublicKey } from '@solana/web3.js';
import { Wallet } from '@coral-xyz/anchor';
import DLMM, {
  getPriceOfBinByBinId,
  LimitOrderStatus,
  ParsedLimitOrderWithPubkey,
} from '@meteora-ag/dlmm';

/**
 * List the wallet's positions on a DLMM pool (read-only).
 */
export async function getPositions(connection: Connection, wallet: Wallet, poolAddress: PublicKey) {
  const dlmmPool = await DLMM.create(connection, poolAddress);
  const activeBin = await dlmmPool.getActiveBin();
  console.log(`\n> Pool ${poolAddress.toString()} | active bin ${activeBin.binId}`);

  const { userPositions } = await dlmmPool.getPositionsByUserAndLbPair(wallet.publicKey);
  if (userPositions.length === 0) {
    console.log('> No positions found on this pool for this wallet');
    return;
  }
  for (const position of userPositions) {
    const data = position.positionData;
    console.log(`\n> Position ${position.publicKey.toString()}`);
    console.log(`  - Bins ${data.lowerBinId}..${data.upperBinId}`);
    console.log(`  - Amounts: x=${data.totalXAmount} y=${data.totalYAmount} (base units)`);
    console.log(`  - Unclaimed fees: feeX=${data.feeX.toString()} feeY=${data.feeY.toString()}`);
  }
}

/**
 * Fetch and print all open limit orders owned by the wallet on a DLMM pool
 * @param connection - The connection to the network
 * @param wallet - The wallet that owns the orders
 * @param poolAddress - The DLMM pool address
 * @param opts - Optional cluster/program overrides
 * @returns The parsed limit orders
 */
export async function getDlmmLimitOrders(
  connection: Connection,
  wallet: Wallet,
  poolAddress: PublicKey,
  opts?: {
    cluster?: Cluster | 'localhost';
    programId?: PublicKey;
  }
): Promise<ParsedLimitOrderWithPubkey[]> {
  console.log('\n> Fetching DLMM limit orders...');

  const dlmmInstance = await DLMM.create(connection, poolAddress, opts);
  const orders = await dlmmInstance.getLimitOrderByUserAndLbPair(wallet.publicKey);

  if (orders.length === 0) {
    console.log(`> No open limit orders for ${wallet.publicKey.toString()} on this pool`);
    return orders;
  }

  console.log(`> Found ${orders.length} limit order${orders.length > 1 ? 's' : ''}:`);
  for (const order of orders) {
    const data = order.limitOrderData;
    console.log(`\n> Limit order ${order.publicKey.toString()}`);
    console.log(
      `- Total deposit: ${data.totalDepositAmountX} base | ${data.totalDepositAmountY} quote`
    );
    console.log(
      `- Unfilled: ${data.totalUnfilledAmountX} base | ${data.totalUnfilledAmountY} quote`
    );
    console.log(`- Filled: ${data.totalFilledAmountX} base | ${data.totalFilledAmountY} quote`);
    console.log(`- Fees earned: ${data.totalFeeAmountX} base | ${data.totalFeeAmountY} quote`);
    console.log(
      `- Withdrawable on cancel: ${data.transferFeeExcludedWithdrawableAmountX} base | ${data.transferFeeExcludedWithdrawableAmountY} quote`
    );
    for (const bin of data.limitOrderBinData) {
      const binPrice = dlmmInstance.fromPricePerLamport(
        getPriceOfBinByBinId(bin.binId, dlmmInstance.lbPair.binStep).toNumber()
      );
      console.log(
        `- Bin ${bin.binId} @ price ${binPrice}: ${bin.isAskSide ? 'ask' : 'bid'} | status ${LimitOrderStatus[bin.status]} | deposited ${bin.isAskSide ? bin.depositAmountX : bin.depositAmountY} | filled ${bin.isAskSide ? bin.filledAmountY : bin.filledAmountX}`
      );
    }
  }

  return orders;
}
