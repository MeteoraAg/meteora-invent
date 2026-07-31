import { PublicKey } from '@solana/web3.js';
import { safeParseKeypairFromFile, getDlmmConfig, parseCliArguments } from '../../helpers';
import { Wallet } from '@coral-xyz/anchor';
import { cancelDlmmLimitOrder } from '../../lib/dlmm';
import {
  DEFAULT_COMMITMENT_LEVEL,
  DLMM_PROGRAM_IDS,
  LOCALNET_RPC_URL,
} from '../../utils/constants';
import { createCheckedConnection } from '../../helpers/connection';

async function main() {
  const config = await getDlmmConfig();

  console.log(`> Using keypair file path ${config.keypairFilePath}`);
  const keypair = await safeParseKeypairFromFile(config.keypairFilePath);

  console.log('\n> Initializing configuration...');
  console.log(`- Using RPC URL ${config.rpcUrl}`);
  console.log(`- Dry run = ${config.dryRun}`);
  console.log(`- Using owner ${keypair.publicKey} to execute commands`);

  const connection = await createCheckedConnection(config.rpcUrl, DEFAULT_COMMITMENT_LEVEL);
  const wallet = new Wallet(keypair);

  const { poolAddress: poolKey, limitOrder } = parseCliArguments();
  if (!poolKey) {
    throw new Error('Please provide --poolAddress flag to do this action');
  }
  const poolAddress = new PublicKey(poolKey);
  console.log(`- Using pool address ${poolAddress.toString()}`);

  const limitOrderAddress = limitOrder ? new PublicKey(limitOrder) : null;
  if (limitOrderAddress) {
    console.log(`- Using limit order address ${limitOrderAddress.toString()}`);
  }

  const opts =
    config.rpcUrl === LOCALNET_RPC_URL
      ? {
          cluster: 'localhost' as const,
          programId: new PublicKey(DLMM_PROGRAM_IDS.localhost),
        }
      : undefined;

  await cancelDlmmLimitOrder(config, connection, wallet, poolAddress, limitOrderAddress, opts);
}

main();
