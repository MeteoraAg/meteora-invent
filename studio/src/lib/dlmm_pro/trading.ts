import { Wallet } from '@coral-xyz/anchor';
import { DlmmProClient } from '@meteora-ag/dlmm-pro-sdk';
import { Connection, PublicKey } from '@solana/web3.js';
import { getAmountInLamports, getAmountInTokens } from '../../helpers';
import { validateBaseConfig } from '../../helpers/config-validation';
import { DlmmProConfig } from '../../utils/types';
import { assertBps, executeTransaction, formatSqrtPrice, loadPool } from './utils';

/**
 * Swap on a DLMM Pro pool. Reads config.dlmmProSwap:
 * amountIn (human units of the input token), slippageBps, swapForY (true = sell X for Y).
 */
export async function swap(
  config: DlmmProConfig,
  connection: Connection,
  wallet: Wallet,
  poolAddress: PublicKey
) {
  validateBaseConfig(config);
  if (!config.dlmmProSwap) {
    throw new Error('Missing dlmmProSwap in configuration');
  }
  const { amountIn, slippageBps, swapForY } = config.dlmmProSwap;
  assertBps('dlmmProSwap.slippageBps', slippageBps, 0);

  console.log('\n> Initializing DLMM Pro swap...');
  const client = new DlmmProClient(connection, connection.commitment);
  const pool = await loadPool(client, poolAddress);
  const inputMint = swapForY ? pool.mintX : pool.mintY;
  const outputMint = swapForY ? pool.mintY : pool.mintX;
  const inputAmount = getAmountInLamports(amountIn, inputMint.decimals);

  console.log(`- Pool ${poolAddress.toString()}`);
  console.log(
    `- Swapping ${amountIn} (${inputAmount.toString()} lamports) ${swapForY ? 'X -> Y' : 'Y -> X'}`
  );

  const { quote, tickArrays, tickArrayBitmapExtension } = await client.pool.quoteExactIn({
    pool: poolAddress,
    inputAmount,
    swapForY,
    swapper: wallet.publicKey,
  });
  if (!quote.amountLeft.isZero()) {
    throw new Error(
      `Not enough liquidity for this input: ${getAmountInTokens(quote.amountLeft, inputMint.decimals)} of ${amountIn} would be left unswapped. Lower dlmmProSwap.amountIn.`
    );
  }
  const minimumOutputAmount = quote.transferFeeExcludedOutAmount
    .muln(10_000 - slippageBps)
    .divn(10_000);

  console.log(
    `- Quote out: ${getAmountInTokens(quote.transferFeeExcludedOutAmount, outputMint.decimals)} (min ${getAmountInTokens(minimumOutputAmount, outputMint.decimals)})`
  );
  console.log(
    `- Price: ${formatSqrtPrice(pool.grid, pool.state.sqrtPrice)} -> ${formatSqrtPrice(pool.grid, quote.nextSqrtPrice)}`
  );

  const { tx } = await client.pool.swap({
    pool: poolAddress,
    tokenXMint: pool.state.tokenXMint,
    tokenYMint: pool.state.tokenYMint,
    user: wallet.publicKey,
    swapForY,
    tickArrays,
    tickArrayBitmapExtension,
    parameters: { inputAmount, minimumOutputAmount },
  });

  await executeTransaction(connection, config, tx, [wallet.payer], 'swap');
}
