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
      const instruction = instructions[j];
      if (instruction) tx.add(instruction);
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

/**
 * One step of an ordered, must-run-in-sequence transaction bundle (e.g. a zap's
 * setup -> swap(s) -> ledger -> zap-in -> clean-up chain). `signers` lists every
 * KEYPAIR that *might* need to co-sign this specific step beyond the payer (e.g. a
 * fresh position-NFT keypair) — `sendOrderedTransactions` figures out per-step which of
 * them are actually required and drops the rest, so callers can pass the same superset
 * of candidate signers for every step without tracking which step needs which key.
 */
export interface OrderedTransactionStep {
  label: string;
  tx: Transaction;
  signers: Keypair[];
}

/**
 * The set of pubkeys (base58) a transaction actually requires a signature from: its
 * fee payer plus every account any instruction marks `isSigner`. Solana's own
 * `Transaction.sign()`/`partialSign()` throw `unknown signer: <pubkey>` if handed a
 * keypair outside this set (verified empirically against the installed
 * `@solana/web3.js` — `sign()` resets `this.signatures` to exactly the compiled
 * message's required-signer list before applying signatures), so this must be computed
 * from the FINAL tx (after `feePayer` is assigned) and used to filter candidates before
 * every sign/simulate call below.
 */
function getRequiredSignerKeys(tx: Transaction): Set<string> {
  const required = new Set<string>();
  if (tx.feePayer) {
    required.add(tx.feePayer.toBase58());
  }
  for (const ix of tx.instructions) {
    for (const meta of ix.keys) {
      if (meta.isSigner) {
        required.add(meta.pubkey.toBase58());
      }
    }
  }
  return required;
}

/** Dedupe `candidates` (by pubkey, first occurrence wins) down to the ones `tx` actually needs. */
function resolveStepSigners(tx: Transaction, candidates: Keypair[]): Keypair[] {
  const required = getRequiredSignerKeys(tx);
  const seen = new Set<string>();
  const resolved: Keypair[] = [];
  for (const candidate of candidates) {
    const key = candidate.publicKey.toBase58();
    if (seen.has(key) || !required.has(key)) {
      continue;
    }
    seen.add(key);
    resolved.push(candidate);
  }
  return resolved;
}

/**
 * Send (or simulate) an ORDERED chain of transactions that must land in sequence —
 * the main new infrastructure behind zap's multi-transaction bundles (setup ->
 * swap(s) -> ledger -> zap-in/out -> clean-up), written generically so any future
 * multi-tx flow can reuse it.
 *
 * Every step gets `payer` set as `feePayer` and `computeUnitPriceMicroLamports` applied
 * via `modifyComputeUnitPriceIx` before signing. Steps with zero instructions (e.g. an
 * empty clean-up transaction when nothing needed closing) are skipped — sending an
 * empty transaction would only waste a fee.
 *
 * - `dryRun`: simulates EVERY step in order via `runSimulateTransaction`, even after an
 *   earlier step fails, so a single dry run reports every problem it can find at once;
 *   throws a combined error listing all failed steps if any did (with per-step reasons)
 *   after printing all per-step results.
 * - live send: sends sequentially with a FRESH blockhash fetched right before each step
 *   (`connection.getLatestBlockhash`) and `DEFAULT_SEND_TX_MAX_RETRIES` retries, ABORTING
 *   immediately on the first failure — continuing after a real failure could send steps
 *   out of order against unexpected on-chain state. The thrown error names the failed
 *   step and every step that was NOT sent, plus a resume hint: earlier steps already
 *   landed on-chain, so re-running the same command (which rebuilds the bundle from
 *   current on-chain state) is the right recovery — not blind restart-from-scratch
 *   assumptions.
 */
