import { Keypair } from '@solana/web3.js';
import bs58 from 'bs58';
import { config } from 'dotenv';
import fs from 'fs';
import path from 'path';

config();

function generateKeypairFromPrivateKey() {
  try {
    const privateKeyString = process.env.PRIVATE_KEY;

    if (!privateKeyString) {
      throw new Error('PRIVATE_KEY is not defined in the .env file');
    }

    const secretKey = bs58.decode(privateKeyString);

    const keypair = Keypair.fromSecretKey(secretKey);

    console.log('Public Key:', keypair.publicKey.toString());

    const keypairArray = Array.from(keypair.secretKey);

    const outputPath = path.join(__dirname, '../../../keypair.json');
    fs.writeFileSync(outputPath, JSON.stringify(keypairArray, null, 4));

    console.log(`Keypair saved to: ${outputPath}`);

    return keypair;
  } catch (error) {
    console.error('Error generating keypair:', error);
    throw error;
  }
}

generateKeypairFromPrivateKey();
