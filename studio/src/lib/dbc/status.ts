import { Connection, PublicKey } from '@solana/web3.js';
import { DynamicBondingCurveClient } from '@meteora-ag/dynamic-bonding-curve-sdk';
import { DEFAULT_COMMITMENT_LEVEL } from '../../utils/constants';

/**
 * Print the status of a DBC pool for a base mint (read-only):
 * pool/config addresses, reserves, migration flag, graduation progress, unclaimed fees.
 */
export async function getStatus(connection: Connection, baseMint: PublicKey) {
  const client = new DynamicBondingCurveClient(connection, DEFAULT_COMMITMENT_LEVEL);

  const pool = await client.state.getPoolByBaseMint(baseMint);
  if (!pool) {
    throw new Error(`No DBC pool found for base mint ${baseMint.toString()}`);
  }

  console.log(`\n> Pool:          ${pool.publicKey.toString()}`);
  const state = await client.state.getPool(pool.publicKey);
  if (!state) {
    throw new Error(`DBC pool ${pool.publicKey.toString()} not readable`);
  }
  console.log(`> Config:        ${state.poolState.config.toString()}`);
  console.log(`> Quote reserve: ${state.poolState.quoteReserve.toString()} (quote base units)`);
  console.log(`> Migrated:      ${state.poolState.isMigrated ? 'yes' : 'no'}`);

  const progress = await client.state.getPoolQuoteTokenCurveProgress(pool.publicKey);
  console.log(`> Graduation:    ${(progress * 100).toFixed(2)}%`);

  const threshold = await client.state.getPoolMigrationQuoteThreshold(pool.publicKey);
  console.log(`> Threshold:     ${threshold.toString()} (quote base units)`);

  const fees = await client.state.getPoolFeeBreakdown(pool.publicKey);
  console.log(
    `> Creator fees unclaimed: base=${fees.creator.unclaimedBaseFee.toString()} quote=${fees.creator.unclaimedQuoteFee.toString()}`
  );
  console.log(
    `> Partner fees unclaimed: base=${fees.partner.unclaimedBaseFee.toString()} quote=${fees.partner.unclaimedQuoteFee.toString()}`
  );
}
