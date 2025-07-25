import { Connection, PublicKey, sendAndConfirmTransaction } from '@solana/web3.js';
import {
  safeParseKeypairFromFile,
  parseConfigFromCli,
  modifyComputeUnitPriceIx,
  runSimulateTransaction,
} from '../../helpers';
import { Wallet } from '@coral-xyz/anchor';
import DLMM from '@meteora-ag/dlmm';
import { DlmmConfig } from '../../utils/types';
import { DEFAULT_COMMITMENT_LEVEL, DEFAULT_SEND_TX_MAX_RETRIES } from '../../utils/constants';

async function main() {
  const config: DlmmConfig = (await parseConfigFromCli()) as DlmmConfig;

  console.log(`> Using keypair file path ${config.keypairFilePath}`);
  const keypair = await safeParseKeypairFromFile(config.keypairFilePath);

  console.log('\n> Initializing with general configuration...');
  console.log(`- Using RPC URL ${config.rpcUrl}`);
  console.log(`- Dry run = ${config.dryRun}`);
  console.log(`- Using payer ${keypair.publicKey} to execute commands`);

  const connection = new Connection(config.rpcUrl, DEFAULT_COMMITMENT_LEVEL);
  const wallet = new Wallet(keypair);

  const poolAddress = new PublicKey(config.setDlmmPoolStatus.poolAddress);
  const enabled = config.setDlmmPoolStatus.enabled;

  console.log(`- Using pool address ${poolAddress.toString()}`);
  console.log(`- Using enabled ${enabled}`);

  const lbPair = await DLMM.create(connection, poolAddress);

  const tx = await lbPair.setPairStatusPermissionless(enabled, wallet.publicKey);
  modifyComputeUnitPriceIx(tx, config.computeUnitPriceMicroLamports);

  if (config.dryRun) {
    console.log(`\n> Simulating set DLMM pool status tx...`);
    await runSimulateTransaction(connection, [wallet.payer], wallet.publicKey, [tx]);
  } else {
    console.log(`>> Sending set DLMM pool status transaction...`);
    const txHash = await sendAndConfirmTransaction(connection, tx, [wallet.payer], {
      commitment: connection.commitment,
      maxRetries: DEFAULT_SEND_TX_MAX_RETRIES,
    }).catch((e) => {
      console.error(e);
      throw e;
    });
    console.log(`>>> Set DLMM pool status tx hash: ${txHash}`);
  }
}

main();
