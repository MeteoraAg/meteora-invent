/**
 * List a wallet's Meteora positions (read-only).
 * Usage:
 *   npx ts-node positions.ts --owner <WALLET> [--protocol dlmm|damm-v2|all] [--pool <POOL>]
 */
import { PublicKey } from '@solana/web3.js';
import DLMM from '@meteora-ag/dlmm';
import { CpAmm } from '@meteora-ag/cp-amm-sdk';
import { getConnection, requireArg, arg } from './lib/common';

async function main() {
  const connection = getConnection();
  const owner = new PublicKey(requireArg('owner', 'wallet address'));
  const protocol = arg('protocol') ?? 'all';
  const pool = arg('pool');

  if (protocol === 'dlmm' || protocol === 'all') {
    console.log('— DLMM positions —');
    if (pool) {
      const dlmm = await DLMM.create(connection, new PublicKey(pool));
      const { userPositions } = await dlmm.getPositionsByUserAndLbPair(owner);
      for (const p of userPositions) {
        console.log(
          `${p.publicKey.toBase58()} bins ${p.positionData.lowerBinId}..${p.positionData.upperBinId}` +
          ` x:${p.positionData.totalXAmount} y:${p.positionData.totalYAmount}` +
          ` feeX:${p.positionData.feeX.toString()} feeY:${p.positionData.feeY.toString()}`
        );
      }
    } else {
      // heavy scan across all pools — prefer --pool or the DLMM data API for discovery
      const map = await DLMM.getAllLbPairPositionsByUser(connection, owner);
      for (const [lbPair, info] of map) {
        console.log(`pool ${lbPair}: ${info.lbPairPositionsData.length} position(s)`);
      }
    }
  }

  if (protocol === 'damm-v2' || protocol === 'all') {
    console.log('— DAMM v2 positions —');
    const cpAmm = new CpAmm(connection);
    const positions = pool
      ? await cpAmm.getUserPositionByPool(new PublicKey(pool), owner)
      : await cpAmm.getPositionsByUser(owner);
    for (const p of positions) {
      console.log(
        `${p.position.toBase58()} pool:${p.positionState.pool.toBase58()}` +
        ` liquidity:${p.positionState.unlockedLiquidity.toString()}`
      );
    }
  }
}

main().then(() => process.exit(0)).catch((e) => { console.error(e); process.exit(1); });
