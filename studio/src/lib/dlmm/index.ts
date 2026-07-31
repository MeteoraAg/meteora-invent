import {
  Cluster,
  ComputeBudgetProgram,
  Connection,
  Keypair,
  PublicKey,
  sendAndConfirmTransaction,
  Transaction,
} from '@solana/web3.js';
import { DlmmConfig } from '../../utils/types';
import { Wallet } from '@coral-xyz/anchor';
import DLMM, {
  deriveCustomizablePermissionlessLbPair,
  getPriceOfBinByBinId,
  isSupportLimitOrder,
  LimitOrderStatus,
  MAX_BIN_PER_LIMIT_ORDER,
  ParsedLimitOrderWithPubkey,
} from '@meteora-ag/dlmm';
import BN from 'bn.js';
import {
  getAmountInLamports,
  getQuoteDecimals,
  isPriceRoundingUp,
  modifyComputeUnitPriceIx,
  runSimulateTransaction,
} from '../../helpers';
import { getMint } from '@solana/spl-token';
import { DEFAULT_SEND_TX_MAX_RETRIES, DLMM_PROGRAM_IDS } from '../../utils/constants';
import { validateDlmmConfigFields, validateBaseConfig } from '../../helpers/config-validation';

export async function createPermissionlessDlmmPool(
  config: DlmmConfig,
  connection: Connection,
  wallet: Wallet,
  baseMint: PublicKey,
  quoteMint: PublicKey,
  opts?: {
    cluster?: Cluster | 'localhost';
    programId?: PublicKey;
  }
) {
  // Validate config before executing any actions
  validateBaseConfig(config);
  validateDlmmConfigFields(config);
  if (!config.dlmmConfig) {
    throw new Error(
      'Missing DLMM configuration. Ensure "dlmmConfig" is set in config/dlmm_config.jsonc.'
    );
  }
  console.log('\n> Initializing Permissionless DLMM pool...');

  const binStep = config.dlmmConfig.binStep;
  const feeBps = config.dlmmConfig.feeBps;
  const hasAlphaVault = config.dlmmConfig.hasAlphaVault;
  const activationPoint = config.dlmmConfig.activationPoint
    ? new BN(config.dlmmConfig.activationPoint)
    : null;

  const creatorPoolOnOffControl = config.dlmmConfig.creatorPoolOnOffControl;
  const concreteFunctionType = config.dlmmConfig.concreteFunctionType;
  const collectFeeMode = config.dlmmConfig.collectFeeMode;
  console.log(`- Using binStep = ${binStep}`);
  console.log(`- Using feeBps = ${feeBps}`);
  console.log(`- Using initialPrice = ${config.dlmmConfig.initialPrice}`);
  console.log(`- Using activationType = ${config.dlmmConfig.activationType}`);
  console.log(`- Using activationPoint = ${activationPoint}`);
  console.log(`- Using hasAlphaVault = ${hasAlphaVault}`);
  console.log(`- Using creatorPoolOnOffControl = ${creatorPoolOnOffControl}`);
  console.log(`- Using concreteFunctionType = ${concreteFunctionType ?? 'default (limit order)'}`);
  console.log(`- Using collectFeeMode = ${collectFeeMode ?? 'default (input only)'}`);

  if (!config.quoteMint) {
    throw new Error('Quote mint is required');
  }

  const quoteDecimals = await getQuoteDecimals(connection, config.quoteMint);
  const baseMintInfo = await connection.getAccountInfo(baseMint, connection.commitment);
  if (!baseMintInfo) {
    throw new Error(`Base mint account not found: ${baseMint}`);
  }
  const baseMintAccount = await getMint(
    connection,
    baseMint,
    connection.commitment,
    baseMintInfo.owner
  );
  const baseDecimals = baseMintAccount.decimals;

  const initPrice = DLMM.getPricePerLamport(
    baseDecimals,
    quoteDecimals,
    config.dlmmConfig.initialPrice
  );

  const activateBinId = DLMM.getBinIdFromPrice(
    initPrice,
    binStep,
    !isPriceRoundingUp(config.dlmmConfig.priceRounding)
  );

  const cluster = opts?.cluster || 'mainnet-beta';
  const dlmmProgramId =
    opts?.programId ?? new PublicKey(DLMM_PROGRAM_IDS[cluster as keyof typeof DLMM_PROGRAM_IDS]);
  const initPoolTx = await DLMM.createCustomizablePermissionlessLbPair2(
    connection,
    new BN(binStep),
    baseMint,
    quoteMint,
    new BN(activateBinId.toString()),
    new BN(feeBps),
    config.dlmmConfig.activationType,
    hasAlphaVault,
    wallet.publicKey,
    activationPoint || undefined,
    creatorPoolOnOffControl,
    concreteFunctionType,
    collectFeeMode,
    {
      cluster,
      programId: dlmmProgramId,
    }
  );

  modifyComputeUnitPriceIx(initPoolTx, config.computeUnitPriceMicroLamports ?? 0);

  const [poolKey] = deriveCustomizablePermissionlessLbPair(baseMint, quoteMint, dlmmProgramId);

  console.log(`\n> Pool address: ${poolKey}`);

  if (config.dryRun) {
    console.log(`\n> Simulating init pool tx...`);
    await runSimulateTransaction(connection, [wallet.payer], wallet.publicKey, [initPoolTx]);
  } else {
    console.log(`>> Sending init pool transaction...`);
    const initPoolTxHash = await sendAndConfirmTransaction(connection, initPoolTx, [wallet.payer], {
      commitment: connection.commitment,
      maxRetries: DEFAULT_SEND_TX_MAX_RETRIES,
    }).catch((e) => {
      console.error(e);
      throw e;
    });
    console.log(`>>> Pool initialized successfully with tx hash: ${initPoolTxHash}`);
  }
}

