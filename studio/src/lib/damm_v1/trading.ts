import { Connection, PublicKey, sendAndConfirmTransaction } from '@solana/web3.js';
import { Wallet } from '@coral-xyz/anchor';
import AmmImpl from '@meteora-ag/dynamic-amm-sdk';
import { DammV1Config } from '../../utils/types';
import {
  modifyComputeUnitPriceIx,
  runSimulateTransaction,
  getAmountInLamports,
} from '../../helpers';
import { DEFAULT_SEND_TX_MAX_RETRIES } from '../../utils/constants';

/**
 * Swap on a DAMM v1 pool. Reads config.dammV1Swap:
 * inputMint (one of the pool's two mints), amountIn (human units), slippage (percent).
 * `as any` casts at the SDK boundary: dynamic-amm-sdk pins @solana/web3.js at exactly
 * 1.98.0, which registers as a distinct type identity from the workspace copy.
 */
export async function swap(
  config: DammV1Config,
  connection: Connection,
  wallet: Wallet,
  poolAddress: PublicKey
) {
  if (!config.dammV1Swap) {
    throw new Error('Missing dammV1Swap in configuration');
  }
  const inputTokenMint = new PublicKey(config.dammV1Swap.inputMint);
  const { amountIn, slippage } = config.dammV1Swap;

  console.log('\n> Initializing DAMM v1 swap...');
  const payerBalance = await connection.getBalance(wallet.publicKey);
  if (payerBalance === 0) {
    throw new Error(
      `Wallet ${wallet.publicKey.toString()} has 0 SOL — fund it first; even dry-run simulation requires an existing fee payer account`
    );
  }

  const pool = await AmmImpl.create(connection as any, poolAddress as any);
  await pool.updateState();

  let inputDecimals: number;
  if (inputTokenMint.toString() === pool.tokenAMint.address.toString()) {
    inputDecimals = pool.tokenAMint.decimals;
  } else if (inputTokenMint.toString() === pool.tokenBMint.address.toString()) {
    inputDecimals = pool.tokenBMint.decimals;
  } else {
    throw new Error(
      `inputMint is not part of this pool (tokenA=${pool.tokenAMint.address.toString()}, tokenB=${pool.tokenBMint.address.toString()})`
    );
  }

  const amountInLamports = getAmountInLamports(amountIn, inputDecimals);
  const quote = pool.getSwapQuote(inputTokenMint as any, amountInLamports as any, slippage);

  console.log(`- Pool ${poolAddress.toString()}`);
  console.log(
    `- Swapping ${amountIn} (${amountInLamports.toString()} lamports) of ${inputTokenMint.toString()}`
  );
  console.log(
    `- Quote out: ${quote.swapOutAmount.toString()} (min ${quote.minSwapOutAmount.toString()})`
  );

  const swapTx = (await pool.swap(
    wallet.publicKey as any,
    inputTokenMint as any,
    amountInLamports as any,
    quote.minSwapOutAmount
  )) as any;

  modifyComputeUnitPriceIx(swapTx, config.computeUnitPriceMicroLamports ?? 0);

  if (config.dryRun) {
    console.log(`\n> Simulating swap transaction...`);
    await runSimulateTransaction(connection, [wallet.payer], wallet.publicKey, [swapTx]);
    console.log('> Swap simulation successful');
  } else {
    console.log(`\n>> Sending swap transaction...`);
    const txHash = await sendAndConfirmTransaction(connection, swapTx, [wallet.payer], {
      commitment: 'confirmed',
      maxRetries: DEFAULT_SEND_TX_MAX_RETRIES,
    });
    console.log(`>>> Swap successful with tx hash: ${txHash}`);
  }
}
