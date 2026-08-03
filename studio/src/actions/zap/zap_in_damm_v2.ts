import { PublicKey } from '@solana/web3.js';
import { Wallet } from '@coral-xyz/anchor';
import { safeParseKeypairFromFile, getZapConfig, parseCliArguments } from '../../helpers';
import { DEFAULT_COMMITMENT_LEVEL } from '../../utils/constants';
import { zapInDammV2 } from '../../lib/zap';
import { createCheckedConnection } from '../../helpers/connection';

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

  const { poolAddress: poolKey } = parseCliArguments();
  if (!poolKey) {
    throw new Error('Please provide --poolAddress flag to do this action');
  }
  const poolAddress = new PublicKey(poolKey);
  console.log(`- Using poolAddress ${poolAddress.toString()}`);

  await zapInDammV2(config, connection, wallet, poolAddress);
}

main();
