import { BN, Wallet } from '@coral-xyz/anchor';
import {
  ActivationType,
  BaseFee,
  BIN_STEP_BPS_DEFAULT,
  BIN_STEP_BPS_U128_DEFAULT,
  calculateTransferFeeIncludedAmount,
  CpAmm,
  getBaseFeeParams,
  getDynamicFeeParams,
  getLiquidityDeltaFromAmountA,
  getPriceFromSqrtPrice,
  getSqrtPriceFromPrice,
  MAX_SQRT_PRICE,
  MIN_SQRT_PRICE,
  PoolFeesParams,
} from '@meteora-ag/cp-amm-sdk';
import { TOKEN_2022_PROGRAM_ID, TOKEN_PROGRAM_ID, unpackMint } from '@solana/spl-token';
import { Connection, Keypair, PublicKey, sendAndConfirmTransaction } from '@solana/web3.js';
import { ActivationTypeConfig, DammV2Config } from '../utils/types';
import {
  getAmountInLamports,
  getDecimalizedAmount,
  getQuoteDecimals,
  modifyComputeUnitPriceIx,
  runSimulateTransaction,
} from '../helpers';
import { DEFAULT_SEND_TX_MAX_RETRIES } from '../utils/constants';

export function getDammV2ActivationType(activationType: ActivationTypeConfig): ActivationType {
  if (activationType == ActivationTypeConfig.Slot) {
    return ActivationType.Slot;
  } else if (activationType == ActivationTypeConfig.Timestamp) {
    return ActivationType.Timestamp;
  } else {
    throw new Error(`Unsupported Dynamic AMM activation type: ${activationType}`);
  }
}