export async function seedLiquidityLfg(
  connection: Connection,
  payerKeypair: Keypair,
  baseKeypair: Keypair,
  operatorKeypair: Keypair,
  positionOwner: PublicKey,
  feeOwner: PublicKey,
  baseMint: PublicKey,
  quoteMint: PublicKey,
  seedAmount: BN,
  curvature: number,
  minPrice: number,
  maxPrice: number,
  lockReleasePoint: BN,
  seedTokenXToPositionOwner: boolean,
  dryRun: boolean,
  computeUnitPriceMicroLamports: number | bigint,
  opts?: {
    cluster?: Cluster | 'localhost';
    programId?: PublicKey;
  }
) {
  const cluster = opts?.cluster || 'mainnet-beta';
  const dlmmProgramId =
    opts?.programId ?? new PublicKey(DLMM_PROGRAM_IDS[cluster as keyof typeof DLMM_PROGRAM_IDS]);

  const [poolKey] = deriveCustomizablePermissionlessLbPair(baseMint, quoteMint, dlmmProgramId);
  console.log(`- Using pool key ${poolKey.toString()}`);

  console.log(`- Using seedAmount in lamports = ${seedAmount}`);
  console.log(`- Using curvature = ${curvature}`);
  console.log(`- Using minPrice ${minPrice}`);
  console.log(`- Using maxPrice ${maxPrice}`);
  console.log(`- Using operator ${operatorKeypair.publicKey}`);
  console.log(`- Using positionOwner ${positionOwner}`);
  console.log(`- Using feeOwner ${feeOwner}`);
  console.log(`- Using lockReleasePoint ${lockReleasePoint}`);
  console.log(`- Using seedTokenXToPositionOwner ${seedTokenXToPositionOwner}`);

  if (!seedTokenXToPositionOwner) {
    console.log(
      `WARNING: You selected seedTokenXToPositionOwner = false, you should manually send 1 lamport of token X to the position owner account to prove ownership.`
    );
  }

  const dlmmInstance = await DLMM.create(connection, poolKey, opts);

  const { sendPositionOwnerTokenProveIxs, initializeBinArraysAndPositionIxs, addLiquidityIxs } =
    await dlmmInstance.seedLiquidity(
      positionOwner,
      seedAmount,
      curvature,
      minPrice,
      maxPrice,
      baseKeypair.publicKey,
      payerKeypair.publicKey,
      feeOwner,
      operatorKeypair.publicKey,
      lockReleasePoint,
      seedTokenXToPositionOwner
    );

  if (sendPositionOwnerTokenProveIxs.length > 0) {
    // run preflight ixs
    const { blockhash, lastValidBlockHeight } = await connection.getLatestBlockhash(
      connection.commitment
    );
    const setCUPriceIx = ComputeBudgetProgram.setComputeUnitPrice({
      microLamports: computeUnitPriceMicroLamports,
    });

    const signers = [payerKeypair];
    const tx = new Transaction({
      feePayer: payerKeypair.publicKey,
      blockhash,
      lastValidBlockHeight,
    }).add(setCUPriceIx);

    tx.add(...sendPositionOwnerTokenProveIxs);

    if (dryRun) {
      throw new Error('dryRun is not supported for this script, please set dryRun config to false');
    }

    console.log(`>> Running preflight instructions...`);
    try {
      console.log(`>> Sending preflight transaction...`);
      const txHash = await sendAndConfirmTransaction(connection, tx, signers, {
        commitment: connection.commitment,
        maxRetries: DEFAULT_SEND_TX_MAX_RETRIES,
      });
      console.log(`>>> Preflight successfully with tx hash: ${txHash}`);
    } catch (err) {
      console.error(err);
      throw new Error(err as string);
    }
  }

  console.log(`>> Running initializeBinArraysAndPosition instructions...`);
  // Initialize all bin array and position, transaction order can be in sequence or not
  {
    const { blockhash, lastValidBlockHeight } = await connection.getLatestBlockhash(
      connection.commitment
    );

    const transactions: Array<Promise<string>> = [];

    for (const groupIx of initializeBinArraysAndPositionIxs) {
      const tx = new Transaction({
        feePayer: payerKeypair.publicKey,
        blockhash,
        lastValidBlockHeight,
      }).add(...groupIx);

      const signers = [payerKeypair, baseKeypair, operatorKeypair];

      transactions.push(
        sendAndConfirmTransaction(connection, tx, signers, {
          commitment: connection.commitment,
          maxRetries: DEFAULT_SEND_TX_MAX_RETRIES,
        })
      );
    }

    await Promise.all(transactions)
      .then((txs) => {
        txs.map(console.log);
      })
      .catch((e) => {
        console.error(e);
        throw e;
      });
  }
  console.log(`>>> Finished initializeBinArraysAndPosition instructions!`);

  console.log(`>> Running addLiquidity instructions...`);
  {
    const { blockhash, lastValidBlockHeight } = await connection.getLatestBlockhash(
      connection.commitment
    );

    // Deposit to positions created in above step. The add liquidity order can be in sequence or not.
    for (const groupIx of addLiquidityIxs) {
      const tx = new Transaction({
        feePayer: payerKeypair.publicKey,
        blockhash,
        lastValidBlockHeight,
      }).add(...groupIx);

      const signers = [payerKeypair, operatorKeypair];

      await sendAndConfirmTransaction(connection, tx, signers, {
        commitment: connection.commitment,
        maxRetries: DEFAULT_SEND_TX_MAX_RETRIES,
      });
    }
  }
  console.log(`>>> Finished addLiquidity instructions!`);
}

