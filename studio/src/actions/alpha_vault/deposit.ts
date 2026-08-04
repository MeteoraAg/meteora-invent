import { PublicKey } from '@solana/web3.js';
import { Wallet } from '@coral-xyz/anchor';
import { safeParseKeypairFromFile, getAlphaVaultConfig, parseCliArguments } from '../../helpers';
import { DEFAULT_COMMITMENT_LEVEL } from '../../utils/constants';
import { deposit } from '../../lib/alpha_vault/participant';
import { resolveAlphaVaultAddress } from '../../lib/alpha_vault/status';
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

  const { vault: vaultKey, poolAddress: poolKey } = parseCliArguments();
  if (!vaultKey && !poolKey) {
    throw new Error('Please provide --vault or --poolAddress flag to do this action');
  }

  const vault = await resolveAlphaVaultAddress(connection, {
    vault: vaultKey ? new PublicKey(vaultKey) : undefined,
    poolAddress: poolKey ? new PublicKey(poolKey) : undefined,
  });
  console.log(`- Using vault ${vault.toString()}`);

  await deposit(config, connection, wallet, vault);
}

main();
