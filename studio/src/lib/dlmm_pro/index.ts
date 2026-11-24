import { Wallet } from '@coral-xyz/anchor';
import {
  ACCESS_REGISTRY_PROGRAM_ID,
  BaseFeeMode,
  CollectFeeMode,
  DlmmProClient,
  LiquidityLayout,
  PoolExtension,
  StrategyType,
  amountsFromShape,
  baseFeeParameters,
  bondingCurveActivationParameters,
  bpsToFeeNumerator,
  buildLiquidityShape,
  calculateTransferFeeExcludedAmount,
  calculateTransferFeeIncludedAmount,
  deriveDynamicConfig,
  deriveStaticConfig,
  deriveTokenBadge,
  encodeAddLiquidityByWeight,
  encodePoolExtensions,
  getAmountsFromLiquidity,
  getBaseFeeNumerator,
  getDynamicFeeParams,
  getSqrtPriceFromTickId,
  isSupportExtension,
  liquidityBitmap,
  multiplierFromAmounts,
  openActivationParameters,
  readClock,
  timeBasedActivationParameters,
  type BaseFeeConfig,
  type InitializePoolResult,
  type InitializePoolWithDynamicParameters,
  type TickRange,
} from '@meteora-ag/dlmm-pro-sdk';
import { Connection, Keypair, PublicKey, Transaction } from '@solana/web3.js';
import BN from 'bn.js';
import { getAmountInLamports, getAmountInTokens } from '../../helpers';
import { validateBaseConfig, validateDlmmProConfigFields } from '../../helpers/config-validation';
import {
  DlmmProActivationConfig,
  DlmmProConfig,
  DlmmProPoolConfig,
  DlmmProPoolParameters,
} from '../../utils/types';
import {
  assertBps,
  executeSteps,
  executeTransaction,
  fetchMint,
  findLimitOrders,
  findPositions,
  formatSqrtPrice,
  formatTickPrice,
  isOpenLimitOrderTick,
  LimitOrderAccount,
  loadPool,
  PoolContext,
  resolveLimitOrder,
  resolvePosition,
  TransactionStep,
  usableTickAtOrAbovePrice,
  usableTickAtOrBelowPrice,
} from './utils';

const CONFIG_FILE = 'config/dlmm_pro_config.jsonc';

const STRATEGIES = {
  spot: StrategyType.Spot,
  curve: StrategyType.Curve,
  bidAsk: StrategyType.BidAsk,
  wave: StrategyType.Wave,
};

const LAYOUTS = {
  vertical: LiquidityLayout.Vertical,
  horizontal: LiquidityLayout.Horizontal,
};

function requireConfigIndex(poolConfig: DlmmProPoolConfig): number {
  if (poolConfig.configIndex == null) {
    throw new Error(
      `dlmmProConfig.configIndex is required for poolType "${poolConfig.poolType}" in ${CONFIG_FILE}`
    );
  }
  return poolConfig.configIndex;
}

/** The base fee a new pool charges at its activation point, before any scheduled reduction. */
function startingFeeBps(baseFee: BaseFeeConfig, initialSqrtPrice: BN): number {
  const activationPoint = new BN(0);
  const numerator = getBaseFeeNumerator(
    baseFee,
    activationPoint,
    activationPoint,
    initialSqrtPrice,
    initialSqrtPrice
  );
  return numerator.toNumber() / bpsToFeeNumerator(1).toNumber();
}

function addressOrDefault(address: string | null | undefined): PublicKey {
  return address ? new PublicKey(address) : PublicKey.default;
}

/**
 * The two activation slots must be one of the pairs the program accepts: Open + Open,
 * Open + BondingCurve, Open + TimeBased or BondingCurve + TimeBased.
 */
function buildPoolActivation(activation: DlmmProActivationConfig) {
  const bondingCurve =
    activation.bondingCurveTargetBps != null
      ? bondingCurveActivationParameters({ targetIncreaseBps: activation.bondingCurveTargetBps })
      : null;
  const timeBased = activation.timeBased
    ? timeBasedActivationParameters({
        swapPoint: new BN(activation.timeBased.swapPoint),
        addLiquidityPoint: new BN(activation.timeBased.addLiquidityPoint),
        removeLiquidityPoint: new BN(activation.timeBased.removeLiquidityPoint),
      })
    : null;

  return {
    whitelistedSwap: addressOrDefault(activation.whitelistedSwap),
    whitelistedAddLiquidity: addressOrDefault(activation.whitelistedAddLiquidity),
    whitelistedRemoveLiquidity: addressOrDefault(activation.whitelistedRemoveLiquidity),
    activations:
      bondingCurve && timeBased
        ? [bondingCurve, timeBased]
        : [openActivationParameters(), bondingCurve ?? timeBased ?? openActivationParameters()],
  };
}

