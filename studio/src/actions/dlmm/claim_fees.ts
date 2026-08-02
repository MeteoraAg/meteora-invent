import { PublicKey } from '@solana/web3.js';
import { safeParseKeypairFromFile, getDlmmConfig, parseCliArguments } from '../../helpers';
import { Wallet } from '@coral-xyz/anchor';
import { DEFAULT_COMMITMENT_LEVEL } from '../../utils/constants';
import { claimAllFees } from '../../lib/dlmm';
import { createCheckedConnection } from '../../helpers/connection';

async function main() {
  const config = await getDlmmConfig();

  console.log(`> Using keypair file path ${config.keypairFilePath}`);
  const keypair = await safeParseKeypairFromFile(config.keypairFilePath);

  console.log('\n> Initializing configuration...');
  console.log(`- Using RPC URL ${config.rpcUrl}`);
  console.log(`- Dry run = ${config.dryRun}`);
  console.log(`- Using wallet ${keypair.publicKey} for this action`);

  const connection = await createCheckedConnection(config.rpcUrl, DEFAULT_COMMITMENT_LEVEL);
  const wallet = new Wallet(keypair);

  const { poolAddress: targetKey } = parseCliArguments();
  if (!targetKey) {
    throw new Error('Please provide --poolAddress flag to do this action');
  }
  const target = new PublicKey(targetKey);
  console.log(`- Using poolAddress ${target.toString()}`);

  await claimAllFees(config, connection, wallet, target);
}

main();
