import { Connection, PublicKey, sendAndConfirmTransaction, Transaction } from '@solana/web3.js';
import { DbcConfig } from '../../utils/types';
import { Wallet } from '@coral-xyz/anchor';
import { getQuoteDecimals, modifyComputeUnitPriceIx, runSimulateTransaction } from '../../helpers';
import { getAmountInLamports } from '../../helpers/common';
import { DEFAULT_SEND_TX_MAX_RETRIES } from '../../utils/constants';
import { DynamicBondingCurveClient, SwapMode } from '@meteora-ag/dynamic-bonding-curve-sdk';
import { getTransferHook, TOKEN_2022_PROGRAM_ID, unpackMint } from '@solana/spl-token';
import BN from 'bn.js';

/**
 * Resolve the base mint's decimals and transfer hook program, when one is configured.
 * @param connection - The connection to the network
 * @param baseMint - The base mint to inspect
 * @returns The mint decimals and the transfer hook program (null when the mint has no hook)
 */
async function getBaseMintInfo(
  connection: Connection,
  baseMint: PublicKey
): Promise<{ decimals: number; transferHookProgram: PublicKey | null }> {
  const mintAccount = await connection.getAccountInfo(baseMint, connection.commitment);
  if (!mintAccount) {
    throw new Error(`Base mint account not found: ${baseMint.toString()}`);
  }
  const mintState = unpackMint(baseMint, mintAccount, mintAccount.owner);

  let transferHookProgram: PublicKey | null = null;
  if (mintAccount.owner.equals(TOKEN_2022_PROGRAM_ID)) {
    const transferHook = getTransferHook(mintState);
    if (transferHook && !transferHook.programId.equals(PublicKey.default)) {
      transferHookProgram = transferHook.programId;
    }
  }

  return { decimals: mintState.decimals, transferHookProgram };
}

/**
 * Create a DBC config
 * @param config - The DBC config
 * @param connection - The connection to the network
 * @param wallet - The wallet to use for the transaction
 * @param quoteMint - The quote mint
 * @returns The public key of the DBC config
 */

/**
 * Claim trading fee from a DBC pool
 * @param config - The DBC config
 * @param connection - The connection to the network
 * @param wallet - The wallet to use for the transaction
 */
export async function claimTradingFee(
  config: DbcConfig,
  connection: Connection,
  wallet: Wallet,
  baseMint: PublicKey
) {
  console.log('\n> Initializing DBC claim trading fee...');

  const dbcInstance = new DynamicBondingCurveClient(connection, 'confirmed');

  const virtualPool = await dbcInstance.state.getPoolByBaseMint(baseMint);
  if (!virtualPool) {
    throw new Error(`DBC Pool not found for ${baseMint.toString()}`);
  }
  const poolState = virtualPool.account.poolState;

  const dbcConfigAddress = poolState.config;
  const poolConfig = await dbcInstance.state.getPoolConfig(dbcConfigAddress);
  if (!poolConfig) {
    throw new Error(`DBC Pool config not found for ${dbcConfigAddress.toString()}`);
  }

  const poolAddress = virtualPool.publicKey;
  const creator = poolState.creator;
  const partner = poolConfig.feeClaimer;
  const feeMetrics = await dbcInstance.state.getPoolFeeMetrics(poolAddress);

  const { transferHookProgram } = await getBaseMintInfo(connection, baseMint);
  if (transferHookProgram) {
    console.log(`> Base mint has transfer hook program: ${transferHookProgram.toString()}`);
  }

  const isCreator = creator.toString() === wallet.publicKey.toString();
  console.log(`> Is creator: ${isCreator}`);
  const isPartner = partner.toString() === wallet.publicKey.toString();
  console.log(`> Is partner: ${isPartner}`);

  if (!isCreator && !isPartner) {
    console.log('> User is neither the creator nor the launchpad fee claimer');
    return;
  }

  const transactions: Transaction[] = [];

  if (isCreator) {
    const claimCreatorParams = {
      creator: wallet.publicKey,
      pool: poolAddress,
      maxBaseAmount: feeMetrics.current.creatorBaseFee,
      maxQuoteAmount: feeMetrics.current.creatorQuoteFee,
      payer: wallet.publicKey,
    };
    const claimCreatorTradingFeeTx = transferHookProgram
      ? await dbcInstance.creator.claimCreatorTradingFee2({
          ...claimCreatorParams,
          receiver: wallet.publicKey,
        })
      : await dbcInstance.creator.claimCreatorTradingFee(claimCreatorParams);
    modifyComputeUnitPriceIx(claimCreatorTradingFeeTx, config.computeUnitPriceMicroLamports ?? 0);
    transactions.push(claimCreatorTradingFeeTx);
  } else {
    console.log('> This is not the creator of the pool');
  }

  if (isPartner) {
    const claimPartnerParams = {
      feeClaimer: wallet.publicKey,
      pool: poolAddress,
      maxBaseAmount: feeMetrics.current.partnerBaseFee,
      maxQuoteAmount: feeMetrics.current.partnerQuoteFee,
      payer: wallet.publicKey,
    };
    const claimPartnerTradingFeeTx = transferHookProgram
      ? await dbcInstance.partner.claimPartnerTradingFee2({
          ...claimPartnerParams,
          receiver: wallet.publicKey,
        })
      : await dbcInstance.partner.claimPartnerTradingFee(claimPartnerParams);
    modifyComputeUnitPriceIx(claimPartnerTradingFeeTx, config.computeUnitPriceMicroLamports ?? 0);
    transactions.push(claimPartnerTradingFeeTx);
  } else {
    console.log('> This is not the launchpad fee claimer');
  }

  if (transactions.length === 0) {
    console.log('> No trading fees to claim');
    return;
  }

  if (config.dryRun) {
    console.log('> Simulating claim trading fee tx...');
    await runSimulateTransaction(connection, [wallet.payer], wallet.publicKey, transactions);
    console.log('> Claim trading fee simulation successful');
    return;
  }

  try {
    for (let i = 0; i < transactions.length; i++) {
      const transaction = transactions[i];
      if (!transaction) {
        throw new Error(`Transaction at index ${i} is undefined`);
      }
      const txType = i === 0 && isCreator ? 'creator' : 'partner';

      console.log(`> Sending ${txType} trading fee claim transaction...`);

      const txHash = await sendAndConfirmTransaction(connection, transaction, [wallet.payer], {
        commitment: connection.commitment,
        maxRetries: DEFAULT_SEND_TX_MAX_RETRIES,
      });

      console.log(`> ${txType} trading fee claimed successfully with tx hash: ${txHash}`);
    }
  } catch (error) {
    console.error('Failed to claim trading fee:', error);
    throw error;
  }
}

