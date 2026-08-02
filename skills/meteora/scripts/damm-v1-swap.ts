/**
 * DAMM v1 swap (exact-in) — quote then swap.
 * Usage:
 *   npx ts-node damm-v1-swap.ts --pool <POOL> --input-mint <MINT> --amount <BASE_UNITS> [--slippage 0.5] [--execute]
 */
import { PublicKey } from '@solana/web3.js';
import AmmImpl from '@meteora-ag/dynamic-amm-sdk';
import BN from 'bn.js';
import { getConnection, loadKeypair, requireArg, arg, simulateOrSend } from './lib/common';

async function main() {
  const connection = getConnection();
  const wallet = loadKeypair();
  const poolAddress = new PublicKey(requireArg('pool', 'DAMM v1 pool address'));
  const inputTokenMint = new PublicKey(requireArg('input-mint', 'input token mint'));
  const amountIn = new BN(requireArg('amount', 'input amount in base units'));
  const slippage = Number(arg('slippage') ?? '0.5');

  // `as any` at the SDK boundary: dynamic-amm-sdk pins @solana/web3.js exactly at 1.98.0,
  // which registers as a distinct type identity when another copy exists in node_modules.
  const pool = await AmmImpl.create(connection as any, poolAddress);
  await pool.updateState(); // refresh cached reserves before quoting

  const quote = pool.getSwapQuote(inputTokenMint, amountIn, slippage);
  console.log(`out:     ${quote.swapOutAmount.toString()}`);
  console.log(`min out: ${quote.minSwapOutAmount.toString()}`);
  console.log(`fee:     ${quote.fee.toString()}`);

  const swapTx = await pool.swap(
    wallet.publicKey,
    inputTokenMint,
    amountIn,
    quote.minSwapOutAmount
  );
  await simulateOrSend(connection, swapTx as any, [wallet], 'DAMM v1 swap');
}

main().then(() => process.exit(0)).catch((e) => { console.error(e); process.exit(1); });
