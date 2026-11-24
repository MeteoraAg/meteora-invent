import { PublicKey } from '@solana/web3.js';
import { safeParseKeypairFromFile, getDlmmProConfig, parseCliArguments } from '../../helpers';
import { Wallet } from '@coral-xyz/anchor';
import { DEFAULT_COMMITMENT_LEVEL } from '../../utils/constants';
import { cancelDlmmProLimitOrder } from '../../lib/dlmm_pro';
import { createCheckedConnection } from '../../helpers/connection';

async function main() {
  const config = await getDlmmProConfig();

  console.log(`> Using keypair file path ${config.keypairFilePath}`);
  const keypair = await safeParseKeypairFromFile(config.keypairFilePath);

  console.log('\n> Initializing configuration...');
  console.log(`- Using RPC URL ${config.rpcUrl}`);
  console.log(`- Dry run = ${config.dryRun}`);
  console.log(`- Using wallet ${keypair.publicKey} for this action`);

  const connection = await createCheckedConnection(config.rpcUrl, DEFAULT_COMMITMENT_LEVEL);
  const wallet = new Wallet(keypair);

  const { poolAddress: poolKey, limitOrder } = parseCliArguments();
  if (!poolKey) {
    throw new Error('Please provide --poolAddress flag to do this action');
  }
  const poolAddress = new PublicKey(poolKey);
  console.log(`- Using pool address ${poolAddress.toString()}`);

  const limitOrderNftMint = limitOrder ? new PublicKey(limitOrder) : null;
  if (limitOrderNftMint) {
    console.log(`- Using limit order NFT mint ${limitOrderNftMint.toString()}`);
  }

  await cancelDlmmProLimitOrder(config, connection, wallet, poolAddress, limitOrderNftMint);
}

main();
