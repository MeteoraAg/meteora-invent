import { PublicKey } from '@solana/web3.js';
import { Wallet } from '@coral-xyz/anchor';
import { safeParseKeypairFromFile, getFarmingConfig, parseCliArguments } from '../../helpers';
import { DEFAULT_COMMITMENT_LEVEL } from '../../utils/constants';
import { unstake } from '../../lib/farming';
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

  const { farm: farmKey } = parseCliArguments();
  if (!farmKey) {
    throw new Error('Please provide --farm flag to do this action');
  }
  const farm = new PublicKey(farmKey);
  console.log(`- Using farm ${farm.toString()}`);

  await unstake(config, connection, wallet, farm);
}

main();
