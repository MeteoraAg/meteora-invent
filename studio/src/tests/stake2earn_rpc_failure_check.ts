/**
 * stake2earn_rpc_failure_check.ts — standalone M8 proof, invoked by
 * e2e-review-fixes-minors.sh.
 *
 * stake2earn.ts's getPendingUnstakes() narrows its catch to the SDK's known
 * destructure-shaped TypeError (thrown when a wallet has no stake escrow at all on this farm —
 * a legitimate "no pending unstakes" case) and rethrows anything else with context, instead of
 * the old bare `catch { return []; }` that reported EVERY failure — RPC/network errors
 * included — as "no pending unstake requests".
 *
 * This monkey-patches @meteora-ag/m3m3's `StakeForFee.getUnstakeByUser` (a static method, so
 * reassigning it here affects every importer of the same module instance, including
 * stake2earn.ts) to throw a plain, non-destructure-shaped Error simulating an RPC/network
 * failure, then calls the real, unmodified `cancelUnstake` against a real farm. Before the M8
 * fix this resolved to `[]` and surfaced as "No pending unstake requests found ... run
 * stake2earn-unstake first" — indistinguishable from a wallet that genuinely has none. After
 * the fix it must surface the synthetic failure's own message instead.
 *
 * Usage: npx tsx stake2earn_rpc_failure_check.ts <rpcUrl> <keypairPath> <poolAddress>
 */
import { Connection, Keypair, PublicKey } from '@solana/web3.js';
import { Wallet } from '@coral-xyz/anchor';
import StakeForFee from '@meteora-ag/m3m3';
import fs from 'fs';
import { cancelUnstake } from '../lib/damm_v1/stake2earn';
import { DammV1Config } from '../utils/types';

const SYNTHETIC_MESSAGE = 'synthetic RPC failure for M8 proof: fetch failed (ECONNREFUSED)';

async function main() {
  const [rpcUrl, keypairPath, poolAddressRaw] = process.argv.slice(2);
  if (!rpcUrl || !keypairPath || !poolAddressRaw) {
    console.error(
      'Usage: tsx stake2earn_rpc_failure_check.ts <rpcUrl> <keypairPath> <poolAddress>'
    );
    process.exit(2);
  }

  // Every module that imports @meteora-ag/m3m3 shares this same class object — patching the
  // static method here reaches the real call inside stake2earn.ts's getPendingUnstakes().
  StakeForFee.getUnstakeByUser = (async () => {
    throw new Error(SYNTHETIC_MESSAGE);
  }) as typeof StakeForFee.getUnstakeByUser;

  const connection = new Connection(rpcUrl, 'confirmed');
  const secret = Uint8Array.from(JSON.parse(fs.readFileSync(keypairPath, 'utf8')));
  const wallet = new Wallet(Keypair.fromSecretKey(secret));
  const poolAddress = new PublicKey(poolAddressRaw);

  const config: DammV1Config = {
    rpcUrl,
    dryRun: true,
    keypairFilePath: keypairPath,
    computeUnitPriceMicroLamports: 0,
    createBaseToken: null,
    dammV1Config: null,
    dammV1LockLiquidity: null,
    stake2EarnFarm: null,
    alphaVault: null,
    stake2EarnWithdraw: { unstakeKey: null },
  };

  try {
    await cancelUnstake(config, connection, wallet, poolAddress);
    console.error(
      'FAIL: cancelUnstake did not throw at all (expected the synthetic RPC error to surface)'
    );
    process.exit(1);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    if (
      message.includes(SYNTHETIC_MESSAGE) &&
      message.includes('Failed to fetch pending unstake requests')
    ) {
      console.log('PASS: synthetic RPC failure surfaced with context: ' + message);
      process.exit(0);
    }
    console.error(
      'FAIL: expected the synthetic RPC failure to surface with context, got instead: ' + message
    );
    process.exit(1);
  }
}

main();
