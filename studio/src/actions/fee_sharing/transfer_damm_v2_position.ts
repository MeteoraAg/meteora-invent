import { PublicKey } from '@solana/web3.js';
import { Wallet } from '@coral-xyz/anchor';
import { safeParseKeypairFromFile, getFeeSharingConfig, parseCliArguments } from '../../helpers';
import { DEFAULT_COMMITMENT_LEVEL } from '../../utils/constants';
import { transferDammV2PositionToVault } from '../../lib/fee_sharing';
import { createCheckedConnection } from '../../helpers/connection';

async function main() {
  const config = await getFeeSharingConfig();

  console.log(`> Using keypair file path ${config.keypairFilePath}`);
  const keypair = await safeParseKeypairFromFile(config.keypairFilePath);

  console.log('\n> Initializing configuration...');
  console.log(`- Using RPC URL ${config.rpcUrl}`);
  console.log(`- Dry run = ${config.dryRun}`);
  console.log(`- Using wallet ${keypair.publicKey} for this action`);

  const connection = await createCheckedConnection(config.rpcUrl, DEFAULT_COMMITMENT_LEVEL);
  const wallet = new Wallet(keypair);

  const { vault: vaultKey, poolAddress: poolKey } = parseCliArguments();
  if (!vaultKey) {
    throw new Error('Please provide --vault flag to do this action');
  }
  if (!poolKey) {
    throw new Error('Please provide --poolAddress flag to do this action');
  }
  const vault = new PublicKey(vaultKey);
  const poolAddress = new PublicKey(poolKey);
  console.log(`- Using vault ${vault.toString()}`);
  console.log(`- Using poolAddress ${poolAddress.toString()}`);

  await transferDammV2PositionToVault(config, connection, wallet, vault, poolAddress);
}

main();