function requirePoolParameters(poolConfig: DlmmProPoolConfig): DlmmProPoolParameters {
  if (!poolConfig.poolParameters) {
    throw new Error(
      `dlmmProConfig.poolParameters is required for poolType "${poolConfig.poolType}" in ${CONFIG_FILE}`
    );
  }
  return poolConfig.poolParameters;
}

function buildPoolParameters(
  params: DlmmProPoolParameters,
  initialSqrtPrice: BN
): InitializePoolWithDynamicParameters {
  // A scheduled fee settles at its ending fee, which is what the dynamic fee is sized against.
  const settledFeeBps =
    params.baseFee.baseFeeMode === BaseFeeMode.Fixed
      ? params.baseFee.feeBps
      : params.baseFee.endingBaseFeeBps;
  const extensions = [
    ...(params.liquidityMining ? [PoolExtension.LiquidityMining] : []),
    ...(params.activation ? [PoolExtension.ActivationAccess] : []),
  ];

  console.log(`- Using tickSpacing = ${params.tickSpacing}`);
  console.log(`- Using baseFee = ${JSON.stringify(params.baseFee)}`);
  console.log(`- Using dynamicFee = ${params.dynamicFee}`);
  console.log(`- Using collectFeeMode = ${params.collectFeeMode}`);
  console.log(`- Using activationType = ${params.activationType}`);
  console.log(`- Using liquidityMining = ${params.liquidityMining}`);
  console.log(`- Using activation = ${JSON.stringify(params.activation ?? null)}`);

  return {
    poolFees: {
      baseFeeParameter: baseFeeParameters(params.baseFee),
      dynamicFeeParameter: params.dynamicFee
        ? getDynamicFeeParams(settledFeeBps, params.tickSpacing)
        : null,
    },
    tickSpacing: params.tickSpacing,
    collectFeeMode: params.collectFeeMode,
    initialSqrtPrice,
    activationType: params.activationType,
    // The program requires the activation point to equal the time based swap point, and to be
    // unset without one.
    activationPoint: params.activation?.timeBased
      ? new BN(params.activation.timeBased.swapPoint)
      : null,
    extensions: encodePoolExtensions(extensions),
    poolActivation: params.activation ? buildPoolActivation(params.activation) : null,
  };
}

/** The token badge of each mint that has one in the access registry, null otherwise. */
async function findTokenBadges(
  connection: Connection,
  mints: PublicKey[]
): Promise<(PublicKey | null)[]> {
  const badges = mints.map((mint) => deriveTokenBadge(mint));
  const infos = await connection.getMultipleAccountsInfo(badges, connection.commitment);
  return badges.map((badge, index) =>
    infos[index]?.owner.equals(ACCESS_REGISTRY_PROGRAM_ID) ? badge : null
  );
}

/**
 * One claim for each initialized reward slot of a liquidity mining pool. What a slot has
 * accrued is only known once the position is refreshed, so none is skipped. A claim of zero
 * succeeds without a transfer.
 */
async function claimRewardSteps(
  client: DlmmProClient,
  pool: PoolContext,
  wallet: Wallet,
  nftMint: PublicKey,
  bitmap: BN,
  tickRanges: TickRange[]
): Promise<TransactionStep[]> {
  const steps: TransactionStep[] = [];
  for (const [rewardIndex, reward] of (pool.extensions.rewards ?? []).entries()) {
    if (reward.mint.equals(PublicKey.default)) {
      continue;
    }
    const { tx } = await client.reward.claimReward({
      pool: pool.address,
      nftMint,
      owner: wallet.publicKey,
      signer: wallet.publicKey,
      rewardMint: reward.mint,
      rewardIndex,
      bitmap,
      tickRanges,
    });
    steps.push({ label: `claim reward ${rewardIndex}`, tx, signers: [wallet.payer] });
  }
  return steps;
}

