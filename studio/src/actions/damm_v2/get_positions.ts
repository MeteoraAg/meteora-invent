import { PublicKey } from '@solana/web3.js';
import { safeParseKeypairFromFile, getDammV2Config, parseCliArguments } from '../../helpers';
import { Wallet } from '@coral-xyz/anchor';
import { DEFAULT_COMMITMENT_LEVEL } from '../../utils/constants';
import { getPositions } from '../../lib/damm_v2/trading';
import { createCheckedConnection } from '../../helpers/connection';

async function main() {
  const config = await getDammV2Config();

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

  await getPositions(connection, wallet, target);
}

main();
