import { Connection, PublicKey } from '@solana/web3.js';
import { Wallet } from '@coral-xyz/anchor';
import { DEFAULT_COMMITMENT_LEVEL } from '../../utils/constants';
import { getDammV2Config, safeParseKeypairFromFile } from '../../helpers';
import { claimPositionFee } from '../../lib/damm_v2';

async function main() {
  const config = await getDammV2Config();

  console.log(`> Using keypair file path ${config.keypairFilePath}`);
  const keypair = await safeParseKeypairFromFile(config.keypairFilePath);

  console.log('\n> Initializing with general configuration...');
  console.log(`- Using RPC URL ${config.rpcUrl}`);
  console.log(`- Dry run = ${config.dryRun}`);
  console.log(`- Using payer ${keypair.publicKey} to execute commands`);

  const connection = new Connection(config.rpcUrl, DEFAULT_COMMITMENT_LEVEL);
  const wallet = new Wallet(keypair);

  if (!config.poolAddress) {
    throw new Error('Missing pool address in configuration');
  }
  const poolAddress = new PublicKey(config.poolAddress);

  console.log(`- Using pool address ${poolAddress.toString()}`);

  /// --------------------------------------------------------------------------
  if (config) {
    await claimPositionFee(config, connection, wallet, poolAddress);
  } else {
    throw new Error('Must provide Dynamic V2 configuration');
  }
}

main();
