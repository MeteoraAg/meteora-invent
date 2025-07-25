import { Wallet } from '@coral-xyz/anchor';
import {
  PublicKey,
  Connection,
  Signer,
  sendAndConfirmTransaction,
  Keypair,
  ComputeBudgetProgram,
  SystemProgram,
  Transaction,
  TransactionSignature,
} from '@solana/web3.js';
import { CreateTokenMintOptions } from '../utils/types';
import { getAmountInLamports, getSigners } from './common';
import BN from 'bn.js';
import {
  createInitializeMint2Instruction,
  createMintToInstruction,
  getMinimumBalanceForRentExemptMint,
  getOrCreateAssociatedTokenAccount,
  MINT_SIZE,
  TOKEN_PROGRAM_ID,
} from '@solana/spl-token';
import { DEFAULT_SEND_TX_MAX_RETRIES } from '../utils/constants';

export async function createTokenMint(
  connection: Connection,
  wallet: Wallet,
  options: CreateTokenMintOptions
): Promise<PublicKey> {
  if (options.dryRun) {
    throw new Error('cannot create token mint when in dry run mode');
  }

  const mintAmount = getAmountInLamports(options.mintTokenAmount, options.decimals);

  const mint: PublicKey = await createAndMintToken(
    connection,
    wallet,
    options.decimals,
    mintAmount,
    options.computeUnitPriceMicroLamports
  );

  console.log(
    `>> Mint token mint ${mint} to payer wallet. Amount ${options.mintTokenAmount} in lamport ${mintAmount}`
  );

  return mint;
}

async function createAndMintToken(
  connection: Connection,
  wallet: Wallet,
  mintDecimals: number,
  mintAmountLamport: BN,
  computeUnitPriceMicroLamports: number
): Promise<PublicKey> {
  const mint = await createMintWithPriorityFee(
    connection,
    wallet.payer,
    wallet.publicKey,
    null,
    mintDecimals,
    computeUnitPriceMicroLamports
  );
  console.log(`Created token mint ${mint}`);

  const walletTokenATA = await getOrCreateAssociatedTokenAccount(
    connection,
    wallet.payer,
    mint,
    wallet.publicKey,
    true,
    connection.commitment
  );
  await mintToWithPriorityFee(
    connection,
    wallet.payer,
    mint,
    walletTokenATA.address,
    wallet.publicKey,
    BigInt(mintAmountLamport.toString()),
    [],
    computeUnitPriceMicroLamports
  );
  console.log(`Minted ${mint} to wallet`);

  return mint;
}

async function createMintWithPriorityFee(
  connection: Connection,
  payer: Signer,
  mintAuthority: PublicKey,
  freezeAuthority: PublicKey | null,
  decimals: number,
  computeUnitPriceMicroLamports: number,
  keypair = Keypair.generate(),
  programId = TOKEN_PROGRAM_ID
): Promise<PublicKey> {
  const lamports = await getMinimumBalanceForRentExemptMint(connection);

  const addPriorityFeeIx = ComputeBudgetProgram.setComputeUnitPrice({
    microLamports: computeUnitPriceMicroLamports,
  });

  const createAccountIx = SystemProgram.createAccount({
    fromPubkey: payer.publicKey,
    newAccountPubkey: keypair.publicKey,
    space: MINT_SIZE,
    lamports,
    programId,
  });

  const createInitializeMint2Tx = createInitializeMint2Instruction(
    keypair.publicKey,
    decimals,
    mintAuthority,
    freezeAuthority,
    programId
  );

  const transaction = new Transaction().add(
    addPriorityFeeIx,
    createAccountIx,
    createInitializeMint2Tx
  );

  await sendAndConfirmTransaction(connection, transaction, [payer, keypair], {
    commitment: connection.commitment,
    maxRetries: DEFAULT_SEND_TX_MAX_RETRIES,
  });

  return keypair.publicKey;
}

async function mintToWithPriorityFee(
  connection: Connection,
  payer: Signer,
  mint: PublicKey,
  destination: PublicKey,
  authority: Signer | PublicKey,
  amount: number | bigint,
  multiSigners: Signer[] = [],
  computeUnitPriceMicroLamports: number,
  programId = TOKEN_PROGRAM_ID
): Promise<TransactionSignature> {
  const [authorityPublicKey, signers] = getSigners(authority, multiSigners);

  const addPriorityFeeIx = ComputeBudgetProgram.setComputeUnitPrice({
    microLamports: computeUnitPriceMicroLamports,
  });

  const transaction = new Transaction().add(
    addPriorityFeeIx,
    createMintToInstruction(mint, destination, authorityPublicKey, amount, multiSigners, programId)
  );

  return await sendAndConfirmTransaction(connection, transaction, [payer, ...signers], {
    commitment: connection.commitment,
    maxRetries: DEFAULT_SEND_TX_MAX_RETRIES,
  });
}
