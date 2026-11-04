import { NextApiRequest, NextApiResponse } from 'next';
import { Connection, PublicKey } from '@solana/web3.js';
import { DynamicBondingCurveClient } from '@meteora-ag/dynamic-bonding-curve-sdk';

const RPC_URL = process.env.RPC_URL as string;

if (!RPC_URL) {
  throw new Error('Missing required environment variables');
}

// How the graduation LP of a DBC pool is split, read from its pool config. Only the permanently locked share stays
// in the DAMM pool for good: the rest goes to the partner and creator as positions they can withdraw, at once or as a
// liquidity vesting schedule releases it.
export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== 'GET') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  let pool: PublicKey;
  try {
    pool = new PublicKey(String(req.query.pool ?? ''));
  } catch {
    return res.status(400).json({ error: 'Invalid pool address' });
  }

  try {
    const client = new DynamicBondingCurveClient(new Connection(RPC_URL, 'confirmed'), 'confirmed');
    const virtualPool = await client.state.getPool(pool);
    if (!virtualPool) {
      return res.status(404).json({ error: 'Not a DBC pool' });
    }
    const configAddress: PublicKey = virtualPool.poolState.config;
    const config = await client.state.getPoolConfig(configAddress);
    if (!config) {
      return res.status(404).json({ error: 'Pool config not found' });
    }
    const vesting = (info: { isInitialized: number; vestingPercentage: number }) =>
      info.isInitialized ? info.vestingPercentage : 0;

    const lockedPct =
      config.partnerPermanentLockedLiquidityPercentage +
      config.creatorPermanentLockedLiquidityPercentage;
    const vestingPct =
      vesting(config.partnerLiquidityVestingInfo) + vesting(config.creatorLiquidityVestingInfo);

    res.setHeader('Cache-Control', 'public, s-maxage=3600');
    return res.status(200).json({
      config: configAddress.toBase58(),
      lockedPct,
      vestingPct,
      withdrawablePct: 100 - lockedPct - vestingPct,
    });
  } catch (error) {
    console.error(error);
    return res.status(500).json({ error: 'Failed to read the pool config' });
  }
}