export async function seedLiquiditySingleBin(
  connection: Connection,
  payerKeypair: Keypair,
  baseKeypair: Keypair,
  operatorKeypair: Keypair,
  positionOwner: PublicKey,
  feeOwner: PublicKey,
  baseMint: PublicKey,
  quoteMint: PublicKey,
  seedAmount: BN,
  price: number,
  priceRounding: string,
  lockReleasePoint: BN,
  seedTokenXToPositionOwner: boolean,
  dryRun: boolean,
  computeUnitPriceMicroLamports: number | bigint,
  opts?: {
    cluster?: Cluster | 'localhost';
    programId?: PublicKey;
  }
) {
  if (priceRounding != 'up' && priceRounding != 'down') {
    throw new Error("Invalid selective rounding value. Must be 'up' or 'down'");
  }

  const cluster = opts?.cluster || 'mainnet-beta';
  const dlmmProgramId =
    opts?.programId ?? new PublicKey(DLMM_PROGRAM_IDS[cluster as keyof typeof DLMM_PROGRAM_IDS]);

  const [poolKey] = deriveCustomizablePermissionlessLbPair(baseMint, quoteMint, dlmmProgramId);
  console.log(`- Using pool key ${poolKey.toString()}`);

  console.log(`- Using seedAmount in lamports = ${seedAmount}`);
  console.log(`- Using priceRounding = ${priceRounding}`);
  console.log(`- Using price ${price}`);
  console.log(`- Using operator ${operatorKeypair.publicKey}`);
  console.log(`- Using positionOwner ${positionOwner}`);
  console.log(`- Using feeOwner ${feeOwner}`);
  console.log(`- Using lockReleasePoint ${lockReleasePoint}`);
  console.log(`- Using seedTokenXToPositionOwner ${seedTokenXToPositionOwner}`);

  if (!seedTokenXToPositionOwner) {
    console.log(
      `WARNING: You selected seedTokenXToPositionOwner = false, you should manually send 1 lamport of token X to the position owner account to prove ownership.`
    );
  }

  const dlmmInstance = await DLMM.create(connection, poolKey, opts);
  const { instructions } = await dlmmInstance.seedLiquiditySingleBin(
    payerKeypair.publicKey,
    baseKeypair.publicKey,
    seedAmount,
    price,
    priceRounding == 'up',
    positionOwner,
    feeOwner,
    operatorKeypair.publicKey,
    lockReleasePoint,
    seedTokenXToPositionOwner
  );

  const setCUPriceIx = ComputeBudgetProgram.setComputeUnitPrice({
    microLamports: computeUnitPriceMicroLamports,
  });

  const { blockhash, lastValidBlockHeight } = await connection.getLatestBlockhash(
    connection.commitment
  );

  const tx = new Transaction({
    feePayer: payerKeypair.publicKey,
    blockhash,
    lastValidBlockHeight,
  })
    .add(setCUPriceIx)
    .add(...instructions);

  if (dryRun) {
    console.log(`\n> Simulating seedLiquiditySingleBin transaction...`);
    await runSimulateTransaction(
      connection,
      [payerKeypair, baseKeypair, operatorKeypair],
      payerKeypair.publicKey,
      [tx]
    );
  } else {
    console.log(`>> Sending seedLiquiditySingleBin transaction...`);
    const txHash = await sendAndConfirmTransaction(
      connection,
      tx,
      [payerKeypair, baseKeypair, operatorKeypair],
      {
        commitment: connection.commitment,
        maxRetries: DEFAULT_SEND_TX_MAX_RETRIES,
      }
    ).catch((err) => {
      console.error(err);
      throw err;
    });
    console.log(`>>> SeedLiquiditySingleBin successfully with tx hash: ${txHash}`);
  }
}