/**
 * Create a DLMM Pro pool with the base mint as token X and the quote mint as token Y
 * @param config - The DLMM Pro config
 * @param connection - The connection to the network
 * @param wallet - The wallet that pays for and is recorded as the creator of the pool
 * @param baseMint - The base token mint
 * @param quoteMint - The quote token mint
 * @returns The pool address
 */
export async function createDlmmProPool(
  config: DlmmProConfig,
  connection: Connection,
  wallet: Wallet,
  baseMint: PublicKey,
  quoteMint: PublicKey
): Promise<PublicKey> {
  validateBaseConfig(config);
  validateDlmmProConfigFields(config);
  const poolConfig = config.dlmmProConfig;
  if (!poolConfig) {
    throw new Error(
      `Missing DLMM Pro configuration. Ensure "dlmmProConfig" is set in ${CONFIG_FILE}.`
    );
  }

  console.log('\n> Initializing DLMM Pro pool...');
  const client = new DlmmProClient(connection, connection.commitment);

  const [base, quote] = await Promise.all([
    fetchMint(connection, baseMint),
    fetchMint(connection, quoteMint),
  ]);
  const [tokenBadgeX = null, tokenBadgeY = null] = await findTokenBadges(connection, [
    baseMint,
    quoteMint,
  ]);
  const accounts = {
    tokenXMint: baseMint,
    tokenYMint: quoteMint,
    creator: wallet.publicKey,
    payer: wallet.publicKey,
    tokenBadgeX,
    tokenBadgeY,
  };

  console.log(`- Using poolType = ${poolConfig.poolType}`);

  // The pool starts on the usable tick at or below the configured price. On a usable tick, a
  // position that begins at the initial price can be funded with the base token alone.
  const initialSqrtPriceFor = (tickSpacing: number): BN => {
    const grid = { decimalsX: base.decimals, decimalsY: quote.decimals, tickSpacing };
    const tickId = usableTickAtOrBelowPrice(grid, poolConfig.initialPrice);
    console.log(
      `- Using initialPrice = ${poolConfig.initialPrice} (starts at ${formatTickPrice(grid, tickId)}, tick ${tickId})`
    );
    return getSqrtPriceFromTickId(tickId);
  };
  const poolParameters = (): InitializePoolWithDynamicParameters => {
    const params = requirePoolParameters(poolConfig);
    return buildPoolParameters(params, initialSqrtPriceFor(params.tickSpacing));
  };

  let created: InitializePoolResult;
  switch (poolConfig.poolType) {
    case 'static': {
      const configIndex = requireConfigIndex(poolConfig);
      const configAddress = deriveStaticConfig(configIndex);
      const staticConfig = await client.state.fetchStaticConfig(configAddress);
      const authority = staticConfig.poolCreatorAuthority;
      if (!authority.equals(PublicKey.default) && !authority.equals(wallet.publicKey)) {
        throw new Error(
          `Static config ${configIndex} is restricted to pool creator authority ${authority.toString()}`
        );
      }
      const initialSqrtPrice = initialSqrtPriceFor(staticConfig.tickSpacing);
      console.log(`- Using static config ${configIndex} (${configAddress.toString()})`);
      console.log(`  - tickSpacing = ${staticConfig.tickSpacing}`);
      console.log(`  - baseFeeMode = ${BaseFeeMode[staticConfig.feeConfig.baseFee.baseFeeMode]}`);
      console.log(
        `  - starting base fee = ${startingFeeBps(staticConfig.feeConfig.baseFee, initialSqrtPrice)} bps`
      );
      console.log(`  - dynamicFee = ${staticConfig.feeConfig.dynamicFee.initialized === 1}`);
      console.log(`  - collectFeeMode = ${CollectFeeMode[staticConfig.collectFeeMode]}`);
      console.log(
        `  - liquidityMining = ${isSupportExtension(staticConfig.extensions, PoolExtension.LiquidityMining)}`
      );
      created = await client.pool.initializePoolWithStaticConfig({
        ...accounts,
        config: configAddress,
        initialSqrtPrice,
      });
      break;
    }
    case 'dynamic': {
      const configIndex = requireConfigIndex(poolConfig);
      const configAddress = deriveDynamicConfig(wallet.publicKey, configIndex);
      console.log(`- Using dynamic config ${configIndex} (${configAddress.toString()})`);
      created = await client.pool.initializePoolWithDynamicConfig({
        ...accounts,
        config: configAddress,
        poolCreatorAuthority: wallet.publicKey,
        parameters: poolParameters(),
      });
      break;
    }
    case 'launch': {
      created = await client.pool.initializeLaunchPool({
        ...accounts,
        parameters: poolParameters(),
      });
      break;
    }
    default:
      throw new Error(
        `Invalid dlmmProConfig.poolType "${poolConfig.poolType}". Use "static", "dynamic" or "launch".`
      );
  }

  console.log(`\n> Pool address: ${created.pool.toString()}`);
  await executeTransaction(connection, config, created.tx, [wallet.payer], 'create pool');
  return created.pool;
}

