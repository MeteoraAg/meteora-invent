import { simulateTransaction } from '@coral-xyz/anchor/dist/cjs/utils/rpc';
import {
  AddressLookupTableAccount,
  ComputeBudgetProgram,
  PublicKey,
  Transaction,
  Keypair,
  Connection,
  TransactionMessage,
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

/** See `sendOrderedInstructions`'s `retry` parameter. */
export type RetrySafety = 'idempotent' | 'not-idempotent';

/**
 * What `sendOrderedInstructions` should tell the user if a live send aborts partway through.
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

const MAX_TRANSACTION_SIZE = 1232;
const MAX_COMPUTE_UNIT_LIMIT = 1_400_000;
const COMPUTE_UNIT_HEADROOM = 1.2;

function computeBudgetInstructions(units: number, microLamports: number): TransactionInstruction[] {
  return [
    ComputeBudgetProgram.setComputeUnitLimit({ units }),
    ComputeBudgetProgram.setComputeUnitPrice({ microLamports }),
  ];
}

function compileV0Transaction(
  payer: PublicKey,
  blockhash: string,
  instructions: TransactionInstruction[],
  addressLookupTableAccounts: AddressLookupTableAccount[]
): VersionedTransaction {
  return new VersionedTransaction(
    new TransactionMessage({
      payerKey: payer,
      recentBlockhash: blockhash,
      instructions,
    }).compileToV0Message(addressLookupTableAccounts)
  );
}

function fitsInTransaction(
  payer: PublicKey,
  instructions: TransactionInstruction[],
  addressLookupTableAccounts: AddressLookupTableAccount[]
): boolean {
  try {
    const tx = compileV0Transaction(
      payer,
      PublicKey.default.toBase58(),
      [...computeBudgetInstructions(MAX_COMPUTE_UNIT_LIMIT, 0), ...instructions],
      addressLookupTableAccounts
    );
    return tx.serialize().length <= MAX_TRANSACTION_SIZE;
  } catch {
    return false;
  }
}

/** Sign with every candidate the transaction requires, skipping the rest. */
function signV0Transaction(tx: VersionedTransaction, candidates: Keypair[]): void {
  const { header, staticAccountKeys } = tx.message;
  const required = staticAccountKeys.slice(0, header.numRequiredSignatures);
  tx.sign(
    candidates.filter((candidate) => required.some((key) => key.equals(candidate.publicKey)))
  );
}

/**
 * Compile `instructions` into a v0 transaction whose compute unit limit is the simulated
 * consumption plus headroom, with the compute unit price set. Throws if the simulation fails.
 */
async function buildSizedTransaction(
  connection: Connection,
  payer: PublicKey,
  instructions: TransactionInstruction[],
  addressLookupTableAccounts: AddressLookupTableAccount[],
  computeUnitPriceMicroLamports: number
) {
  const { blockhash, lastValidBlockHeight } = await connection.getLatestBlockhash(
    connection.commitment
  );
  const compile = (units: number) =>
    compileV0Transaction(
      payer,
      blockhash,
      [...computeBudgetInstructions(units, computeUnitPriceMicroLamports), ...instructions],
      addressLookupTableAccounts
    );

  const { value } = await connection.simulateTransaction(compile(MAX_COMPUTE_UNIT_LIMIT), {
    sigVerify: false,
    commitment: connection.commitment,
  });
  if (value.err) {
    throw new Error(
      `simulation failed: ${JSON.stringify(value.err)}\nLogs: ${(value.logs ?? []).join('\n')}`
    );
  }
  if (value.unitsConsumed === undefined) {
    throw new Error('the RPC did not report the compute units the simulation consumed');
  }

  const unitLimit = Math.min(
    Math.ceil(value.unitsConsumed * COMPUTE_UNIT_HEADROOM),
    MAX_COMPUTE_UNIT_LIMIT
  );
  console.log(
    `>>> Simulated successfully, ${value.unitsConsumed} compute units (limit ${unitLimit})`
  );
  return { tx: compile(unitLimit), blockhash, lastValidBlockHeight };
}

/**
 * Send (or simulate) instructions that must run in order, e.g. a zap's setup -> swap(s) ->
 * ledger -> zap-in/out -> clean-up sequence, packed in order into as few v0 transactions as
 * fit. The compute unit limit of each transaction comes from a simulation run right before it
 * is sent, so a later transaction is sized against the state the earlier ones left behind.
 *
 * Instructions given as an array are a group and are never split across transactions. Any
 * other split keeps the order and is valid for the zap SDK, but it gives up atomicity: a live
 * send aborts on the first failure and the thrown error says what already landed, following
 * `retry`'s guidance without ever printing a secret key.
 *
 * A dry run simulates only the first transaction. Later ones read accounts the earlier ones
 * create, so simulating them against unchanged chain state would report false failures; they
 * are listed as deferred instead and only a live send verifies them.
 * @param connection - The connection to the cluster
 * @param instructions - The instructions in execution order; an array entry is a group
 * @param addressLookupTableAccounts - The lookup tables the instructions use
 * @param payer - The fee payer and default signer
 * @param extraSigners - Further keypairs, used only by the transactions that require them
 * @param dryRun - Whether to simulate instead of sending
 * @param computeUnitPriceMicroLamports - The compute unit price applied to every transaction
 * @param retry - Per-caller recovery guidance, see `OrderedTransactionsRetryInfo`
 */
export async function sendOrderedInstructions(
  connection: Connection,
  instructions: Array<TransactionInstruction | TransactionInstruction[]>,
  addressLookupTableAccounts: AddressLookupTableAccount[],
  payer: Keypair,
  extraSigners: Keypair[],
  dryRun: boolean,
  computeUnitPriceMicroLamports: number,
  retry: OrderedTransactionsRetryInfo
): Promise<void> {
  // The compute unit limit and price are set here; an instruction that sets them again would
  // make the transaction fail as a duplicate.
  const groups = instructions
    .map((item) => (Array.isArray(item) ? item : [item]))
    .map((group) => group.filter((ix) => !ix.programId.equals(ComputeBudgetProgram.programId)))
    .filter((group) => group.length > 0);

  if (groups.length === 0) {
    console.log('> No instructions to send — nothing to do.');
    return;
  }

  const batches: TransactionInstruction[][] = [];
  for (const group of groups) {
    const current = batches[batches.length - 1];
    if (
      current &&
      fitsInTransaction(payer.publicKey, [...current, ...group], addressLookupTableAccounts)
    ) {
      current.push(...group);
    } else if (fitsInTransaction(payer.publicKey, group, addressLookupTableAccounts)) {
      batches.push([...group]);
    } else {
      throw new Error(
        `${group.length} instruction(s) that must share a transaction do not fit in one ` +
          '(or could not be compiled). Nothing was sent.'
      );
    }
  }

  const labels = batches.map((batch) => `${batch.length} instruction(s)`);
  console.log(
    `\n> ${dryRun ? 'Simulating' : 'Sending'} ${batches.length} transaction(s) in sequence:`
  );
  labels.forEach((label, index) => console.log(`  ${index + 1}. ${label}`));

  const signers = [payer, ...extraSigners];
  const simulatedCount = dryRun ? 1 : batches.length;

  for (let i = 0; i < simulatedCount; i++) {
    const batch = batches[i];
    if (!batch) {
      throw new Error(`Transaction batch at index ${i} is undefined`);
    }
    const number = i + 1;

    try {
      console.log(
        `\n> [${number}/${batches.length}] ${dryRun ? 'Simulating' : 'Sending'} ${labels[i]}...`
      );
      const { tx, blockhash, lastValidBlockHeight } = await buildSizedTransaction(
        connection,
        payer.publicKey,
        batch,
        addressLookupTableAccounts,
        computeUnitPriceMicroLamports
      );
      if (dryRun) {
        continue;
      }

      signV0Transaction(tx, signers);
      const signature = await connection.sendTransaction(tx, {
        maxRetries: DEFAULT_SEND_TX_MAX_RETRIES,
      });
      const confirmation = await connection.confirmTransaction(
        { signature, blockhash, lastValidBlockHeight },
        connection.commitment
      );
      if (confirmation.value.err) {
        throw new Error(`${signature} failed: ${JSON.stringify(confirmation.value.err)}`);
      }
      console.log(`>>> [${number}/${batches.length}] confirmed: ${signature}`);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (dryRun) {
        throw new Error(
          `Dry run: transaction ${number}/${batches.length} failed simulation: ${message}\n` +
            'Fix the failure above, then re-run with dryRun once it simulates clean.'
        );
      }

      const remainingNote =
        number < batches.length
          ? `Transaction(s) ${number + 1}-${batches.length} were NOT sent.`
          : 'This was the last transaction.';
      const landedNote =
        number > 1
          ? `Transaction(s) 1-${number - 1} already landed on-chain — do not assume a clean slate.`
          : 'No earlier transaction landed.';

      // recoveryAddress is documented as public-only; never include a secret key here.
      const recoveryLine = retry.recoveryAddress
        ? `Recovery reference address: ${retry.recoveryAddress}.`
        : 'No single recovery reference address applies to this bundle.';

      const resumeGuidance =
        retry.retrySafety === 'idempotent'
          ? 'Re-running the same command IS safe here: it re-reads current on-chain state and ' +
            'resumes/converges from wherever this left off, rather than repeating an already-landed ' +
            'action.'
          : number === 1
            ? 'Nothing landed before this transaction, so re-running is safe unless the failure was a ' +
              `confirmation timeout; in that case inspect ${retry.recoveryAddress ?? 'the wallet'} first.`
            : 'Re-running the same command does NOT resume this — it builds a brand-new bundle from ' +
              'scratch (e.g. a fresh position keypair) and WILL repeat any action that already landed, ' +
              'such as a second real deposit. Before doing anything else: inspect current on-chain ' +
              'state with a READ-ONLY action (e.g. damm-v2-get-positions / dlmm-get-positions)' +
              `${retry.recoveryAddress ? ` for ${retry.recoveryAddress}` : ''} and confirm whether the ` +
              'deposit already landed. If it did, do NOT re-run this command — for DAMM v2, set ' +
              'positionMode to "existing" (selecting that position if prompted) to continue safely ' +
              'instead of creating another one.';

      const failureSummary =
        `Aborted at transaction ${number}/${batches.length}: ${message}\n` +
        `${remainingNote} ${landedNote}\n${recoveryLine}\n${resumeGuidance}`;

      console.error(`\n>>> ${failureSummary}`);
      throw new Error(failureSummary);
    }
  }

  if (dryRun) {
    if (batches.length === 1) {
      console.log('\n>>> The transaction simulated successfully.');
    } else {
      console.log(
        `\n>>> 1/${batches.length} transaction(s) simulated successfully; ${batches.length - 1} ` +
          'deferred (not a failure) because they depend on an earlier transaction that only ' +
          'lands during a real send:\n' +
          labels
            .map((label, index) => `${index + 1}. ${label}`)
            .slice(1)
            .join('\n')
      );
    }
    return;
  }

  console.log(`\n>>> All ${batches.length} transaction(s) sent and confirmed successfully.`);
}
