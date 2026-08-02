/**
 * Shared helpers for the Meteora skill one-shot scripts.
 * Env: RPC_URL (required), KEYPAIR_PATH (JSON keypair file) or PRIVATE_KEY (base58).
 * Writes only execute when --execute is passed; default is simulate-and-report.
 */
import {
  Connection,
  Keypair,
  Transaction,
  sendAndConfirmTransaction,
  ComputeBudgetProgram,
} from '@solana/web3.js';
import bs58 from 'bs58';
import fs from 'fs';

export function getConnection(): Connection {
  const url = process.env.RPC_URL;
  if (!url) throw new Error('Set RPC_URL (e.g. https://api.devnet.solana.com)');
  return new Connection(url, 'confirmed');
}

export function loadKeypair(): Keypair {
  const path = process.env.KEYPAIR_PATH;
  if (path) {
    return Keypair.fromSecretKey(
      Uint8Array.from(JSON.parse(fs.readFileSync(path, 'utf-8')))
    );
  }
  const pk = process.env.PRIVATE_KEY;
  if (pk) return Keypair.fromSecretKey(bs58.decode(pk));
  throw new Error('Set KEYPAIR_PATH (JSON keypair file) or PRIVATE_KEY (base58)');
}

export function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i > -1 ? process.argv[i + 1] : undefined;
}

export function requireArg(name: string, hint: string): string {
  const v = arg(name);
  if (!v) throw new Error(`Missing --${name} <${hint}>`);
  return v;
}

export function shouldExecute(): boolean {
  return process.argv.includes('--execute');
}

export function explorerTx(sig: string): string {
  const cluster = (process.env.RPC_URL ?? '').includes('devnet') ? '?cluster=devnet' : '';
  return `https://solscan.io/tx/${sig}${cluster}`;
}

/** Simulates by default; sends only with --execute. Adds a priority fee. */
export async function simulateOrSend(
  connection: Connection,
  tx: Transaction,
  signers: Keypair[],
  label: string
): Promise<void> {
  tx.instructions.unshift(
    ComputeBudgetProgram.setComputeUnitPrice({
      microLamports: Number(process.env.CU_PRICE_MICROLAMPORTS ?? 100_000),
    })
  );
  const { blockhash } = await connection.getLatestBlockhash('confirmed');
  tx.recentBlockhash = blockhash;
  tx.feePayer = signers[0].publicKey;

  if (!shouldExecute()) {
    tx.sign(...signers);
    const sim = await connection.simulateTransaction(tx);
    console.log(`[dry-run] ${label}: err=${JSON.stringify(sim.value.err)}`);
    if (sim.value.logs) console.log(sim.value.logs.join('\n'));
    console.log('Re-run with --execute to send for real.');
    return;
  }
  const sig = await sendAndConfirmTransaction(connection, tx, signers, {
    commitment: 'confirmed',
  });
  console.log(`${label}: ${explorerTx(sig)}`);
}