/**
 * Open a position shaped by a liquidity strategy over a price range and fund it
 * @param config - The DLMM Pro config
 * @param connection - The connection to the network
 * @param wallet - The wallet that owns and funds the position
 * @param poolAddress - The DLMM Pro pool address
 * @returns The position NFT mint
 */
export async function openDlmmProPosition(
  config: DlmmProConfig,
  connection: Connection,
  wallet: Wallet,
  poolAddress: PublicKey
): Promise<PublicKey> {
  validateBaseConfig(config);
  const settings = config.openPosition;
  if (!settings) {
    throw new Error(
      `Missing openPosition configuration. Ensure "openPosition" is set in ${CONFIG_FILE}.`
    );
  }
  const strategy = STRATEGIES[settings.strategy];
  if (strategy === undefined) {
    throw new Error(
      `Invalid openPosition.strategy "${settings.strategy}". Use "spot", "curve", "bidAsk" or "wave".`
    );
  }
  const layout = LAYOUTS[settings.layout ?? 'vertical'];
  if (layout === undefined) {
    throw new Error(
      `Invalid openPosition.layout "${settings.layout}". Use "vertical" or "horizontal".`
    );
  }

  console.log('\n> Opening DLMM Pro position...');
  const client = new DlmmProClient(connection, connection.commitment);
  const pool = await loadPool(client, poolAddress);
  const { tickSpacing, tickCurrentId, sqrtPrice } = pool.state;

  const lowerTickId = usableTickAtOrBelowPrice(pool.grid, settings.minPrice);
  const upperTickId = usableTickAtOrAbovePrice(pool.grid, settings.maxPrice);
  if (upperTickId <= lowerTickId) {
    throw new Error('openPosition.maxPrice must be above openPosition.minPrice');
  }
  const shape = buildLiquidityShape({
    strategy,
    minTickId: lowerTickId,
    maxTickId: upperTickId - tickSpacing,
    tickSpacing,
    currentTickId: tickCurrentId,
    layout,
    maxRanges: settings.maxRanges ?? undefined,
  });

  const amountX = getAmountInLamports(settings.amountX, pool.mintX.decimals);
  const amountY = getAmountInLamports(settings.amountY, pool.mintY.decimals);
  const { epoch } = await readClock(connection, connection.commitment);
  const multiplier = multiplierFromAmounts({
    ranges: shape.ranges,
    tickSpacing,
    currentTickId: tickCurrentId,
    currentSqrtPrice: sqrtPrice,
    amountX,
    amountY,
    mintX: pool.mintX,
    mintY: pool.mintY,
    epoch,
  });
  const deposit = amountsFromShape({
    ranges: shape.ranges,
    currentTickId: tickCurrentId,
    currentSqrtPrice: sqrtPrice,
    multiplier,
  }).reduce((total, range) => ({ x: total.x.add(range.amountX), y: total.y.add(range.amountY) }), {
    x: new BN(0),
    y: new BN(0),
  });

  console.log(`- Pool price: ${formatSqrtPrice(pool.grid, sqrtPrice)} (tick ${tickCurrentId})`);
  console.log(
    `- Price range: ${formatTickPrice(pool.grid, lowerTickId)} to ${formatTickPrice(pool.grid, upperTickId)} (ticks ${lowerTickId} to ${upperTickId})`
  );
  console.log(`- Strategy: ${settings.strategy} in ${shape.ranges.length} range(s)`);
  console.log(
    `- Deposit: ${getAmountInTokens(deposit.x, pool.mintX.decimals)} token X + ${getAmountInTokens(deposit.y, pool.mintY.decimals)} token Y, before any Token 2022 transfer fee`
  );

  const nft = Keypair.generate();
  const opened = await client.position.openPosition({
    pool: poolAddress,
    nftMint: nft.publicKey,
    owner: wallet.publicKey,
    payer: wallet.publicKey,
    tickRanges: shape.ranges,
  });
  const funded = await client.position.addLiquidityByWeight({
    pool: poolAddress,
    nftMint: nft.publicKey,
    owner: wallet.publicKey,
    signer: wallet.publicKey,
    tokenXMint: pool.state.tokenXMint,
    tokenYMint: pool.state.tokenYMint,
    tickRanges: shape.ranges,
    parameters: encodeAddLiquidityByWeight({
      ranges: shape.ranges,
      maxAmountX: amountX,
      maxAmountY: amountY,
      multiplier,
    }),
  });

  console.log(`\n> Position NFT mint: ${nft.publicKey.toString()}`);
  console.log(`> Position address: ${opened.position.toString()}`);

  await executeSteps(connection, config, wallet.payer, [
    { label: 'open position', tx: opened.tx, signers: [wallet.payer, nft] },
    {
      label: 'add liquidity',
      tx: funded.tx,
      signers: [wallet.payer],
      dependsOnPriorStep: true,
    },
  ]);
  return nft.publicKey;
}

