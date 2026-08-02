/**
 * Claim all DLMM swap fees (and optionally LM rewards) for a wallet on one pool.
 * Usage:
 *   npx ts-node dlmm-claim-fees.ts --pool <POOL> [--rewards] [--execute]
 */
import { PublicKey } from '@solana/web3.js';
import DLMM from '@meteora-ag/dlmm';
import { getConnection, loadKeypair, requireArg, simulateOrSend } from './lib/common';

async function main() {
  const connection = getConnection();
  const wallet = loadKeypair();
  const pool = new PublicKey(requireArg('pool', 'DLMM pool address'));
  const withRewards = process.argv.includes('--rewards');

  const dlmm = await DLMM.create(connection, pool);
  const { userPositions } = await dlmm.getPositionsByUserAndLbPair(wallet.publicKey);
  if (userPositions.length === 0) {
    console.log('No positions on this pool for this wallet.');
    return;
  }
  for (const p of userPositions) {
    console.log(
      `position ${p.publicKey.toBase58()}: feeX=${p.positionData.feeX.toString()} feeY=${p.positionData.feeY.toString()}`
    );
  }

  try {
    const txs = withRewards
      ? await dlmm.claimAllRewards({ owner: wallet.publicKey, positions: userPositions })
      : await dlmm.claimAllSwapFee({ owner: wallet.publicKey, positions: userPositions });
    let i = 0;
    for (const tx of txs) {
      await simulateOrSend(connection, tx, [wallet], `claim tx ${++i}/${txs.length}`);
    }
  } catch (e) {
    // SDK throws when there is nothing to claim
    console.log(`Nothing to claim: ${(e as Error).message}`);
  }
}

main().then(() => process.exit(0)).catch((e) => { console.error(e); process.exit(1); });
