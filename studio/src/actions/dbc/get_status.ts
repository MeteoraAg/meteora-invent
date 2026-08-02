import { PublicKey } from '@solana/web3.js';
import { getDbcConfig, parseCliArguments } from '../../helpers';
import { DEFAULT_COMMITMENT_LEVEL } from '../../utils/constants';
import { getStatus } from '../../lib/dbc/status';
import { createCheckedConnection } from '../../helpers/connection';

async function main() {
  const config = await getDbcConfig();

  console.log('\n> Initializing configuration...');
  console.log(`- Using RPC URL ${config.rpcUrl}`);

  const connection = await createCheckedConnection(config.rpcUrl, DEFAULT_COMMITMENT_LEVEL);

  const { baseMint: targetKey } = parseCliArguments();
  if (!targetKey) {
    throw new Error('Please provide --baseMint flag to do this action');
  }
  const target = new PublicKey(targetKey);
  console.log(`- Using baseMint ${target.toString()}`);

  await getStatus(connection, target);
}

main();
