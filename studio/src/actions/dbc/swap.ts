import { PublicKey } from '@solana/web3.js';
import { safeParseKeypairFromFile, getDbcConfig, parseCliArguments } from '../../helpers';
import { Wallet } from '@coral-xyz/anchor';
import { DEFAULT_COMMITMENT_LEVEL } from '../../utils/constants';
import { swap } from '../../lib/dbc/trading';
import { createCheckedConnection } from '../../helpers/connection';

async function main() {
  const config = await getDbcConfig();

  console.log(`> Using keypair file path ${config.keypairFilePath}`);
  const keypair = await safeParseKeypairFromFile(config.keypairFilePath);

  console.log('\n> Initializing configuration...');
  console.log(`- Using RPC URL ${config.rpcUrl}`);
  console.log(`- Dry run = ${config.dryRun}`);
  console.log(`- Using wallet ${keypair.publicKey} to swap`);

  const connection = await createCheckedConnection(config.rpcUrl, DEFAULT_COMMITMENT_LEVEL);
  const wallet = new Wallet(keypair);

  const { baseMint } = parseCliArguments();
  if (!baseMint) {
    throw new Error('Please provide --baseMint flag to do this action');
  }

  if (!config.quoteMint) {
    throw new Error('Missing quoteMint in configuration');
  }
  const quoteMint = new PublicKey(config.quoteMint);

  console.log(`- Using base token mint ${baseMint.toString()}`);
  console.log(`- Using quote token mint ${quoteMint.toString()}`);

  if (config) {
    await swap(config, connection, wallet, new PublicKey(baseMint));
  } else {
    throw new Error('Must provide DBC configuration');
  }
}

main();