/**
 * Withdraw a share of a position's unlocked liquidity, and optionally claim what it earned
 * and close it
 * @param config - The DLMM Pro config
 * @param connection - The connection to the network
 * @param wallet - The wallet that owns the position
 * @param poolAddress - The DLMM Pro pool address
 * @param positionNftMint - The position to withdraw from; when null, the wallet's only position on the pool
 */
export async function removeDlmmProLiquidity(
  config: DlmmProConfig,
  connection: Connection,
  wallet: Wallet,
  poolAddress: PublicKey,
  positionNftMint: PublicKey | null
) {
  validateBaseConfig(config);
  const settings = config.removeLiquidity;
  if (!settings) {
    throw new Error(
      `Missing removeLiquidity configuration. Ensure "removeLiquidity" is set in ${CONFIG_FILE}.`
    );
  }
  assertBps('removeLiquidity.bps', settings.bps, 1);
  assertBps('removeLiquidity.slippageBps', settings.slippageBps, 0);
  if (settings.closePosition && settings.bps !== 10_000) {
    throw new Error('removeLiquidity.closePosition requires removeLiquidity.bps to be 10000');
  }

  console.log('\n> Removing DLMM Pro liquidity...');
  const client = new DlmmProClient(connection, connection.commitment);
  const pool = await loadPool(client, poolAddress);
  const position = await resolvePosition(client, pool, wallet.publicKey, positionNftMint);
  console.log(`- Using position ${position.nftMint.toString()}`);

  const accounts = {
    pool: poolAddress,
    nftMint: position.nftMint,
    owner: wallet.publicKey,
    signer: wallet.publicKey,
    tokenXMint: pool.state.tokenXMint,
    tokenYMint: pool.state.tokenYMint,
  };
  const tickRanges = position.slots.map(({ tickLowerId, tickUpperId }) => ({
    tickLowerId,
    tickUpperId,
  }));
  const steps: TransactionStep[] = [];

  // The program releases the liquidity that has vested before it withdraws, so a position
  // with only vesting liquidity may still have something to withdraw.
  const hasVestingLiquidity = position.slots.some((slot) => !slot.vestingLiquidity.isZero());
  const hasWithdrawableLiquidity =
    hasVestingLiquidity || position.slots.some((slot) => !slot.unlockedLiquidity.isZero());
  if (hasWithdrawableLiquidity) {
    const expected = position.slots.reduce(
      (total, slot) => {
        const { amountX, amountY } = getAmountsFromLiquidity({
          tickCurrentId: pool.state.tickCurrentId,
          tickLowerId: slot.tickLowerId,
          tickUpperId: slot.tickUpperId,
          currentSqrtPrice: pool.state.sqrtPrice,
          liquidity: slot.unlockedLiquidity.muln(settings.bps).divn(10_000).neg(),
        });
        return { x: total.x.add(amountX), y: total.y.add(amountY) };
      },
      { x: new BN(0), y: new BN(0) }
    );
    const { epoch } = await readClock(connection, connection.commitment);
    const received = {
      x: calculateTransferFeeExcludedAmount(pool.mintX, epoch, expected.x).amount,
      y: calculateTransferFeeExcludedAmount(pool.mintY, epoch, expected.y).amount,
    };
    console.log(
      `- Withdrawing ${settings.bps / 100}% of the unlocked liquidity: about ${getAmountInTokens(received.x, pool.mintX.decimals)} token X + ${getAmountInTokens(received.y, pool.mintY.decimals)} token Y`
    );
    if (hasVestingLiquidity) {
      console.log(
        '- Liquidity that has vested since the last update is released and withdrawn too'
      );
    }

    const removed = await client.position.removeLiquidityByBps({
      ...accounts,
      tickRanges,
      parameters: {
        minAmountX: received.x.muln(10_000 - settings.slippageBps).divn(10_000),
        minAmountY: received.y.muln(10_000 - settings.slippageBps).divn(10_000),
        expectedLayoutVersion: position.layoutVersion,
        bps: settings.bps,
        bitmap: null,
      },
    });
    steps.push({ label: 'remove liquidity', tx: removed.tx, signers: [wallet.payer] });
  } else {
    console.log('- Position has no unlocked liquidity to withdraw');
  }

  if (settings.closePosition) {
    const bitmap = liquidityBitmap(position.slots.map((_, index) => index));
    const claimedFees = await client.position.claimFee({ ...accounts, bitmap, tickRanges });
    steps.push({ label: 'claim fees', tx: claimedFees.tx, signers: [wallet.payer] });

    steps.push(
      ...(await claimRewardSteps(client, pool, wallet, position.nftMint, bitmap, tickRanges))
    );

    const closed = await client.position.closePosition({
      pool: poolAddress,
      owner: wallet.publicKey,
      nftMint: position.nftMint,
      rentReceiver: wallet.publicKey,
      tickRanges,
    });
    steps.push({
      label: 'close position',
      tx: closed.tx,
      signers: [wallet.payer],
      dependsOnPriorStep: true,
    });
  }

  if (steps.length === 0) {
    return;
  }
  await executeSteps(connection, config, wallet.payer, steps);
}

