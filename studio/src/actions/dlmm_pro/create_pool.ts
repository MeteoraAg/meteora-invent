import { PublicKey } from '@solana/web3.js';
import {
  safeParseKeypairFromFile,
  createTokenMint,
  getDlmmProConfig,
  parseCliArguments,
} from '../../helpers';
import { Wallet } from '@coral-xyz/anchor';
import { createDlmmProPool } from '../../lib/dlmm_pro';
import { DEFAULT_COMMITMENT_LEVEL } from '../../utils/constants';
import { createCheckedConnection } from '../../helpers/connection';

async function main() {
  const config = await getDlmmProConfig();

  console.log(`> Using keypair file path ${config.keypairFilePath}`);
  const keypair = await safeParseKeypairFromFile(config.keypairFilePath);

  console.log('\n> Initializing configuration...');
  console.log(`- Using RPC URL ${config.rpcUrl}`);
  console.log(`- Dry run = ${config.dryRun}`);
  console.log(`- Using payer ${keypair.publicKey} to execute commands`);

  const connection = await createCheckedConnection(config.rpcUrl, DEFAULT_COMMITMENT_LEVEL);
  const wallet = new Wallet(keypair);

  let baseMint: PublicKey;
  const { baseMint: baseMintKey } = parseCliArguments();
  if (!baseMintKey) {
    if (!config.createBaseToken) {
      throw new Error(
        'Please either provide --baseMint flag in cli or createBaseToken in configuration to do this action'
      );
    }
    baseMint = await createTokenMint(connection, wallet, {
      dryRun: config.dryRun,
      computeUnitPriceMicroLamports: config.computeUnitPriceMicroLamports ?? 0,
      tokenConfig: config.createBaseToken,
    });
  } else {
    baseMint = new PublicKey(baseMintKey);
  }

  if (!config.quoteMint) {
    throw new Error('Missing quoteMint in configuration');
  }
  const quoteMint = new PublicKey(config.quoteMint);

  console.log(`- Using base token mint ${baseMint.toString()}`);
  console.log(`- Using quote token mint ${quoteMint.toString()}`);

  await createDlmmProPool(config, connection, wallet, baseMint, quoteMint);
}

main();
