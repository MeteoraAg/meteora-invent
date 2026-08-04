import { PublicKey } from '@solana/web3.js';
import { Wallet } from '@coral-xyz/anchor';
import { safeParseKeypairFromFile, getLockConfig, parseCliArguments } from '../../helpers';
import { DEFAULT_COMMITMENT_LEVEL } from '../../utils/constants';
import { claim as claimVestedTokens } from '../../lib/lock';
import { createCheckedConnection } from '../../helpers/connection';

async function main() {
  const config = await getLockConfig();

  console.log(`> Using keypair file path ${config.keypairFilePath}`);
  const keypair = await safeParseKeypairFromFile(config.keypairFilePath);

  console.log('\n> Initializing configuration...');
  console.log(`- Using RPC URL ${config.rpcUrl}`);
  console.log(`- Dry run = ${config.dryRun}`);
  console.log(`- Using wallet ${keypair.publicKey} for this action`);

  const connection = await createCheckedConnection(config.rpcUrl, DEFAULT_COMMITMENT_LEVEL);
  const wallet = new Wallet(keypair);

  const { escrow: targetKey } = parseCliArguments();
  if (!targetKey) {
    throw new Error('Please provide --escrow flag to do this action');
  }
  const escrow = new PublicKey(targetKey);
  console.log(`- Using escrow ${escrow.toString()}`);

  await claimVestedTokens(config, connection, wallet, escrow);
}

main();
