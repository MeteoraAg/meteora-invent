/**
 * DBC pool status (read-only): pool by base mint, graduation progress, fee breakdown.
 * Usage:
 *   npx ts-node dbc-status.ts --mint <BASE_MINT>
 */
import { PublicKey } from '@solana/web3.js';
import { DynamicBondingCurveClient } from '@meteora-ag/dynamic-bonding-curve-sdk';
import { getConnection, requireArg } from './lib/common';

async function main() {
  const connection = getConnection();
  const baseMint = new PublicKey(requireArg('mint', 'base token mint'));

  const client = new DynamicBondingCurveClient(connection, 'confirmed');
  const pool = await client.state.getPoolByBaseMint(baseMint);
  if (!pool) throw new Error(`No DBC pool found for mint ${baseMint.toBase58()}`);

  console.log(`pool:        ${pool.publicKey.toBase58()}`);
  const state = await client.state.getPool(pool.publicKey);
  console.log(`config:      ${state!.poolState.config.toBase58()}`);
  console.log(`quoteReserve:${state!.poolState.quoteReserve.toString()}`);
  console.log(`migrated:    ${state!.poolState.isMigrated ? 'yes' : 'no'}`);

  const progress = await client.state.getPoolQuoteTokenCurveProgress(pool.publicKey);
  console.log(`graduation:  ${(progress * 100).toFixed(2)}%`);

  const threshold = await client.state.getPoolMigrationQuoteThreshold(pool.publicKey);
  console.log(`threshold:   ${threshold.toString()}`);

  const fees = await client.state.getPoolFeeBreakdown(pool.publicKey);
  console.log(
    `creator fees unclaimed: base=${fees.creator.unclaimedBaseFee.toString()} quote=${fees.creator.unclaimedQuoteFee.toString()}`
  );
  console.log(
    `partner fees unclaimed: base=${fees.partner.unclaimedBaseFee.toString()} quote=${fees.partner.unclaimedQuoteFee.toString()}`
  );
}

main().then(() => process.exit(0)).catch((e) => { console.error(e); process.exit(1); });
