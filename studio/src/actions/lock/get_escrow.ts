import { PublicKey } from '@solana/web3.js';
import { getLockConfig, parseCliArguments } from '../../helpers';
import { DEFAULT_COMMITMENT_LEVEL } from '../../utils/constants';
import { getEscrow } from '../../lib/lock/status';
import { createCheckedConnection } from '../../helpers/connection';

async function main() {
  const config = await getLockConfig();

  console.log('\n> Initializing configuration...');
  console.log(`- Using RPC URL ${config.rpcUrl}`);

  const connection = await createCheckedConnection(config.rpcUrl, DEFAULT_COMMITMENT_LEVEL);

  const { escrow: targetKey } = parseCliArguments();
  if (!targetKey) {
    throw new Error('Please provide --escrow flag to do this action');
  }
  const escrow = new PublicKey(targetKey);
  console.log(`- Using escrow ${escrow.toString()}`);

  await getEscrow(connection, escrow);
}

main();
