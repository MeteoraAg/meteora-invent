import { Connection, Keypair, PublicKey } from '@solana/web3.js';
import { safeParseKeypairFromFile, parseConfigFromCli } from '../../helpers';
import { Wallet } from '@coral-xyz/anchor';
import { DbcConfig } from '../../utils/types';
import { DEFAULT_COMMITMENT_LEVEL } from '../../utils/constants';
import { createDbcPool } from '../../lib/dbc';

async function main() {
  const config = (await parseConfigFromCli()) as DbcConfig;

  console.log(`> Using keypair file path ${config.keypairFilePath}`);
  const keypair = await safeParseKeypairFromFile(config.keypairFilePath);

  console.log('\n> Initializing with general configuration...');
  console.log(`- Using RPC URL ${config.rpcUrl}`);
  console.log(`- Dry run = ${config.dryRun}`);
  console.log(`- Using partner wallet ${keypair.publicKey} to deploy config`);

  const connection = new Connection(config.rpcUrl, DEFAULT_COMMITMENT_LEVEL);
  const partnerWallet = new Wallet(keypair);

  const quoteMint = new PublicKey(config.quoteMint);
  let baseMint: Keypair;
  if (config.dbc.createPool.baseMintKeypairFilepath) {
    baseMint = await safeParseKeypairFromFile(config.dbc.createPool.baseMintKeypairFilepath);
  } else {
    baseMint = Keypair.generate();
  }

  console.log(`- Using quote token mint ${quoteMint.toString()}`);
  console.log(`- Using base token mint ${baseMint.publicKey.toString()}`);

  /// --------------------------------------------------------------------------
  if (config) {
    await createDbcPool(config, connection, partnerWallet, quoteMint, baseMint);
  } else {
    throw new Error('Must provide DAMM V1 configuration');
  }
}

main();
