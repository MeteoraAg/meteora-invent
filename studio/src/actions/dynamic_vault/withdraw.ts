import { PublicKey } from '@solana/web3.js';
import { Wallet } from '@coral-xyz/anchor';
import { safeParseKeypairFromFile, getDynamicVaultConfig, parseCliArguments } from '../../helpers';
import { DEFAULT_COMMITMENT_LEVEL } from '../../utils/constants';
import { withdraw } from '../../lib/dynamic_vault';
import { createCheckedConnection } from '../../helpers/connection';

async function main() {
  const config = await getDynamicVaultConfig();

  console.log(`> Using keypair file path ${config.keypairFilePath}`);
  const keypair = await safeParseKeypairFromFile(config.keypairFilePath);

  console.log('\n> Initializing configuration...');
  console.log(`- Using RPC URL ${config.rpcUrl}`);
  console.log(`- Dry run = ${config.dryRun}`);
  console.log(`- Using wallet ${keypair.publicKey} for this action`);

  const connection = await createCheckedConnection(config.rpcUrl, DEFAULT_COMMITMENT_LEVEL);
  const wallet = new Wallet(keypair);

  const { baseMint: targetKey } = parseCliArguments();
  if (!targetKey) {
    throw new Error('Please provide --baseMint flag to do this action');
  }
  const baseMint = new PublicKey(targetKey);
  console.log(`- Using baseMint ${baseMint.toString()}`);

  await withdraw(config, connection, wallet, baseMint);
}

main();
