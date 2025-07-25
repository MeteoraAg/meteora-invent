import { Connection, Keypair, PublicKey, sendAndConfirmTransaction } from '@solana/web3.js';
import { Stake2EarnConfig } from '../utils/types';
import { DEFAULT_SEND_TX_MAX_RETRIES, STAKE2EARN_PROGRAM_IDS } from '../utils/constants';
import StakeForFee, { deriveFeeVault } from '@meteora-ag/m3m3';
import BN from 'bn.js';
import { modifyComputeUnitPriceIx, runSimulateTransaction } from '../helpers';

export async function createStake2EarnFarm(
  connection: Connection,
  payer: Keypair,
  poolKey: PublicKey,
  stakeMint: PublicKey,
  config: Stake2EarnConfig,
  dryRun: boolean,
  computeUnitPriceMicroLamports: number,
  opts?: {
    m3m3ProgramId: PublicKey;
  }
): Promise<void> {
  const m3m3ProgramId =
    opts?.m3m3ProgramId ?? new PublicKey(STAKE2EARN_PROGRAM_IDS['mainnet-beta']);
  const m3m3VaultPubkey = deriveFeeVault(poolKey, m3m3ProgramId);
  console.log(`- M3M3 fee vault ${m3m3VaultPubkey}`);

  // 1. Create m3m3 farm
  const m3m3VaultAccount = await connection.getAccountInfo(m3m3VaultPubkey, connection.commitment);

  if (m3m3VaultAccount) {
    console.log(`>>> M3M3 farm is already existed. Skip creating new farm.`);
    return;
  }

  console.log(`>> Creating M3M3 fee farm...`);
  const topListLength = config.topListLength;
  const unstakeLockDuration = new BN(config.unstakeLockDurationSecs);
  const secondsToFullUnlock = new BN(config.secondsToFullUnlock);
  const startFeeDistributeTimestamp = new BN(config.startFeeDistributeTimestamp);

  console.log(`- Using topListLength: ${topListLength}`);
  console.log(`- Using unstakeLockDuration ${unstakeLockDuration}`);
  console.log(`- Using secondsToFullUnlock ${secondsToFullUnlock}`);
  console.log(`- Using startFeeDistributeTimestamp ${startFeeDistributeTimestamp}`);

  // m3m3 farm didn't exist
  const createTx = await StakeForFee.createFeeVault(
    connection,
    poolKey,
    stakeMint,
    payer.publicKey,
    {
      topListLength,
      unstakeLockDuration,
      secondsToFullUnlock,
      startFeeDistributeTimestamp,
      padding: [],
    }
  );

  modifyComputeUnitPriceIx(createTx, computeUnitPriceMicroLamports);

  if (dryRun) {
    console.log(`> Simulating create m3m3 farm tx...`);
    await runSimulateTransaction(connection, [payer], payer.publicKey, [createTx]);
  } else {
    console.log(`>> Sending create m3m3 farm transaction...`);
    const txHash = await sendAndConfirmTransaction(connection, createTx, [payer], {
      commitment: connection.commitment,
      maxRetries: DEFAULT_SEND_TX_MAX_RETRIES,
    }).catch((err: any) => {
      console.error(err);
      throw err;
    });
    console.log(`>>> M3M3 farm initialized successfully with tx hash: ${txHash}`);
  }
}