/**
 * Lock a share of a position's unlocked liquidity, permanently or on a vesting schedule
 * @param config - The DLMM Pro config
 * @param connection - The connection to the network
 * @param wallet - The wallet that owns the position
 * @param poolAddress - The DLMM Pro pool address
 * @param positionNftMint - The position to lock; when null, the wallet's only position on the pool
 */
export async function lockDlmmProPosition(
  config: DlmmProConfig,
  connection: Connection,
  wallet: Wallet,
  poolAddress: PublicKey,
  positionNftMint: PublicKey | null
) {
  validateBaseConfig(config);
  const settings = config.lockPosition;
  if (!settings) {
    throw new Error(
      `Missing lockPosition configuration. Ensure "lockPosition" is set in ${CONFIG_FILE}.`
    );
  }

  console.log('\n> Locking DLMM Pro position...');
  const client = new DlmmProClient(connection, connection.commitment);
  const pool = await loadPool(client, poolAddress);
  const position = await resolvePosition(client, pool, wallet.publicKey, positionNftMint);
  const accounts = {
    pool: poolAddress,
    nftMint: position.nftMint,
    owner: wallet.publicKey,
  };
  console.log(`- Using position ${position.nftMint.toString()}`);
  console.log(`- Locking ${settings.bps / 100}% of the unlocked liquidity`);

  let tx: Transaction;
  if (settings.vesting) {
    const { cliffPoint, periodFrequency, ...schedule } = settings.vesting;
    console.log(`- Vesting schedule: ${JSON.stringify(settings.vesting)}`);
    ({ tx } = await client.position.lockVestingPosition({
      ...accounts,
      parameters: {
        ...schedule,
        cliffPoint: cliffPoint == null ? null : new BN(cliffPoint),
        periodFrequency: new BN(periodFrequency),
        bps: settings.bps,
        expectedLayoutVersion: position.layoutVersion,
      },
    }));
  } else {
    console.log('- Permanent lock: this liquidity can never be withdrawn');
    ({ tx } = await client.position.lockPermanentPosition({
      ...accounts,
      bps: settings.bps,
      expectedLayoutVersion: position.layoutVersion,
    }));
  }

  await executeTransaction(connection, config, tx, [wallet.payer], 'lock position');
}