export async function sendOrderedTransactions(
  connection: Connection,
  steps: OrderedTransactionStep[],
  payer: Keypair,
  dryRun: boolean,
  computeUnitPriceMicroLamports: number
): Promise<void> {
  const emptySteps = steps.filter((step) => step.tx.instructions.length === 0);
  const runnable = steps.filter((step) => step.tx.instructions.length > 0);

  if (emptySteps.length > 0) {
    console.log(
      `\n> Skipping ${emptySteps.length} step(s) with no instructions (nothing to do): ` +
        emptySteps.map((step) => `"${step.label}"`).join(', ')
    );
  }

  if (runnable.length === 0) {
    console.log('> No transactions to send — nothing to do.');
    return;
  }

  console.log(
    `\n> ${dryRun ? 'Simulating' : 'Sending'} ${runnable.length} ordered transaction(s) in sequence:`
  );
  runnable.forEach((step, index) => console.log(`  ${index + 1}. ${step.label}`));

  if (dryRun) {
    const failures: string[] = [];
    for (let i = 0; i < runnable.length; i++) {
      const step = runnable[i];
      if (!step) {
        throw new Error(`Ordered step at index ${i} is undefined`);
      }
      const stepNumber = i + 1;
      step.tx.feePayer = payer.publicKey;
      modifyComputeUnitPriceIx(step.tx, computeUnitPriceMicroLamports);
      const signers = resolveStepSigners(step.tx, [payer, ...step.signers]);

      console.log(`\n> [${stepNumber}/${runnable.length}] Simulating "${step.label}"...`);
      try {
        await runSimulateTransaction(connection, signers, payer.publicKey, [step.tx]);
        console.log(`> [${stepNumber}/${runnable.length}] "${step.label}" simulation successful`);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        console.error(
          `> [${stepNumber}/${runnable.length}] "${step.label}" simulation FAILED: ${message}`
        );
        failures.push(`${stepNumber}. "${step.label}": ${message}`);
      }
    }

    if (failures.length > 0) {
      throw new Error(
        `Dry run: ${failures.length}/${runnable.length} step(s) failed simulation:\n` +
          failures.join('\n') +
          '\nFix the failing step(s) above, then re-run with dryRun once every step simulates clean.'
      );
    }
    console.log(`\n>>> All ${runnable.length} step(s) simulated successfully.`);
    return;
  }

  for (let i = 0; i < runnable.length; i++) {
    const step = runnable[i];
    if (!step) {
      throw new Error(`Ordered step at index ${i} is undefined`);
    }
    const stepNumber = i + 1;
    step.tx.feePayer = payer.publicKey;
    modifyComputeUnitPriceIx(step.tx, computeUnitPriceMicroLamports);
    const signers = resolveStepSigners(step.tx, [payer, ...step.signers]);

    console.log(`\n>> [${stepNumber}/${runnable.length}] Sending "${step.label}"...`);
    try {
      const signature = await sendAndConfirmTransaction(connection, step.tx, signers, {
        commitment: connection.commitment,
        maxRetries: DEFAULT_SEND_TX_MAX_RETRIES,
      });
      console.log(`>>> [${stepNumber}/${runnable.length}] "${step.label}" confirmed: ${signature}`);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const remainingLabels = runnable.slice(i + 1).map((s) => s.label);
      const remainingNote =
        remainingLabels.length > 0
          ? `Step(s) ${stepNumber + 1}-${runnable.length} were NOT sent: ${remainingLabels.join(' -> ')}.`
          : 'This was the last step.';
      throw new Error(
        `Aborted at step ${stepNumber}/${runnable.length} ("${step.label}"): ${message}\n` +
          `${remainingNote} Step(s) 1-${stepNumber} above already landed on-chain — do not assume a ` +
          'clean slate. Re-run the same command to resume: it rebuilds a fresh ordered bundle from ' +
          'current on-chain state rather than blindly restarting from step 1.'
      );
    }
  }

  console.log(`\n>>> All ${runnable.length} step(s) sent and confirmed successfully.`);
}
