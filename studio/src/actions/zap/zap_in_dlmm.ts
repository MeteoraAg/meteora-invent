import { PublicKey } from '@solana/web3.js';
import { Wallet } from '@coral-xyz/anchor';
import { config as loadEnv } from 'dotenv';
import { safeParseKeypairFromFile, getZapConfig, parseCliArguments } from '../../helpers';
import { DEFAULT_COMMITMENT_LEVEL } from '../../utils/constants';
import { zapInDlmm } from '../../lib/zap';
import { createCheckedConnection } from '../../helpers/connection';

// Loads studio/.env so JUPITER_API_KEY / JUPITER_API_URL (read by lib/zap's zapInDlmm) are
// honored — same dotenv pattern as actions/settings/generate_keypair.ts.
loadEnv();

async function main() {
  const config = await getZapConfig();

  console.log(`> Using keypair file path ${config.keypairFilePath}`);
  const keypair = await safeParseKeypairFromFile(config.keypairFilePath);

  console.log('\n> Initializing configuration...');
  console.log(`- Using RPC URL ${config.rpcUrl}`);
  console.log(`- Dry run = ${config.dryRun}`);
  console.log(`- Using wallet ${keypair.publicKey} for this action`);

  const connection = await createCheckedConnection(config.rpcUrl, DEFAULT_COMMITMENT_LEVEL);
  const wallet = new Wallet(keypair);

  // This is the lbPair address.
  const { poolAddress: poolKey } = parseCliArguments();
  if (!poolKey) {
    throw new Error('Please provide --poolAddress flag to do this action');
  }
  const poolAddress = new PublicKey(poolKey);
  console.log(`- Using poolAddress ${poolAddress.toString()}`);

  await zapInDlmm(config, connection, wallet, poolAddress);
}

main();
