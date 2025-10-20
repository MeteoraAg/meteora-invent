import { Connection, PublicKey } from '@solana/web3.js';
import { getDammV1Config, parseCliArguments, safeParseKeypairFromFile } from '../../helpers';
import { DEFAULT_COMMITMENT_LEVEL } from '../../utils/constants';
import { lockLiquidity } from '../../lib/damm_v1';

async function main() {
  const config = await getDammV1Config();

  console.log(`> Using keypair file path ${config.keypairFilePath}`);
  const keypair = await safeParseKeypairFromFile(config.keypairFilePath);

  console.log('\n> Initializing configuration...');
  console.log(`- Using RPC URL ${config.rpcUrl}`);
  console.log(`- Dry run = ${config.dryRun}`);
  console.log(`- Using payer ${keypair.publicKey} to execute commands`);

  const connection = new Connection(config.rpcUrl, DEFAULT_COMMITMENT_LEVEL);

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

  if (!config.dammV1LockLiquidity) {
    throw new Error('Missing lockLiquidity configuration');
  }

  await lockLiquidity(
    connection,
    keypair,
    new PublicKey(baseMint),
    quoteMint,
    config.dammV1LockLiquidity.allocations,
    config.dryRun,
    config.computeUnitPriceMicroLamports ?? 0
  );
}

main();