/**
 * Swap on DBC pools (Buy or Sell)
 * @param config - The DBC config
 * @param connection - The connection to the network
 * @param wallet - The wallet to use for the transaction
 */
export async function swap(
  config: DbcConfig,
  connection: Connection,
  wallet: Wallet,
  baseMint: PublicKey
) {
  if (!config.dbcSwap) {
    throw new Error('Missing dbc swap parameters');
  }

  console.log('\n> Initializing DBC swap...');

  const dbcInstance = new DynamicBondingCurveClient(connection, 'confirmed');

  const virtualPool = await dbcInstance.state.getPoolByBaseMint(new PublicKey(baseMint));
  if (!virtualPool) {
    throw new Error(`DBC Pool not found for ${baseMint.toString()}`);
  }

  const poolAddress = virtualPool.publicKey;

  const dbcConfigAddress = virtualPool.account.poolState.config;
  const poolConfig = await dbcInstance.state.getPoolConfig(dbcConfigAddress);
  if (!poolConfig) {
    throw new Error(`DBC Pool config not found for ${dbcConfigAddress.toString()}`);
  }

  const { decimals: baseMintDecimals, transferHookProgram } = await getBaseMintInfo(
    connection,
    baseMint
  );
  const quoteMintDecimals = await getQuoteDecimals(connection, poolConfig.quoteMint.toString());
  const amountInDecimals = config.dbcSwap.swapBaseForQuote ? baseMintDecimals : quoteMintDecimals;
  const amountIn = getAmountInLamports(config.dbcSwap.amountIn, amountInDecimals);

  let currentPoint;
  if (poolConfig.activationType === 0) {
    currentPoint = await connection.getSlot();
  } else {
    const currentSlot = await connection.getSlot();
    currentPoint = await connection.getBlockTime(currentSlot);
  }

  if (currentPoint === null) {
    throw new Error('Failed to get current point (block time)');
  }

  const quote = await dbcInstance.pool.swapQuote({
    virtualPool: virtualPool.account,
    config: poolConfig,
    swapBaseForQuote: config.dbcSwap.swapBaseForQuote,
    amountIn,
    slippageBps: config.dbcSwap.slippageBps,
    hasReferral: !!config.dbcSwap.referralTokenAccount,
    currentPoint: new BN(currentPoint),
    eligibleForFirstSwapWithMinFee: false,
  });

  const referralTokenAccount = config.dbcSwap.referralTokenAccount
    ? new PublicKey(config.dbcSwap.referralTokenAccount)
    : null;

  let swapTx: Transaction;
  if (transferHookProgram) {
    console.log(`> Swapping through transfer hook program: ${transferHookProgram.toString()}`);
    swapTx = await dbcInstance.pool.swap2WithTransferHook({
      swapMode: SwapMode.ExactIn,
      amountIn,
      minimumAmountOut: quote.minimumAmountOut,
      owner: wallet.publicKey,
      pool: poolAddress,
      swapBaseForQuote: config.dbcSwap.swapBaseForQuote,
      referralTokenAccount,
      payer: wallet.publicKey,
    });
  } else {
    swapTx = await dbcInstance.pool.swap({
      amountIn,
      minimumAmountOut: quote.minimumAmountOut,
      owner: wallet.publicKey,
      pool: poolAddress,
      swapBaseForQuote: config.dbcSwap.swapBaseForQuote,
      referralTokenAccount,
    });
  }

  modifyComputeUnitPriceIx(swapTx, config.computeUnitPriceMicroLamports ?? 0);

  if (config.dryRun) {
    console.log('> Simulating swap tx...');
    await runSimulateTransaction(connection, [wallet.payer], wallet.publicKey, [swapTx]);
    console.log('> Swap tx simulation successful');
    return;
  }

  try {
    const txHash = await sendAndConfirmTransaction(connection, swapTx, [wallet.payer], {
      commitment: connection.commitment,
      maxRetries: DEFAULT_SEND_TX_MAX_RETRIES,
    });

    console.log(`> Swap tx successful with tx hash: ${txHash}`);
  } catch (error) {
    console.error('Failed to swap:', error);
    throw error;
  }
}
