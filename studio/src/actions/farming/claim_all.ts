import { Wallet } from '@coral-xyz/anchor';
import { safeParseKeypairFromFile, getFarmingConfig } from '../../helpers';
import { DEFAULT_COMMITMENT_LEVEL } from '../../utils/constants';
import { claimAll } from '../../lib/farming';
import { createCheckedConnection } from '../../helpers/connection';

async function main() {
  const config = await getFarmingConfig();

  console.log(`> Using keypair file path ${config.keypairFilePath}`);
  const keypair = await safeParseKeypairFromFile(config.keypairFilePath);

  console.log('\n> Initializing configuration...');
  console.log(`- Using RPC URL ${config.rpcUrl}`);
  console.log(`- Dry run = ${config.dryRun}`);
  console.log(`- Using wallet ${keypair.publicKey} for this action`);

  const connection = await createCheckedConnection(config.rpcUrl, DEFAULT_COMMITMENT_LEVEL);
  const wallet = new Wallet(keypair);

  await claimAll(config, connection, wallet);
}

main();