/**
 * Claim swap fees, and rewards on liquidity mining pools, for the wallet's positions on a pool
 * @param config - The DLMM Pro config
 * @param connection - The connection to the network
 * @param wallet - The wallet that owns the positions
 * @param poolAddress - The DLMM Pro pool address
 * @param positionNftMint - A specific position to claim for; when null, every position of the wallet on the pool
 */
export async function claimDlmmProFees(
  config: DlmmProConfig,
  connection: Connection,
  wallet: Wallet,
  poolAddress: PublicKey,
  positionNftMint: PublicKey | null
) {
  validateBaseConfig(config);
  console.log('\n> Claiming DLMM Pro fees...');
  const client = new DlmmProClient(connection, connection.commitment);
  const pool = await loadPool(client, poolAddress);

  const positions = positionNftMint
    ? [await resolvePosition(client, pool, wallet.publicKey, positionNftMint)]
    : await findPositions(client, pool, wallet.publicKey);
  if (positions.length === 0) {
    console.log('> No positions found on this pool for this wallet');
    return;
  }

  for (const position of positions) {
    const claimable = await client.position.getClaimableFees({
      pool: poolAddress,
      nftMint: position.nftMint,
    });
    console.log(
      `\n> Position ${position.nftMint.toString()}: ${getAmountInTokens(claimable.feeX, pool.mintX.decimals)} token X + ${getAmountInTokens(claimable.feeY, pool.mintY.decimals)} token Y in fees`
    );

    const steps: TransactionStep[] = [];
    if (!claimable.feeX.isZero() || !claimable.feeY.isZero()) {
      const claimedFees = await client.position.claimFee({
        pool: poolAddress,
        nftMint: position.nftMint,
        owner: wallet.publicKey,
        signer: wallet.publicKey,
        tokenXMint: pool.state.tokenXMint,
        tokenYMint: pool.state.tokenYMint,
        bitmap: claimable.bitmap,
        tickRanges: claimable.tickRanges,
      });
      steps.push({ label: 'claim fees', tx: claimedFees.tx, signers: [wallet.payer] });
    }
    steps.push(
      ...(await claimRewardSteps(
        client,
        pool,
        wallet,
        position.nftMint,
        claimable.bitmap,
        claimable.tickRanges
      ))
    );

    if (steps.length === 0) {
      console.log('- Nothing to claim');
      continue;
    }
    await executeSteps(connection, config, wallet.payer, steps);
  }
}

/**
 * Place a limit order on a DLMM Pro pool
 * @param config - The DLMM Pro config
 * @param connection - The connection to the network
 * @param wallet - The wallet that owns and pays for the order
 * @param poolAddress - The DLMM Pro pool address
 * @returns The limit order NFT mint
 */
