import { safeParseKeypairFromFile, getLockConfig } from '../../helpers';
import { DEFAULT_COMMITMENT_LEVEL } from '../../utils/constants';
import { listEscrows } from '../../lib/lock/status';
import { createCheckedConnection } from '../../helpers/connection';

async function main() {
  const config = await getLockConfig();

  console.log(`> Using keypair file path ${config.keypairFilePath}`);
  const keypair = await safeParseKeypairFromFile(config.keypairFilePath);

  console.log('\n> Initializing configuration...');
  console.log(`- Using RPC URL ${config.rpcUrl}`);
  console.log(`- Using wallet ${keypair.publicKey} for this action`);

  const connection = await createCheckedConnection(config.rpcUrl, DEFAULT_COMMITMENT_LEVEL);

  if (!config.lockList) {
    throw new Error('Missing lockList in configuration');
  }
  const { role } = config.lockList;
  console.log(`- Using role ${role}`);

  await listEscrows(connection, keypair.publicKey, role);
}

main();
