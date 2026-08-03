import { PublicKey } from '@solana/web3.js';
import { Wallet } from '@coral-xyz/anchor';
import { safeParseKeypairFromFile, getAlphaVaultConfig, parseCliArguments } from '../../helpers';
import { DEFAULT_COMMITMENT_LEVEL } from '../../utils/constants';
import { claim } from '../../lib/alpha_vault/participant';
import { createCheckedConnection } from '../../helpers/connection';

async function main() {
  const config = await getAlphaVaultConfig();

  console.log(`> Using keypair file path ${config.keypairFilePath}`);
  const keypair = await safeParseKeypairFromFile(config.keypairFilePath);

  console.log('\n> Initializing configuration...');
  console.log(`- Using RPC URL ${config.rpcUrl}`);
  console.log(`- Dry run = ${config.dryRun}`);
  console.log(`- Using wallet ${keypair.publicKey} for this action`);

  const connection = await createCheckedConnection(config.rpcUrl, DEFAULT_COMMITMENT_LEVEL);
  const wallet = new Wallet(keypair);

  const { vault: targetKey } = parseCliArguments();
  if (!targetKey) {
    throw new Error('Please provide --vault flag to do this action');
  }
  const vault = new PublicKey(targetKey);
  console.log(`- Using vault ${vault.toString()}`);

  await claim(config, connection, wallet, vault);
}

main();
