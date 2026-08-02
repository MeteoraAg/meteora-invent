/**
 * DAMM v2 (CP-AMM) swap (exact-in) — quote then swap. Token-2022 aware.
 * Usage:
 *   npx ts-node damm-v2-swap.ts --pool <POOL> --input-mint <MINT> --amount <BASE_UNITS> [--slippage 0.5] [--execute]
 */
import { PublicKey } from '@solana/web3.js';
import { BN } from '@coral-xyz/anchor';
import { CpAmm, getTokenProgram } from '@meteora-ag/cp-amm-sdk';
import { getMint, Mint, TOKEN_2022_PROGRAM_ID } from '@solana/spl-token';
import { getConnection, loadKeypair, requireArg, arg, simulateOrSend } from './lib/common';

type TokenInfo = { mint: Mint; currentEpoch: number } | null;

async function main() {
  const connection = getConnection();
  const wallet = loadKeypair();
  const pool = new PublicKey(requireArg('pool', 'DAMM v2 pool address'));
  const inputTokenMint = new PublicKey(requireArg('input-mint', 'input token mint'));
  const amountIn = new BN(requireArg('amount', 'input amount in base units'));
  const slippage = Number(arg('slippage') ?? '0.5');

  const cpAmm = new CpAmm(connection);
  const poolState = await cpAmm.fetchPoolState(pool);
  if (!inputTokenMint.equals(poolState.tokenAMint) && !inputTokenMint.equals(poolState.tokenBMint)) {
    throw new Error(
      `--input-mint is not part of this pool (tokenA=${poolState.tokenAMint.toBase58()}, tokenB=${poolState.tokenBMint.toBase58()})`
    );
  }
  const outputTokenMint = inputTokenMint.equals(poolState.tokenAMint)
    ? poolState.tokenBMint
    : poolState.tokenAMint;

  // token-2022 mints need { mint, currentEpoch } for transfer-fee math
  async function tokenInfoFor(mint: PublicKey): Promise<TokenInfo> {
    const acc = await connection.getAccountInfo(mint);
    if (acc && acc.owner.equals(TOKEN_2022_PROGRAM_ID)) {
      const m = await getMint(connection, mint, connection.commitment, TOKEN_2022_PROGRAM_ID);
      const epoch = await connection.getEpochInfo();
      return { mint: m, currentEpoch: epoch.epoch };
    }
    return null;
  }
  const tokenAInfo = await tokenInfoFor(poolState.tokenAMint);
  const tokenBInfo = await tokenInfoFor(poolState.tokenBMint);
  const tokenADecimal = (await getMint(connection, poolState.tokenAMint, connection.commitment,
    tokenAInfo ? TOKEN_2022_PROGRAM_ID : undefined)).decimals;
  const tokenBDecimal = (await getMint(connection, poolState.tokenBMint, connection.commitment,
    tokenBInfo ? TOKEN_2022_PROGRAM_ID : undefined)).decimals;

  const currentSlot = await connection.getSlot();
  const currentTime = await connection.getBlockTime(currentSlot);
  const inputIsA = inputTokenMint.equals(poolState.tokenAMint);

  const quote = cpAmm.getQuote({
    inAmount: amountIn,
    inputTokenMint,
    slippage,
    poolState,
    currentTime: currentTime!,
    currentSlot,
    inputTokenInfo: (inputIsA ? tokenAInfo : tokenBInfo)!,
    outputTokenInfo: (inputIsA ? tokenBInfo : tokenAInfo)!,
    tokenADecimal,
    tokenBDecimal,
  });
  console.log(`out:          ${quote.swapOutAmount.toString()}`);
  console.log(`min out:      ${quote.minSwapOutAmount.toString()}`);
  console.log(`total fee:    ${quote.totalFee.toString()}`);
  console.log(`price impact: ${quote.priceImpact.toFixed(4)}%`);

  const swapTx = await cpAmm.swap({
    payer: wallet.publicKey,
    pool,
    inputTokenMint,
    outputTokenMint,
    amountIn,
    minimumAmountOut: quote.minSwapOutAmount,
    tokenAVault: poolState.tokenAVault,
    tokenBVault: poolState.tokenBVault,
    tokenAMint: poolState.tokenAMint,
    tokenBMint: poolState.tokenBMint,
    tokenAProgram: getTokenProgram(poolState.tokenAFlag),
    tokenBProgram: getTokenProgram(poolState.tokenBFlag),
    referralTokenAccount: null,
  });
  await simulateOrSend(connection, swapTx, [wallet], 'DAMM v2 swap');
}

main().then(() => process.exit(0)).catch((e) => { console.error(e); process.exit(1); });
