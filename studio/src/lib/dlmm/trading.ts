import { Connection, PublicKey, sendAndConfirmTransaction } from '@solana/web3.js';
import { Wallet } from '@coral-xyz/anchor';
import DLMM from '@meteora-ag/dlmm';
import BN from 'bn.js';
import { unpackMint } from '@solana/spl-token';
import { DlmmConfig } from '../../utils/types';
import {
  modifyComputeUnitPriceIx,
  runSimulateTransaction,
  getAmountInLamports,
} from '../../helpers';
import { DEFAULT_SEND_TX_MAX_RETRIES } from '../../utils/constants';

/**
 * Swap on a DLMM pool. Reads config.dlmmSwap:
 * amountIn (human units of the input token), slippageBps, swapForY (true = sell X for Y).
 */
export async function swap(
  config: DlmmConfig,
  connection: Connection,
  wallet: Wallet,
  poolAddress: PublicKey
) {
  if (!config.dlmmSwap) {
    throw new Error('Missing dlmmSwap in configuration');
  }
  const { amountIn, slippageBps, swapForY } = config.dlmmSwap;

  console.log('\n> Initializing DLMM swap...');
  const payerBalance = await connection.getBalance(wallet.publicKey);
  if (payerBalance === 0) {
    throw new Error(
      `Wallet ${wallet.publicKey.toString()} has 0 SOL — fund it first; even dry-run simulation requires an existing fee payer account`
    );
  }

  const dlmmPool = await DLMM.create(connection, poolAddress);

  const inTokenKey = swapForY ? dlmmPool.tokenX.publicKey : dlmmPool.tokenY.publicKey;
  const outTokenKey = swapForY ? dlmmPool.tokenY.publicKey : dlmmPool.tokenX.publicKey;

  const inMintAccountInfo = await connection.getAccountInfo(inTokenKey);
  if (!inMintAccountInfo) {
    throw new Error(`Failed to fetch input mint ${inTokenKey.toString()}`);
  }
  const inMint = unpackMint(inTokenKey, inMintAccountInfo, inMintAccountInfo.owner);
  const amountInLamports = getAmountInLamports(amountIn, inMint.decimals);

  console.log(`- Pool ${poolAddress.toString()}`);
  console.log(
    `- Swapping ${amountIn} (${amountInLamports.toString()} lamports) ${swapForY ? 'X -> Y' : 'Y -> X'}`
  );

  const binArrays = await dlmmPool.getBinArrayForSwap(swapForY);
  const quote = dlmmPool.swapQuote(
    amountInLamports,
    swapForY,
    new BN(slippageBps),
    binArrays,
    false,
    3
  );

  console.log(`- Quote out: ${quote.outAmount.toString()} (min ${quote.minOutAmount.toString()})`);
  console.log(`- Price impact: ${quote.priceImpact.toString()}`);

  const swapTx = await dlmmPool.swap({
    inToken: inTokenKey,
    outToken: outTokenKey,
    inAmount: amountInLamports,
    minOutAmount: quote.minOutAmount,
    lbPair: dlmmPool.pubkey,
    user: wallet.publicKey,
    binArraysPubkey: quote.binArraysPubkey,
  });

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