/**
 * Place a limit order on a DLMM pool
 * @param config - The DLMM config
 * @param connection - The connection to the network
 * @param wallet - The wallet that owns and pays for the order
 * @param poolAddress - The DLMM pool address
 * @param opts - Optional cluster/program overrides
 * @returns The limit order account address
 */
export async function placeDlmmLimitOrder(
  config: DlmmConfig,
  connection: Connection,
  wallet: Wallet,
  poolAddress: PublicKey,
  opts?: {
    cluster?: Cluster | 'localhost';
    programId?: PublicKey;
  }
): Promise<PublicKey> {
  validateBaseConfig(config);
  if (!config.placeLimitOrder) {
    throw new Error(
      'Missing placeLimitOrder configuration. Ensure "placeLimitOrder" is set in config/dlmm_config.jsonc.'
    );
  }

  const { side, bins } = config.placeLimitOrder;
  if (side !== 'ask' && side !== 'bid') {
    throw new Error(`Invalid placeLimitOrder.side "${side}". Use "ask" (sell) or "bid" (buy).`);
  }
  if (!Array.isArray(bins) || bins.length === 0) {
    throw new Error('placeLimitOrder.bins must contain at least one { price, amount } entry.');
  }
  if (bins.length > MAX_BIN_PER_LIMIT_ORDER.toNumber()) {
    throw new Error(
      `placeLimitOrder.bins supports at most ${MAX_BIN_PER_LIMIT_ORDER.toString()} bins per order.`
    );
  }

  console.log('\n> Placing DLMM limit order...');

  const dlmmInstance = await DLMM.create(connection, poolAddress, opts);
  if (!isSupportLimitOrder(dlmmInstance.lbPair)) {
    throw new Error(
      `Pool ${poolAddress.toString()} does not support limit orders. Only pools created with the limit order function type accept them.`
    );
  }

  const isAskSide = side === 'ask';
  const depositDecimals = isAskSide
    ? dlmmInstance.tokenX.mint.decimals
    : dlmmInstance.tokenY.mint.decimals;

  // Merge duplicate bin ids so the order keeps strictly ascending bins
  const binAmounts = new Map<number, BN>();
  for (const bin of bins) {
    const pricePerLamport = Number(dlmmInstance.toPricePerLamport(bin.price));
    const binId = dlmmInstance.getBinIdFromPrice(pricePerLamport, !isAskSide);
    const amount = getAmountInLamports(bin.amount, depositDecimals);
    binAmounts.set(binId, (binAmounts.get(binId) ?? new BN(0)).add(amount));
  }
  const orderBins = [...binAmounts.entries()]
    .map(([id, amount]) => ({ id, amount }))
    .sort((a, b) => a.id - b.id);

  const activeBinId = dlmmInstance.lbPair.activeId;
  console.log(`- Pool active bin id: ${activeBinId}`);
  console.log(
    `- Order side: ${side} (${isAskSide ? 'selling base token' : 'buying with quote token'})`
  );
  for (const bin of orderBins) {
    const binPrice = dlmmInstance.fromPricePerLamport(
      getPriceOfBinByBinId(bin.id, dlmmInstance.lbPair.binStep).toNumber()
    );
    console.log(`- Bin ${bin.id} @ price ${binPrice}: amount ${bin.amount.toString()} lamports`);
  }

  const quote = await dlmmInstance.quoteCreateLimitOrder({ bins: orderBins });
  console.log(`- Order account rent: ${quote.limitOrderCost} SOL`);
  if (quote.binArraysCount > 0) {
    console.log(
      `- Bin arrays to initialize: ${quote.binArraysCount} (${quote.binArrayCost} SOL rent)`
    );
  }
  if (quote.bitmapExtensionCost > 0) {
    console.log(`- Bitmap extension rent: ${quote.bitmapExtensionCost} SOL`);
  }

  const limitOrderKeypair = Keypair.generate();
  const placeTx = await dlmmInstance.placeLimitOrder({
    owner: wallet.publicKey,
    payer: wallet.publicKey,
    sender: wallet.publicKey,
    limitOrder: limitOrderKeypair.publicKey,
    params: {
      isAskSide,
      relativeBin: null,
      bins: orderBins,
    },
  });

  modifyComputeUnitPriceIx(placeTx, config.computeUnitPriceMicroLamports ?? 0);

  console.log(`\n> Limit order address: ${limitOrderKeypair.publicKey.toString()}`);

  if (config.dryRun) {
    console.log(`\n> Simulating place limit order tx...`);
    await runSimulateTransaction(connection, [wallet.payer, limitOrderKeypair], wallet.publicKey, [
      placeTx,
    ]);
  } else {
    console.log(`>> Sending place limit order transaction...`);
    const txHash = await sendAndConfirmTransaction(
      connection,
      placeTx,
      [wallet.payer, limitOrderKeypair],
      {
        commitment: connection.commitment,
        maxRetries: DEFAULT_SEND_TX_MAX_RETRIES,
      }
    ).catch((err) => {
      console.error(err);
      throw err;
    });
    console.log(`>>> Limit order placed successfully with tx hash: ${txHash}`);
  }

  return limitOrderKeypair.publicKey;
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

/**
 * Cancel limit orders on a DLMM pool and withdraw all unfilled and filled amounts
 * @param config - The DLMM config
 * @param connection - The connection to the network
 * @param wallet - The wallet that owns the orders
 * @param poolAddress - The DLMM pool address
 * @param limitOrderAddress - A specific limit order to cancel; when null, cancels every open order (requires cancelLimitOrder.cancelAll)
 * @param opts - Optional cluster/program overrides
 */
export async function cancelDlmmLimitOrder(
  config: DlmmConfig,
  connection: Connection,
  wallet: Wallet,
  poolAddress: PublicKey,
  limitOrderAddress: PublicKey | null,
  opts?: {
    cluster?: Cluster | 'localhost';
    programId?: PublicKey;
  }
) {
  validateBaseConfig(config);
  console.log('\n> Cancelling DLMM limit order(s)...');

  const dlmmInstance = await DLMM.create(connection, poolAddress, opts);

  let orders: ParsedLimitOrderWithPubkey[];
  if (limitOrderAddress) {
    orders = [await dlmmInstance.getLimitOrder(limitOrderAddress)];
  } else {
    if (!config.cancelLimitOrder?.cancelAll) {
      throw new Error(
        'Provide --limitOrder <address> or set cancelLimitOrder.cancelAll to true in config/dlmm_config.jsonc to cancel every open order.'
      );
    }
    orders = await dlmmInstance.getLimitOrderByUserAndLbPair(wallet.publicKey);
    if (orders.length === 0) {
      console.log('> No open limit orders to cancel');
      return;
    }
  }

  for (const order of orders) {
    const data = order.limitOrderData;
    const binIds = data.limitOrderBinData.map((bin) => bin.binId);

    console.log(`\n> Cancelling limit order ${order.publicKey.toString()} (${binIds.length} bins)`);
    console.log(
      `- Withdrawable: ${data.transferFeeExcludedWithdrawableAmountX} base | ${data.transferFeeExcludedWithdrawableAmountY} quote`
    );

    await dlmmInstance.refetchStates();
    const cancelTx = await dlmmInstance.cancelLimitOrder({
      limitOrderPubkey: order.publicKey,
      owner: wallet.publicKey,
      rentReceiver: wallet.publicKey,
      binIds,
    });

    modifyComputeUnitPriceIx(cancelTx, config.computeUnitPriceMicroLamports ?? 0);

    if (config.dryRun) {
      console.log(`> Simulating cancel limit order tx...`);
      await runSimulateTransaction(connection, [wallet.payer], wallet.publicKey, [cancelTx]);
    } else {
      console.log(`>> Sending cancel limit order transaction...`);
      const txHash = await sendAndConfirmTransaction(connection, cancelTx, [wallet.payer], {
        commitment: connection.commitment,
        maxRetries: DEFAULT_SEND_TX_MAX_RETRIES,
      }).catch((err) => {
        console.error(err);
        throw err;
      });
      console.log(`>>> Limit order cancelled successfully with tx hash: ${txHash}`);
    }
  }
}