export async function createDammV2OneSidedTokenAPool(
  config: DammV2Config,
  connection: Connection,
  wallet: Wallet,
  baseTokenMint: PublicKey,
  quoteTokenMint: PublicKey
) {
  if (!config.dynamicAmmV2) {
    throw new Error('Missing dynamic amm v2 configuration');
  }
  console.log('\n> Initializing one-sided Dynamic AMM V2 pool...');

  const quoteDecimals = await getQuoteDecimals(connection, config.quoteMint);

  let baseTokenInfo = null;
  let baseTokenProgram = TOKEN_PROGRAM_ID;

  const baseMintAccountInfo = await connection.getAccountInfo(
    new PublicKey(baseTokenMint),
    connection.commitment
  );

  const baseMint = unpackMint(baseTokenMint, baseMintAccountInfo, baseMintAccountInfo.owner);

  if (baseMintAccountInfo.owner.equals(TOKEN_2022_PROGRAM_ID)) {
    const epochInfo = await connection.getEpochInfo();
    baseTokenInfo = {
      mint: baseMint,
      currentEpoch: epochInfo.epoch,
    };
    baseTokenProgram = TOKEN_2022_PROGRAM_ID;
  }

  const baseDecimals = baseMint.decimals;

  // create cp amm instance
  const cpAmmInstance = new CpAmm(connection);
  const {
    initPrice,
    maxPrice,
    poolFees,
    baseAmount,
    quoteAmount,
    hasAlphaVault,
    activationPoint,
    activationType,
    collectFeeMode,
  } = config.dynamicAmmV2;

  const {
    maxBaseFeeBps,
    minBaseFeeBps,
    feeSchedulerMode,
    totalDuration,
    numberOfPeriod,
    useDynamicFee,
  } = poolFees;
  // setup pool params

  let tokenAAmount = getAmountInLamports(baseAmount, baseDecimals);
  let tokenBAmount = new BN(0);
  // transfer fee if token2022
  if (baseTokenInfo) {
    tokenAAmount = tokenAAmount.sub(
      calculateTransferFeeIncludedAmount(
        tokenAAmount,
        baseTokenInfo.mint,
        baseTokenInfo.currentEpoch
      ).transferFee
    );
  }

  const maxSqrtPrice = maxPrice
    ? getSqrtPriceFromPrice(maxPrice.toString(), baseDecimals, quoteDecimals)
    : MAX_SQRT_PRICE;

  const initSqrtPrice = getSqrtPriceFromPrice(initPrice.toString(), baseDecimals, quoteDecimals);
  let minSqrtPrice = initSqrtPrice;

  const liquidityDelta = getLiquidityDeltaFromAmountA(tokenAAmount, initSqrtPrice, maxSqrtPrice);

  if (quoteAmount) {
    tokenBAmount = getAmountInLamports(quoteAmount, quoteDecimals);
    // L = Δb / (√P_upper - √P_lower)
    // √P_lower = √P_upper - Δb / L
    const numerator = tokenBAmount.shln(128).div(liquidityDelta);
    minSqrtPrice = initSqrtPrice.sub(numerator);
  }
  console.log(
    `- Using base token with amount = ${getDecimalizedAmount(tokenAAmount, baseDecimals)}`
  );
  console.log(`- Init price ${getPriceFromSqrtPrice(initSqrtPrice, baseDecimals, quoteDecimals)}`);

  console.log(
    `- Price range [${getPriceFromSqrtPrice(minSqrtPrice, baseDecimals, quoteDecimals)}, ${getPriceFromSqrtPrice(maxSqrtPrice, baseDecimals, quoteDecimals)}]`
  );

  const activationTypeValue = getDammV2ActivationType(activationType);

  let dynamicFee = null;
  if (useDynamicFee) {
    const dynamicFeeConfig = config.dynamicAmmV2.poolFees.dynamicFeeConfig;
    if (dynamicFeeConfig) {
      dynamicFee = {
        binStep: BIN_STEP_BPS_DEFAULT,
        binStepU128: BIN_STEP_BPS_U128_DEFAULT,
        filterPeriod: dynamicFeeConfig.filterPeriod,
        decayPeriod: dynamicFeeConfig.decayPeriod,
        reductionFactor: dynamicFeeConfig.reductionFactor,
        variableFeeControl: dynamicFeeConfig.variableFeeControl,
        maxVolatilityAccumulator: dynamicFeeConfig.maxVolatilityAccumulator,
      };
    } else {
      dynamicFee = getDynamicFeeParams(config.dynamicAmmV2.poolFees.minBaseFeeBps);
    }
  }

  const baseFee: BaseFee = getBaseFeeParams(
    maxBaseFeeBps,
    minBaseFeeBps,
    feeSchedulerMode,
    numberOfPeriod,
    totalDuration
  );

  const poolFeesParams: PoolFeesParams = {
    baseFee,
    protocolFeePercent: 20,
    partnerFeePercent: 0,
    referralFeePercent: 20,
    dynamicFee,
  };
  const positionNft = Keypair.generate();

  const {
    tx: initCustomizePoolTx,
    pool,
    position,
  } = await cpAmmInstance.createCustomPool({
    payer: wallet.publicKey,
    creator: new PublicKey(config.dynamicAmmV2.creator),
    positionNft: positionNft.publicKey,
    tokenAMint: baseTokenMint,
    tokenBMint: quoteTokenMint,
    tokenAAmount: tokenAAmount,
    tokenBAmount: tokenBAmount,
    sqrtMinPrice: minSqrtPrice,
    sqrtMaxPrice: maxSqrtPrice,
    liquidityDelta: liquidityDelta,
    initSqrtPrice,
    poolFees: poolFeesParams,
    hasAlphaVault: hasAlphaVault,
    activationType: activationTypeValue,
    collectFeeMode: collectFeeMode,
    activationPoint: activationPoint ? new BN(activationPoint) : null,
    tokenAProgram: baseTokenProgram,
    tokenBProgram: TOKEN_PROGRAM_ID,
  });

  modifyComputeUnitPriceIx(initCustomizePoolTx, config.computeUnitPriceMicroLamports);

  console.log(`\n> Pool address: ${pool}`);
  console.log(`\n> Position address: ${position}`);

  if (config.dryRun) {
    console.log(`> Simulating init pool tx...`);
    await runSimulateTransaction(connection, [wallet.payer, positionNft], wallet.publicKey, [
      initCustomizePoolTx,
    ]);
  } else {
    console.log(`>> Sending init pool transaction...`);
    const initPoolTxHash = await sendAndConfirmTransaction(
      connection,
      initCustomizePoolTx,
      [wallet.payer, positionNft],
      {
        commitment: connection.commitment,
        maxRetries: DEFAULT_SEND_TX_MAX_RETRIES,
      }
    ).catch((err) => {
      console.error(err);
      throw err;
    });
    console.log(`>>> Pool initialized successfully with tx hash: ${initPoolTxHash}`);
  }
}

