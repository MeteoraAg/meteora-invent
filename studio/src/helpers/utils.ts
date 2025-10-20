import { Keypair, Connection, LAMPORTS_PER_SOL } from '@solana/web3.js';
import fs from 'fs/promises';
import { parse as parseJsonc } from 'jsonc-parser';
import { PriceRoundingConfig } from '../utils/types';
import { Rounding } from '@meteora-ag/presale';

export async function safeParseJsonFromFile<T>(filePath: string): Promise<T> {
  try {
    const rawData = await fs.readFile(filePath, 'utf-8');
    const result = parseJsonc(rawData);
    if (result === undefined) {
      throw new Error('Failed to parse JSON content');
    }
    return result as T;
  } catch (error) {
    console.error('Error reading or parsing JSON file:', error);
    throw new Error(`failed to parse file ${filePath}`);
  }
}

export async function safeParseKeypairFromFile(filePath: string): Promise<Keypair> {
  const keypairJson: Array<number> = await safeParseJsonFromFile(filePath);
  const keypairBytes = Uint8Array.from(keypairJson);
  const keypair = Keypair.fromSecretKey(keypairBytes);
  return keypair;
}

export async function airdropSol(
  connection: Connection,
  keypair: Keypair,
  amount: number = 1
): Promise<string> {
  try {
    const signature = await connection.requestAirdrop(keypair.publicKey, amount * LAMPORTS_PER_SOL);

    await connection.confirmTransaction(signature, 'confirmed');

    console.log(`Airdropped ${amount} SOL to ${keypair.publicKey.toString()}`);

    return signature;
  } catch (error) {
    console.error('Error airdropping SOL:', error);
    throw error;
  }
}

export function isPriceRoundingUp(priceRoundingConfig: PriceRoundingConfig): boolean {
  return priceRoundingConfig == PriceRoundingConfig.Up;
}

export function getRounding(rounding: 'up' | 'down'): Rounding {
  return rounding === 'up' ? Rounding.Up : Rounding.Down;
}
