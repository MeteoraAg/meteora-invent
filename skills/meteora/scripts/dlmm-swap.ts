/**
 * DLMM swap (exact-in) — quote then swap.
 * Usage:
 *   npx ts-node dlmm-swap.ts --pool <POOL> --amount <BASE_UNITS> --side buy|sell [--slippage-bps 100] [--execute]
 *   side: sell = X -> Y (swapForY), buy = Y -> X. Amount is in base units of the INPUT token.
 */
import { PublicKey } from '@solana/web3.js';
import DLMM from '@meteora-ag/dlmm';
import BN from 'bn.js';
import { getConnection, loadKeypair, requireArg, arg, simulateOrSend } from './lib/common';

async function main() {
  const connection = getConnection();
  const wallet = loadKeypair();
  const pool = new PublicKey(requireArg('pool', 'DLMM pool address'));
  const amount = new BN(requireArg('amount', 'input amount in base units'));
  const side = requireArg('side', 'buy|sell');
  const slippageBps = new BN(arg('slippage-bps') ?? '100');
  const swapForY = side === 'sell'; // sell X for Y

  const dlmm = await DLMM.create(connection, pool);
  const binArrays = await dlmm.getBinArrayForSwap(swapForY);
  const quote = dlmm.swapQuote(amount, swapForY, slippageBps, binArrays, false, 3);

  console.log(`in (consumed): ${quote.consumedInAmount.toString()}`);
  console.log(`out:           ${quote.outAmount.toString()}`);
  console.log(`min out:       ${quote.minOutAmount.toString()}`);
  console.log(`price impact:  ${quote.priceImpact.toString()}`);

  const swapTx = await dlmm.swap({
    inToken: swapForY ? dlmm.tokenX.publicKey : dlmm.tokenY.publicKey,
    outToken: swapForY ? dlmm.tokenY.publicKey : dlmm.tokenX.publicKey,
    inAmount: amount,
    minOutAmount: quote.minOutAmount,
    lbPair: dlmm.pubkey,
    user: wallet.publicKey,
    binArraysPubkey: quote.binArraysPubkey,
  });
  await simulateOrSend(connection, swapTx, [wallet], 'DLMM swap');
}

main().then(() => process.exit(0)).catch((e) => { console.error(e); process.exit(1); });
