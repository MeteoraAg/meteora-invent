import { Connection, PublicKey, sendAndConfirmTransaction } from '@solana/web3.js';
import { Wallet } from '@coral-xyz/anchor';
import { CpAmm, getTokenProgram, getUnClaimLpFee } from '@meteora-ag/cp-amm-sdk';
import { TOKEN_2022_PROGRAM_ID, unpackMint, Mint } from '@solana/spl-token';
import { DammV2Config } from '../../utils/types';
import {
  modifyComputeUnitPriceIx,
  runSimulateTransaction,
  getAmountInLamports,
} from '../../helpers';
import { DEFAULT_SEND_TX_MAX_RETRIES } from '../../utils/constants';

type TokenInfo = { mint: Mint; currentEpoch: number } | null;

/**
 * Swap on a DAMM v2 pool. Reads config.dammV2Swap:
 * inputMint (must be one of the pool's two mints), amountIn (human units), slippage (percent).
 */
export async function swap(
  config: DammV2Config,
  connection: Connection,
  wallet: Wallet,
  poolAddress: PublicKey
) {
  if (!config.dammV2Swap) {
    throw new Error('Missing dammV2Swap in configuration');
  }
  const inputTokenMint = new PublicKey(config.dammV2Swap.inputMint);
  const { amountIn, slippage } = config.dammV2Swap;

  console.log('\n> Initializing DAMM v2 swap...');
  const payerBalance = await connection.getBalance(wallet.publicKey);
  if (payerBalance === 0) {
    throw new Error(
      `Wallet ${wallet.publicKey.toString()} has 0 SOL — fund it first; even dry-run simulation requires an existing fee payer account`
    );
  }

  const cpAmmInstance = new CpAmm(connection);
  const poolState = await cpAmmInstance.fetchPoolState(poolAddress);

  if (
    !inputTokenMint.equals(poolState.tokenAMint) &&
    !inputTokenMint.equals(poolState.tokenBMint)
  ) {
    throw new Error(
      `inputMint is not part of this pool (tokenA=${poolState.tokenAMint.toString()}, tokenB=${poolState.tokenBMint.toString()})`
    );
  }
  const outputTokenMint = inputTokenMint.equals(poolState.tokenAMint)
    ? poolState.tokenBMint
    : poolState.tokenAMint;

  const tokenAMintInfo = await connection.getAccountInfo(poolState.tokenAMint);
  const tokenBMintInfo = await connection.getAccountInfo(poolState.tokenBMint);
  if (!tokenAMintInfo || !tokenBMintInfo) {
    throw new Error('Failed to fetch token mint information');
  }
  const tokenAMintData = unpackMint(poolState.tokenAMint, tokenAMintInfo, tokenAMintInfo.owner);
  const tokenBMintData = unpackMint(poolState.tokenBMint, tokenBMintInfo, tokenBMintInfo.owner);

  const epochInfo = await connection.getEpochInfo();
  const tokenAInfo: TokenInfo = tokenAMintInfo.owner.equals(TOKEN_2022_PROGRAM_ID)
    ? { mint: tokenAMintData, currentEpoch: epochInfo.epoch }
    : null;
  const tokenBInfo: TokenInfo = tokenBMintInfo.owner.equals(TOKEN_2022_PROGRAM_ID)
    ? { mint: tokenBMintData, currentEpoch: epochInfo.epoch }
    : null;

  const inputIsA = inputTokenMint.equals(poolState.tokenAMint);
  const amountInLamports = getAmountInLamports(
    amountIn,
    inputIsA ? tokenAMintData.decimals : tokenBMintData.decimals
  );

  const currentSlot = await connection.getSlot();
  const currentTime = await connection.getBlockTime(currentSlot);
  if (!currentTime) {
    throw new Error('Failed to fetch current block time');
  }

  const quote = cpAmmInstance.getQuote({
    inAmount: amountInLamports,
    inputTokenMint,
    slippage,
    poolState,
    currentTime,
    currentSlot,
    inputTokenInfo: (inputIsA ? tokenAInfo : tokenBInfo)!,
    outputTokenInfo: (inputIsA ? tokenBInfo : tokenAInfo)!,
    tokenADecimal: tokenAMintData.decimals,
    tokenBDecimal: tokenBMintData.decimals,
  });

  console.log(`- Pool ${poolAddress.toString()}`);
  console.log(
    `- Swapping ${amountIn} (${amountInLamports.toString()} lamports) of ${inputTokenMint.toString()}`
  );
  console.log(
    `- Quote out: ${quote.swapOutAmount.toString()} (min ${quote.minSwapOutAmount.toString()})`
  );
  console.log(`- Price impact: ${quote.priceImpact.toFixed(4)}%`);

  const swapTx = await cpAmmInstance.swap({
    payer: wallet.publicKey,
    pool: poolAddress,
    inputTokenMint,
    outputTokenMint,
    amountIn: amountInLamports,
    minimumAmountOut: quote.minSwapOutAmount,
    tokenAVault: poolState.tokenAVault,
    tokenBVault: poolState.tokenBVault,
    tokenAMint: poolState.tokenAMint,
    tokenBMint: poolState.tokenBMint,
    tokenAProgram: getTokenProgram(poolState.tokenAFlag),
    tokenBProgram: getTokenProgram(poolState.tokenBFlag),
    referralTokenAccount: null,
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

/**
 * List the wallet's positions on a DAMM v2 pool with unclaimed fees (read-only).
 */
export async function getPositions(connection: Connection, wallet: Wallet, poolAddress: PublicKey) {
  const cpAmmInstance = new CpAmm(connection);
  const poolState = await cpAmmInstance.fetchPoolState(poolAddress);
  const userPositions = await cpAmmInstance.getUserPositionByPool(poolAddress, wallet.publicKey);

  console.log(`\n> Pool ${poolAddress.toString()}`);
  if (userPositions.length === 0) {
    console.log('> No positions found on this pool for this wallet');
    return;
  }
  for (const userPosition of userPositions) {
    const positionState = await cpAmmInstance.fetchPositionState(userPosition.position);
    const unclaimedLpFee = getUnClaimLpFee(poolState, positionState);
    console.log(`\n> Position ${userPosition.position.toString()}`);
    console.log(`  - Unlocked liquidity: ${positionState.unlockedLiquidity.toString()}`);
    console.log(`  - Vested liquidity: ${positionState.vestedLiquidity.toString()}`);
    console.log(
      `  - Permanent locked liquidity: ${positionState.permanentLockedLiquidity.toString()}`
    );
    console.log(
      `  - Unclaimed fees: tokenA=${unclaimedLpFee.feeTokenA.toString()} tokenB=${unclaimedLpFee.feeTokenB.toString()}`
    );
  }
}