export async function placeDlmmProLimitOrder(
  config: DlmmProConfig,
  connection: Connection,
  wallet: Wallet,
  poolAddress: PublicKey
): Promise<PublicKey> {
  validateBaseConfig(config);
  const settings = config.placeLimitOrder;
  if (!settings) {
    throw new Error(
      `Missing placeLimitOrder configuration. Ensure "placeLimitOrder" is set in ${CONFIG_FILE}.`
    );
  }
  const { side } = settings;
  if (side !== 'ask' && side !== 'bid') {
    throw new Error(`Invalid placeLimitOrder.side "${side}". Use "ask" (sell) or "bid" (buy).`);
  }
  if (!Array.isArray(settings.ticks) || settings.ticks.length === 0) {
    throw new Error('placeLimitOrder.ticks must contain at least one { price, amount } entry.');
  }

  console.log('\n> Placing DLMM Pro limit order...');
  const client = new DlmmProClient(connection, connection.commitment);
  const pool = await loadPool(client, poolAddress);
  const isAskSide = side === 'ask';
  const depositMint = isAskSide ? pool.mintX : pool.mintY;

  // An ask rests at or above its price and a bid at or below it, so neither fills at a worse
  // price than the one asked for. Prices that land on the same tick are merged.
  const amountByTickId = new Map<number, BN>();
  for (const tick of settings.ticks) {
    const tickId = isAskSide
      ? usableTickAtOrAbovePrice(pool.grid, tick.price)
      : usableTickAtOrBelowPrice(pool.grid, tick.price);
    const amount = getAmountInLamports(tick.amount, depositMint.decimals);
    amountByTickId.set(tickId, (amountByTickId.get(tickId) ?? new BN(0)).add(amount));
  }
  const ticks = [...amountByTickId.entries()]
    .sort(([a], [b]) => a - b)
    .map(([id, amount]) => ({ id, amount }));
  const total = ticks.reduce((sum, tick) => sum.add(tick.amount), new BN(0));
  const { epoch } = await readClock(connection, connection.commitment);

  console.log(
    `- Pool price: ${formatSqrtPrice(pool.grid, pool.state.sqrtPrice)} (tick ${pool.state.tickCurrentId})`
  );
  console.log(
    `- Order side: ${side} (${isAskSide ? 'selling token X' : 'buying token X with token Y'})`
  );
  for (const tick of ticks) {
    console.log(
      `- Tick ${tick.id} @ price ${formatTickPrice(pool.grid, tick.id)}: amount ${getAmountInTokens(tick.amount, depositMint.decimals)}`
    );
  }

  const nft = Keypair.generate();
  const placed = await client.limitOrder.openLimitOrder({
    pool: poolAddress,
    nftMint: nft.publicKey,
    owner: wallet.publicKey,
    payer: wallet.publicKey,
    tokenMint: depositMint.address,
    parameters: {
      isAskSide,
      maxAmount: calculateTransferFeeIncludedAmount(depositMint, epoch, total).amount,
      relativeTick: null,
      ticks,
    },
  });

  console.log(`\n> Limit order NFT mint: ${nft.publicKey.toString()}`);
  console.log(`> Limit order address: ${placed.limitOrder.toString()}`);

  await executeTransaction(connection, config, placed.tx, [wallet.payer, nft], 'place limit order');
  return nft.publicKey;
}

/**
 * Cancel limit orders on a DLMM Pro pool, withdraw what they hold and close them
 * @param config - The DLMM Pro config
 * @param connection - The connection to the network
 * @param wallet - The wallet that owns the orders
 * @param poolAddress - The DLMM Pro pool address
 * @param limitOrderNftMint - A specific order to cancel; when null, cancels every order of the wallet on the pool (requires cancelLimitOrder.cancelAll)
 */
export async function cancelDlmmProLimitOrder(
  config: DlmmProConfig,
  connection: Connection,
  wallet: Wallet,
  poolAddress: PublicKey,
  limitOrderNftMint: PublicKey | null
) {
  validateBaseConfig(config);
  console.log('\n> Cancelling DLMM Pro limit order(s)...');
  const client = new DlmmProClient(connection, connection.commitment);
  const { tokenXMint, tokenYMint } = await client.state.fetchPool(poolAddress);

  let orders: LimitOrderAccount[];
  if (limitOrderNftMint) {
    orders = [await resolveLimitOrder(client, poolAddress, limitOrderNftMint)];
  } else {
    if (!config.cancelLimitOrder?.cancelAll) {
      throw new Error(
        `Provide --limitOrder <NFT_MINT> or set cancelLimitOrder.cancelAll to true in ${CONFIG_FILE} to cancel every order.`
      );
    }
    orders = await findLimitOrders(client, poolAddress, wallet.publicKey);
    if (orders.length === 0) {
      console.log('> No limit orders to cancel');
      return;
    }
  }

  for (const order of orders) {
    const accounts = {
      pool: poolAddress,
      nftMint: order.nftMint,
      owner: wallet.publicKey,
    };
    const openTicks = order.ticks.filter(isOpenLimitOrderTick);
    console.log(
      `\n> Cancelling limit order ${order.nftMint.toString()} (${openTicks.length} open tick(s))`
    );

    const steps: TransactionStep[] = [];
    if (openTicks.length > 0) {
      const cancelled = await client.limitOrder.cancelLimitOrder({
        ...accounts,
        signer: wallet.publicKey,
        tokenXMint,
        tokenYMint,
      });
      steps.push({ label: 'cancel limit order', tx: cancelled.tx, signers: [wallet.payer] });
    }
    const closed = await client.limitOrder.closeLimitOrder({
      ...accounts,
      rentReceiver: wallet.publicKey,
    });
    steps.push({
      label: 'close limit order',
      tx: closed.tx,
      signers: [wallet.payer],
      dependsOnPriorStep: openTicks.length > 0,
    });

    await executeSteps(connection, config, wallet.payer, steps);
  }
}
