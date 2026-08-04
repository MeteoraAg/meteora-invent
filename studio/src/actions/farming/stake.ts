import { PublicKey } from '@solana/web3.js';
import { Wallet } from '@coral-xyz/anchor';
import { safeParseKeypairFromFile, getFarmingConfig, parseCliArguments } from '../../helpers';
import { DEFAULT_COMMITMENT_LEVEL } from '../../utils/constants';
import { stake } from '../../lib/farming';
import { resolveFarmAddress, guessFarmingCluster } from '../../lib/farming/status';
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

  const { farm: farmKey, poolAddress: poolKey } = parseCliArguments();
  if (!farmKey && !poolKey) {
    throw new Error('Please provide --farm or --poolAddress flag to do this action');
  }

  const farm = await resolveFarmAddress(
    {
      farm: farmKey ? new PublicKey(farmKey) : undefined,
      poolAddress: poolKey ? new PublicKey(poolKey) : undefined,
    },
    guessFarmingCluster(config.rpcUrl)
  );
  console.log(`- Using farm ${farm.toString()}`);

  await stake(config, connection, wallet, farm);
}

main();
