import { NextApiRequest, NextApiResponse } from 'next';
import { Connection, Keypair, sendAndConfirmRawTransaction, Transaction } from '@solana/web3.js';

const RPC_URL = process.env.RPC_URL as string;

if (!RPC_URL) {
  throw new Error('Missing required environment variables');
}

type SendTransactionRequest = {
  signedTransaction: string; // base64 encoded signed transaction
  additionalSigners: Keypair[];
};

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  console.log('req.body', req.body);
  try {
    const { signedTransaction } = req.body as SendTransactionRequest;

    if (!signedTransaction) {
      return res.status(400).json({ error: 'Missing signed transaction' });
    }

    const connection = new Connection(RPC_URL, 'confirmed');
    const transaction = Transaction.from(Buffer.from(signedTransaction, 'base64'));

    // Send transaction
    const txSignature = await sendAndConfirmRawTransaction(connection, transaction.serialize(), {
      commitment: 'confirmed',
    });

    res.status(200).json({
      success: true,
      signature: txSignature,
    });
  } catch (error: any) {
    console.error('Transaction error:', error);

    // Provide user-friendly error messages based on error type
    let errorMessage = 'Transaction failed';

    if (error.message?.includes('Insufficient funds')) {
      errorMessage = 'Insufficient SOL balance. Please add funds to your wallet.';
    } else if (error.message?.includes('blockhash not found')) {
      errorMessage = 'Transaction expired. Please try again.';
    } else if (error.message?.includes('This transaction has already been processed')) {
      errorMessage = 'Transaction already processed.';
    } else if (error.message?.includes('Transaction simulation failed')) {
      errorMessage = 'Transaction validation failed. Please try again.';
    } else if (error.message?.includes('custom program error')) {
      errorMessage = 'Smart contract error. Please contact support.';
    } else if (error.message?.includes('timed out')) {
      errorMessage = 'Transaction timed out. Please try again.';
    } else if (error instanceof Error) {
      errorMessage = error.message;
    }

    res.status(500).json({ error: errorMessage });
  }
}
