import { simulateTransaction } from '@coral-xyz/anchor/dist/cjs/utils/rpc';
import {
  ComputeBudgetProgram,
  PublicKey,
  Transaction,
  Keypair,
  Connection,
  VersionedTransaction,
  TransactionInstruction,
  sendAndConfirmTransaction,
} from '@solana/web3.js';
import { DEFAULT_SEND_TX_MAX_RETRIES } from '../utils/constants';

/**
 * Simulate a transaction
 * @param connection - The connection to the cluster
 * @param signers - The signers to the transaction
 * @param feePayer - The fee payer of the transaction
 * @param txs - The transactions to simulate
 */
export async function runSimulateTransaction(
  connection: Connection,
  signers: Array<Keypair>,
  feePayer: PublicKey,
  txs: Array<Transaction>
) {
  const { blockhash, lastValidBlockHeight } = await connection.getLatestBlockhash(
    connection.commitment
  );

  const transaction = new Transaction({
    blockhash,
    lastValidBlockHeight,
    feePayer,
  }).add(...txs);

  const simulateResp = await simulateTransaction(
    connection,
    transaction,
    signers,
    connection.commitment
  );
  if (simulateResp.value.err) {
    console.error('>>> Simulate transaction failed:', simulateResp.value.err);
    console.log(`Logs ${simulateResp.value.logs}`);
    throw simulateResp.value.err;
  }

  console.log('>>> Simulated transaction successfully');
}

/**
 * Modify priority fee in transaction
 * @param tx
 * @param newPriorityFee
 * @returns {boolean} true if priority fee was modified
 **/
export const modifyComputeUnitPriceIx = (
  tx: VersionedTransaction | Transaction,
  newPriorityFee: number
): boolean => {
  if ('version' in tx) {
    for (const ix of tx.message.compiledInstructions) {
      const programId = tx.message.staticAccountKeys[ix.programIdIndex];
      if (programId && ComputeBudgetProgram.programId.equals(programId)) {
        // need check for data index
        if (ix.data[0] === 3) {
          ix.data = Uint8Array.from(
            ComputeBudgetProgram.setComputeUnitPrice({
              microLamports: newPriorityFee,
            }).data
          );
          return true;
        }
      }
    }
    // could not inject for VT
  } else {
    for (const ix of tx.instructions) {
      if (ComputeBudgetProgram.programId.equals(ix.programId)) {
        // need check for data index
        if (ix.data[0] === 3) {
          ix.data = ComputeBudgetProgram.setComputeUnitPrice({
            microLamports: newPriorityFee,
          }).data;
          return true;
        }
      }
    }

    // inject if none
    tx.add(
      ComputeBudgetProgram.setComputeUnitPrice({
        microLamports: newPriorityFee,
      })
    );
    return true;
  }

  return false;
};

/**
 * Divide the instructions to multiple transactions
 * @param connection - The connection to the cluster
 * @param instructions - The instructions to send
 * @param instructionsPerTx - The number of instructions per transaction
 * @param payer - The payer of the transaction
 * @param computeUnitPriceMicroLamports - The compute unit price in microlamports
 * @param dryRun - Whether to dry run the transaction
 * @param txLabel - The label of the transaction
 */
export async function handleSendTxs(
  connection: Connection,
  instructions: TransactionInstruction[],
  instructionsPerTx: number,
  payer: Keypair,
  computeUnitPriceMicroLamports: number,
  dryRun: boolean,
  txLabel?: string
): Promise<void> {
  const numTransactions = Math.ceil(instructions.length / instructionsPerTx);

  for (let i = 0; i < numTransactions; i++) {
    const { blockhash, lastValidBlockHeight } = await connection.getLatestBlockhash(
      connection.commitment
    );
    const setPriorityFeeIx = ComputeBudgetProgram.setComputeUnitPrice({
      microLamports: computeUnitPriceMicroLamports,
    });
    const tx = new Transaction({
      blockhash,
      lastValidBlockHeight,
      feePayer: payer.publicKey,
    }).add(setPriorityFeeIx);
    const lowerIndex = i * instructionsPerTx;
    const upperIndex = (i + 1) * instructionsPerTx;
    for (let j = lowerIndex; j < upperIndex; j++) {
      if (instructions[j]) tx.add(instructions[j]);
    }

    const txSize = tx.serialize({
      verifySignatures: false,
    }).length;
    console.log(`Tx number ${i + 1} txSize = ${txSize}`);

    const label = txLabel ?? '';
    if (dryRun) {
      console.log(`\n> Simulating ${label} tx number ${i + 1}...`);
      await runSimulateTransaction(connection, [payer], payer.publicKey, [tx]);
    } else {
      console.log(`>> Sending ${label} transaction number ${i + 1}...`);
      const txHash = await sendAndConfirmTransaction(connection, tx, [payer], {
        commitment: connection.commitment,
        maxRetries: DEFAULT_SEND_TX_MAX_RETRIES,
      }).catch((err) => {
        console.error(err);
        throw err;
      });
      console.log(`>>> Transaction ${i + 1} ${label} successfully with tx hash: ${txHash}`);
    }
  }
}