export async function createDammV2BalancedPool(
  config: DammV2Config,
  connection: Connection,
  wallet: Wallet,
  baseTokenMint: PublicKey,
  quoteTokenMint: PublicKey
) {
  if (!config.dynamicAmmV2) {
    throw new Error('Missing dynamic amm v2 configuration');
  }
  console.log('\n> Initializing balanced Dynamic AMM V2 pool...');

  const quoteDecimals = await getQuoteDecimals(connection, config.quoteMint);

  let baseTokenInfo = null;
  let baseTokenProgram = TOKEN_PROGRAM_ID;
  let quoteTokenInfo = null;
  let quoteTokenProgram = TOKEN_PROGRAM_ID;

  const baseMintAccountInfo = await connection.getAccountInfo(
    new PublicKey(baseTokenMint),
    connection.commitment
  );

  const baseMint = unpackMint(baseTokenMint, baseMintAccountInfo, baseMintAccountInfo.owner);

  if (baseMintAccountInfo.owner.equals(TOKEN_2022_PROGRAM_ID)) {
    const epochInfo = await connection.getEpochInfo();
    baseTokenInfo = {
      mint: baseMint,
      currentEpoch: epochInfo.epoch,
    };
    baseTokenProgram = TOKEN_2022_PROGRAM_ID;
  }

  const quoteMintAccountInfo = await connection.getAccountInfo(
    new PublicKey(quoteTokenMint),
    connection.commitment
  );

  const quoteMint = unpackMint(quoteTokenMint, quoteMintAccountInfo, quoteMintAccountInfo.owner);

  if (quoteMintAccountInfo.owner.equals(TOKEN_2022_PROGRAM_ID)) {
    const epochInfo = await connection.getEpochInfo();
    quoteTokenInfo = {
      mint: quoteMint,
      currentEpoch: epochInfo.epoch,
    };
    quoteTokenProgram = TOKEN_2022_PROGRAM_ID;
  }

  const baseDecimals = baseMint.decimals;

  // create cp amm instance
  const cpAmmInstance = new CpAmm(connection);
  const {
    initPrice,
    poolFees,
    baseAmount,
    quoteAmount,
    hasAlphaVault,
    activationPoint,
    activationType,
    collectFeeMode,
  } = config.dynamicAmmV2;

  const {
    maxBaseFeeBps,
    minBaseFeeBps,
    feeSchedulerMode,
    totalDuration,
    numberOfPeriod,
    useDynamicFee,
  } = poolFees;

  if (!quoteAmount) {
    throw new Error('Quote amount is required for balanced pool');
  }

  let tokenAAmount = getAmountInLamports(baseAmount, baseDecimals);
  let tokenBAmount = getAmountInLamports(quoteAmount, quoteDecimals);

  if (baseTokenInfo) {
    tokenAAmount = tokenAAmount.sub(
      calculateTransferFeeIncludedAmount(
        tokenAAmount,
        baseTokenInfo.mint,
        baseTokenInfo.currentEpoch
      ).transferFee
    );
  }

  if (quoteTokenInfo) {
    tokenBAmount = tokenBAmount.sub(
      calculateTransferFeeIncludedAmount(
        tokenBAmount,
        quoteTokenInfo.mint,
        quoteTokenInfo.currentEpoch
      ).transferFee
    );
  }

  const initSqrtPrice = getSqrtPriceFromPrice(initPrice.toString(), baseDecimals, quoteDecimals);

  const minSqrtPrice = MIN_SQRT_PRICE;
  const maxSqrtPrice = MAX_SQRT_PRICE;

  const liquidityDelta = cpAmmInstance.getLiquidityDelta({
    maxAmountTokenA: tokenAAmount,
    maxAmountTokenB: tokenBAmount,
    sqrtPrice: initSqrtPrice,
    sqrtMinPrice: minSqrtPrice,
    sqrtMaxPrice: maxSqrtPrice,
    tokenAInfo: baseTokenInfo,
  });
  console.log(
    `- Using base token with amount = ${getDecimalizedAmount(tokenAAmount, baseDecimals)}`
  );
  console.log(
    `- Using quote token with amount = ${getDecimalizedAmount(tokenBAmount, quoteDecimals)}`
  );
  console.log(`- Init price ${getPriceFromSqrtPrice(initSqrtPrice, baseDecimals, quoteDecimals)}`);

  console.log(
    `- Price range [${getPriceFromSqrtPrice(minSqrtPrice, baseDecimals, quoteDecimals)}, ${getPriceFromSqrtPrice(maxSqrtPrice, baseDecimals, quoteDecimals)}]`
  );

  const activationTypeValue = getDammV2ActivationType(activationType);

  let dynamicFee = null;
  if (useDynamicFee) {
    const dynamicFeeConfig = config.dynamicAmmV2.poolFees.dynamicFeeConfig;
    if (dynamicFeeConfig) {
      dynamicFee = {
        binStep: BIN_STEP_BPS_DEFAULT,
        binStepU128: BIN_STEP_BPS_U128_DEFAULT,
        filterPeriod: dynamicFeeConfig.filterPeriod,
        decayPeriod: dynamicFeeConfig.decayPeriod,
        reductionFactor: dynamicFeeConfig.reductionFactor,
        variableFeeControl: dynamicFeeConfig.variableFeeControl,
        maxVolatilityAccumulator: dynamicFeeConfig.maxVolatilityAccumulator,
      };
    } else {
      dynamicFee = getDynamicFeeParams(config.dynamicAmmV2.poolFees.minBaseFeeBps);
    }
  }

  const baseFee: BaseFee = getBaseFeeParams(
    maxBaseFeeBps,
    minBaseFeeBps,
    feeSchedulerMode,
    numberOfPeriod,
    totalDuration
  );

  const poolFeesParams: PoolFeesParams = {
    baseFee,
    protocolFeePercent: 20,
    partnerFeePercent: 0,
    referralFeePercent: 20,
    dynamicFee,
  };
  const positionNft = Keypair.generate();

  const {
    tx: initCustomizePoolTx,
    pool,
    position,
  } = await cpAmmInstance.createCustomPool({
    payer: wallet.publicKey,
    creator: new PublicKey(config.dynamicAmmV2.creator),
    positionNft: positionNft.publicKey,
    tokenAMint: baseTokenMint,
    tokenBMint: quoteTokenMint,
    tokenAAmount: tokenAAmount,
    tokenBAmount: tokenBAmount,
    sqrtMinPrice: minSqrtPrice,
    sqrtMaxPrice: maxSqrtPrice,
    liquidityDelta: liquidityDelta,
    initSqrtPrice,
    poolFees: poolFeesParams,
    hasAlphaVault: hasAlphaVault,
    activationType: activationTypeValue,
    collectFeeMode: collectFeeMode,
    activationPoint: activationPoint ? new BN(activationPoint) : null,
    tokenAProgram: baseTokenProgram,
    tokenBProgram: TOKEN_PROGRAM_ID,
  });

  modifyComputeUnitPriceIx(initCustomizePoolTx, config.computeUnitPriceMicroLamports);

  console.log(`\n> Pool address: ${pool}`);
  console.log(`\n> Position address: ${position}`);

  if (config.dryRun) {
    console.log(`> Simulating init pool tx...`);
    await runSimulateTransaction(connection, [wallet.payer, positionNft], wallet.publicKey, [
      initCustomizePoolTx,
    ]);
  } else {
    console.log(`>> Sending init pool transaction...`);
    const initPoolTxHash = await sendAndConfirmTransaction(
      connection,
      initCustomizePoolTx,
      [wallet.payer, positionNft],
      {
        commitment: connection.commitment,
        maxRetries: DEFAULT_SEND_TX_MAX_RETRIES,
      }
    ).catch((err) => {
      console.error(err);
      throw err;
    });
    console.log(`>>> Pool initialized successfully with tx hash: ${initPoolTxHash}`);
  }
}
