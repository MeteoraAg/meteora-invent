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
 * Merge several already-built Transactions' instructions into one transaction, in order, so
 * a step that depends on an account an earlier step creates can still be dry-run verified.
 * Does not set feePayer or sign anything — callers still do that on the result.
 * @param txs - The transactions to merge, in order
 * @returns The combined transaction
 */
export function combineTransactions(txs: Transaction[]): Transaction {
  const combined = new Transaction();
  for (const tx of txs) {
    combined.add(...tx.instructions);
  }
  return combined;
}

/**
 * One step of an ordered, must-run-in-sequence transaction bundle (e.g. a zap's
 * setup -> swap(s) -> ledger -> zap-in -> clean-up chain). `signers` is the superset of
 * candidate keypairs that might co-sign this step; `sendOrderedTransactions` resolves
 * per-step which of them are actually required.
 */
export interface OrderedTransactionStep {
  label: string;
  tx: Transaction;
  signers: Keypair[];
  /**
   * Set when this step depends on an account an earlier step only creates once sent for
   * real, so a dry run cannot honestly simulate it in isolation — it gets skipped instead
   * of reporting a false failure (a live send still runs it in order). Prefer restructuring
   * with `combineTransactions` instead where possible: a skipped step is unverified, not
   * verified-safe.
   */
  dependsOnPriorStep?: boolean;
}

/** See `sendOrderedTransactions`'s `retry` parameter. */
export type RetrySafety = 'idempotent' | 'not-idempotent';

/**
 * What `sendOrderedTransactions` should tell the user if a live send aborts partway through.
 * Required from every caller: the helper cannot infer on its own whether re-running is safe.
 */
export interface OrderedTransactionsRetryInfo {
  /**
   * - 'idempotent': the caller re-derives its plan from current on-chain state every run
   *   (e.g. zap-out re-reads the position's remaining liquidity), so re-running after an
   *   abort converges instead of repeating an already-landed action.
   * - 'not-idempotent': the caller manufactures new state each run (e.g. zap-in mints a
   *   fresh position keypair) or would otherwise repeat a landed side effect, so re-running
   *   after an abort can perform a second real action instead of resuming.
   */
  retrySafety: RetrySafety;
  /**
   * Address to print in the abort message so the user knows what to inspect; omit when the
   * bundle has no single such identifier. Printed verbatim, so never pass a secret key.
   */
  recoveryAddress?: string;
}

/**
 * The set of pubkeys (base58) a transaction requires a signature from: its fee payer plus
 * every account an instruction marks `isSigner`. `Transaction.sign()` throws for a keypair
 * outside this set, so this must be computed from the final tx and used to filter candidates
 * before every sign/simulate call below.
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
 * Send (or simulate) an ordered chain of transactions that must land in sequence, e.g. a
 * zap's setup -> swap(s) -> ledger -> zap-in/out -> clean-up bundle. Steps with zero
 * instructions are skipped, and a dry run skips one marked `dependsOnPriorStep` instead of
 * falsely failing it (see that field's doc). A live send aborts on the first failure; the
 * thrown error names the failed step and the steps not sent, and follows `retry`'s guidance
 * without ever printing a secret key.
 * @param connection - The connection to the cluster
 * @param steps - The ordered steps to send or simulate
 * @param payer - The fee payer and default signer for every step
 * @param dryRun - Whether to simulate instead of sending
 * @param computeUnitPriceMicroLamports - The compute unit price applied to every step
 * @param retry - Per-caller recovery guidance — see `OrderedTransactionsRetryInfo`
 */
export async function sendOrderedTransactions(
  connection: Connection,
  steps: OrderedTransactionStep[],
  payer: Keypair,
  dryRun: boolean,
  computeUnitPriceMicroLamports: number,
  retry: OrderedTransactionsRetryInfo
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
    const deferred: string[] = [];
    for (let i = 0; i < runnable.length; i++) {
      const step = runnable[i];
      if (!step) {
        throw new Error(`Ordered step at index ${i} is undefined`);
      }
      const stepNumber = i + 1;

      if (step.dependsOnPriorStep) {
        console.log(
          `\n> [${stepNumber}/${runnable.length}] Deferring simulation of "${step.label}": it ` +
            'depends on an earlier step that only actually takes effect once sent for real, so ' +
            'simulating it in isolation (against otherwise-unchanged chain state) cannot honestly ' +
            'verify it. It will run for real, in its place, on a live (non-dry-run) send.'
        );
        deferred.push(`${stepNumber}. "${step.label}"`);
        continue;
      }

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
    const verifiedCount = runnable.length - deferred.length;
    if (deferred.length > 0) {
      console.log(
        `\n>>> ${verifiedCount}/${runnable.length} step(s) simulated successfully; ${deferred.length} ` +
          'step(s) deferred (not a failure — see above) because they depend on an earlier step that ' +
          'only lands during a real send:\n' +
          deferred.join('\n')
      );
    } else {
      console.log(`\n>>> All ${runnable.length} step(s) simulated successfully.`);
    }
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

      // recoveryAddress is documented as public-only; never include a secret key here.
      const recoveryLine = retry.recoveryAddress
        ? `Recovery reference address: ${retry.recoveryAddress}.`
        : 'No single recovery reference address applies to this bundle.';

      const resumeGuidance =
        retry.retrySafety === 'idempotent'
          ? 'Re-running the same command IS safe here: it re-reads current on-chain state and ' +
            'resumes/converges from wherever this left off, rather than repeating an already-landed ' +
            'action.'
          : 'Re-running the same command does NOT resume this — it builds a brand-new bundle from ' +
            'scratch (e.g. a fresh position keypair) and WILL repeat any action that already landed, ' +
            'such as a second real deposit. Before doing anything else: inspect current on-chain ' +
            'state with a READ-ONLY action (e.g. damm-v2-get-positions / dlmm-get-positions)' +
            `${retry.recoveryAddress ? ` for ${retry.recoveryAddress}` : ''} and confirm whether the ` +
            'deposit already landed. If it did, do NOT re-run this command — for DAMM v2, set ' +
            'positionMode to "existing" (selecting that position if prompted) to continue safely ' +
            'instead of creating another one.';

      const failureSummary =
        `Aborted at step ${stepNumber}/${runnable.length} ("${step.label}"): ${message}\n` +
        `${remainingNote} Step(s) 1-${stepNumber} above already landed on-chain — do not assume a ` +
        `clean slate.\n${recoveryLine}\n${resumeGuidance}`;

      console.error(`\n>>> ${failureSummary}`);
      throw new Error(failureSummary);
    }
  }

  console.log(`\n>>> All ${runnable.length} step(s) sent and confirmed successfully.`);
}
