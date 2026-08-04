import { Connection, Keypair, PublicKey, sendAndConfirmTransaction } from '@solana/web3.js';
import { Wallet } from '@coral-xyz/anchor';
import {
  calculateTotalLockedVestingAmount,
  deriveEscrow,
  deriveEscrowMetadata,
  getTokenProgram,
  LockClient,
} from '@meteora-ag/met-lock-sdk';
import {
  getAccount,
  getAssociatedTokenAddressSync,
  getMint,
  TOKEN_2022_PROGRAM_ID,
  TOKEN_PROGRAM_ID,
  TokenAccountNotFoundError,
  TokenInvalidAccountOwnerError,
  unpackMint,
} from '@solana/spl-token';
import BN from 'bn.js';
import { LockConfig } from '../../utils/types';
import {
  getAmountInLamports,
  getAmountInTokens,
  modifyComputeUnitPriceIx,
  runSimulateTransaction,
} from '../../helpers';
import {
  DEFAULT_COMMITMENT_LEVEL,
  DEFAULT_SEND_TX_MAX_RETRIES,
  SOL_TOKEN_MINT,
} from '../../utils/constants';

// u64::MAX — met-lock-sdk's claimV2 caps the actual transfer at whatever has vested, so
// passing this sentinel (per the SDK's own scripts/claimV2.s.ts convention) means "claim
// everything currently claimable".
const U64_MAX = new BN(2).pow(new BN(64)).sub(new BN(1));

/**
 * Create a Met Lock vesting escrow for `baseMint`. Reads config.lockCreateEscrow.
 *
 * Generates a fresh `base` keypair (it only ever co-signs this one transaction — the escrow
 * address it derives is what every later lock-* action needs via --escrow, so it is logged
 * prominently below) and signs with [sender=wallet, base, payer=wallet] per the SDK's
 * scripts/createVestingEscrowV2.s.ts reference (docs.md's example is correct here, but its
 * "payer and feeVault must sign" note is copy-pasted from a different SDK — there is no
 * feeVault in met-lock).
 */
export async function createVestingEscrow(
  config: LockConfig,
  connection: Connection,
  wallet: Wallet,
  baseMint: PublicKey
) {
  if (!config.lockCreateEscrow) {
    throw new Error('Missing lockCreateEscrow in configuration');
  }
  const {
    recipient,
    vestingStartTime,
    cliffTime,
    frequency,
    cliffUnlockAmount,
    amountPerPeriod,
    numberOfPeriod,
    updateRecipientMode,
    cancelMode,
    isSenderMultiSig,
  } = config.lockCreateEscrow;
  if (!(cliffUnlockAmount >= 0)) {
    throw new Error(`lockCreateEscrow.cliffUnlockAmount must be >= 0 (got ${cliffUnlockAmount})`);
  }
  if (!(amountPerPeriod >= 0)) {
    throw new Error(`lockCreateEscrow.amountPerPeriod must be >= 0 (got ${amountPerPeriod})`);
  }
  if (!Number.isInteger(numberOfPeriod) || numberOfPeriod < 0) {
    throw new Error(
      `lockCreateEscrow.numberOfPeriod must be a non-negative integer (got ${numberOfPeriod})`
    );
  }
  // Verified against @meteora-ag/met-lock-sdk@1.0.1's IDL: error 6009 is exactly
  // `InvalidVestingStartTime` ("Invalid vesting start time"), and this codebase's own
  // studio-actions.md documents (from earlier QA) that the program rejects creation whenever
  // vestingStartTime > cliffTime. Deliberately NOT checking cliffTime against "now" — an
  // already-elapsed cliff is a legitimate immediately-unlockable vesting schedule; only the
  // relative order matters here.
  if (!(vestingStartTime <= cliffTime)) {
    throw new Error(
      `lockCreateEscrow.vestingStartTime (${vestingStartTime}, ` +
        `${new Date(vestingStartTime * 1000).toISOString()}) must be <= cliffTime (${cliffTime}, ` +
        `${new Date(cliffTime * 1000).toISOString()}) — met-lock-sdk's create-vesting-escrow instruction ` +
        'rejects the reverse order on-chain with InvalidVestingStartTime (error 6009). Fix lock_config.jsonc ' +
        'so vestingStartTime <= cliffTime (a cliffTime in the past is fine on its own, e.g. for an ' +
        'immediately-unlockable vesting schedule, as long as it is not before vestingStartTime).'
    );
  }

  console.log('\n> Initializing Met Lock vesting escrow...');
  const payerBalance = await connection.getBalance(wallet.publicKey);
  if (payerBalance === 0) {
    throw new Error(
      `Wallet ${wallet.publicKey.toString()} has 0 SOL — fund it first; even dry-run simulation requires an existing fee payer account`
    );
  }

  if (baseMint.equals(SOL_TOKEN_MINT)) {
    console.log(
      "> Base mint is native SOL (wSOL) — this action does NOT wrap SOL for you. Make sure the wallet's wSOL associated token account already holds enough wrapped SOL before continuing (the balance check below will fail clearly otherwise)."
    );
  }

  const mintAccountInfo = await connection.getAccountInfo(baseMint);
  if (!mintAccountInfo) {
    throw new Error(`Base mint account not found: ${baseMint.toString()}`);
  }
  const tokenProgram = mintAccountInfo.owner.equals(TOKEN_2022_PROGRAM_ID)
    ? TOKEN_2022_PROGRAM_ID
    : TOKEN_PROGRAM_ID;
  const mintState = unpackMint(baseMint, mintAccountInfo, mintAccountInfo.owner);
  const decimals = mintState.decimals;

  console.log(`- Using baseMint ${baseMint.toString()}`);
  console.log(
    `- Token program: ${tokenProgram.equals(TOKEN_2022_PROGRAM_ID) ? 'Token-2022' : 'SPL Token'}`
  );

  const cliffUnlockAmountLamports = getAmountInLamports(cliffUnlockAmount, decimals);
  const amountPerPeriodLamports = getAmountInLamports(amountPerPeriod, decimals);
  const numberOfPeriodBN = new BN(numberOfPeriod);

  const totalLockedAmount = calculateTotalLockedVestingAmount(
    cliffUnlockAmountLamports,
    amountPerPeriodLamports,
    numberOfPeriodBN
  );
  console.log(
    `- Total locked amount: ${getAmountInTokens(totalLockedAmount, decimals)} (${totalLockedAmount.toString()} base units)`
  );
  if (totalLockedAmount.lten(0)) {
    throw new Error(
      'lockCreateEscrow would lock 0 tokens total (cliffUnlockAmount + amountPerPeriod * ' +
        'numberOfPeriod == 0) — set at least one of them to a positive amount.'
    );
  }

  // Pre-check the sender actually holds enough of the base mint before building the tx — the
  // on-chain failure otherwise is a generic transfer error with no context.
  const senderATA = getAssociatedTokenAddressSync(
    baseMint,
    wallet.publicKey,
    isSenderMultiSig,
    tokenProgram
  );
  let senderBalance = new BN(0);
  try {
    const account = await getAccount(connection, senderATA, connection.commitment, tokenProgram);
    senderBalance = new BN(account.amount.toString());
  } catch (error) {
    if (
      !(error instanceof TokenAccountNotFoundError) &&
      !(error instanceof TokenInvalidAccountOwnerError)
    ) {
      throw error;
    }
  }
  if (senderBalance.lt(totalLockedAmount)) {
    throw new Error(
      `Sender ${wallet.publicKey.toString()} holds ${getAmountInTokens(senderBalance, decimals)} of mint ${baseMint.toString()} but the escrow needs ${getAmountInTokens(totalLockedAmount, decimals)} — fund the sender token account first.`
    );
  }

  const base = Keypair.generate();
  console.log('- Generating new base keypair (co-signs once, then can be discarded)');
  console.log(`- Base public key: ${base.publicKey.toString()}`);

  const escrow = deriveEscrow(base.publicKey);

  const client = new LockClient(connection, DEFAULT_COMMITMENT_LEVEL);

  const createTx = await client.createVestingEscrowV2({
    base: base.publicKey,
    sender: wallet.publicKey,
    isSenderMultiSig,
    payer: wallet.publicKey,
    tokenMint: baseMint,
    vestingStartTime: new BN(vestingStartTime),
    cliffTime: new BN(cliffTime),
    frequency: new BN(frequency),
    cliffUnlockAmount: cliffUnlockAmountLamports,
    amountPerPeriod: amountPerPeriodLamports,
    numberOfPeriod: numberOfPeriodBN,
    recipient: new PublicKey(recipient),
    updateRecipientMode,
    cancelMode,
    tokenProgram,
  });

  modifyComputeUnitPriceIx(createTx, config.computeUnitPriceMicroLamports ?? 0);

  console.log('\n' + '='.repeat(70));
  console.log(
    config.dryRun ? '  MET LOCK — VESTING ESCROW (DRY RUN)' : '  MET LOCK — VESTING ESCROW'
  );
  console.log('='.repeat(70));
  if (config.dryRun) {
    console.log(`  Escrow address (THROWAWAY — dry run only, do NOT save):`);
    console.log(`    ${escrow.toString()}`);
    console.log('  >>> DRY RUN — this address is a placeholder from a throwaway keypair. A NEW');
    console.log('  >>> address will be generated and printed when you run with dryRun=false.');
  } else {
    console.log(`  Escrow address (SAVE THIS — needed by every other lock-* action):`);
    console.log(`    ${escrow.toString()}`);
  }
  console.log(`  Base keypair:   ${base.publicKey.toString()}`);
  console.log(`  Recipient:      ${recipient}`);
  console.log('='.repeat(70));

  if (config.dryRun) {
    console.log('\n> Simulating create vesting escrow transaction...');
    await runSimulateTransaction(connection, [wallet.payer, base], wallet.publicKey, [createTx]);
    console.log('> Create vesting escrow simulation successful');
  } else {
    console.log('\n>> Sending create vesting escrow transaction...');
    const txHash = await sendAndConfirmTransaction(connection, createTx, [wallet.payer, base], {
      commitment: connection.commitment,
      maxRetries: DEFAULT_SEND_TX_MAX_RETRIES,
    });
    console.log(`>>> Vesting escrow created successfully with tx hash: ${txHash}`);
    console.log(`>>> Escrow address: ${escrow.toString()}`);
  }
}

/**
 * Attach off-chain metadata (name/description/emails) to an existing vesting escrow. Reads
 * config.lockEscrowMetadata. Signers: [creator=wallet, payer=wallet] per
 * scripts/createVestingEscrowMetadata.s.ts.
 */
export async function createEscrowMetadata(
  config: LockConfig,
  connection: Connection,
  wallet: Wallet,
  escrow: PublicKey
) {
  if (!config.lockEscrowMetadata) {
    throw new Error('Missing lockEscrowMetadata in configuration');
  }
  const { name, description, creatorEmail, recipientEmail } = config.lockEscrowMetadata;

  console.log('\n> Initializing Met Lock escrow metadata...');
  const payerBalance = await connection.getBalance(wallet.publicKey);
  if (payerBalance === 0) {
    throw new Error(
      `Wallet ${wallet.publicKey.toString()} has 0 SOL — fund it first; even dry-run simulation requires an existing fee payer account`
    );
  }

  const client = new LockClient(connection, DEFAULT_COMMITMENT_LEVEL);

  let escrowState;
  try {
    escrowState = await client.getEscrow(escrow);
  } catch (error) {
    throw new Error(
      `No vesting escrow found at ${escrow.toString()}: ${error instanceof Error ? error.message : String(error)}`
    );
  }

  if (!escrowState.creator.equals(wallet.publicKey)) {
    throw new Error(
      `Wallet ${wallet.publicKey.toString()} is not the creator of escrow ${escrow.toString()} (creator is ${escrowState.creator.toString()})`
    );
  }

  console.log(`- Escrow ${escrow.toString()}`);
  console.log(`- Name: ${name}`);
  console.log(`- Description: ${description}`);

  const escrowMetadata = deriveEscrowMetadata(escrow);
  console.log(`- Escrow metadata address: ${escrowMetadata.toString()}`);

  const metadataTx = await client.createVestingEscrowMetadata({
    escrow,
    name,
    description,
    creatorEmail,
    recipientEmail,
    creator: wallet.publicKey,
    payer: wallet.publicKey,
  });

  modifyComputeUnitPriceIx(metadataTx, config.computeUnitPriceMicroLamports ?? 0);

  if (config.dryRun) {
    console.log('\n> Simulating create escrow metadata transaction...');
    await runSimulateTransaction(connection, [wallet.payer], wallet.publicKey, [metadataTx]);
    console.log('> Create escrow metadata simulation successful');
  } else {
    console.log('\n>> Sending create escrow metadata transaction...');
    const txHash = await sendAndConfirmTransaction(connection, metadataTx, [wallet.payer], {
      commitment: connection.commitment,
      maxRetries: DEFAULT_SEND_TX_MAX_RETRIES,
    });
    console.log(`>>> Escrow metadata created successfully with tx hash: ${txHash}`);
  }
}

/**
 * Claim vested tokens from `escrow`. Reads config.lockClaim. Signers: [payer=wallet,
 * recipient=wallet] per scripts/claimV2.s.ts — NOT the docs.md example under
 * "createVestingEscrowMetadata", which actually calls `client.claimV2(...)` with the wrong
 * param shape; the SDK's own script is the correct reference.
 */
export async function claim(
  config: LockConfig,
  connection: Connection,
  wallet: Wallet,
  escrow: PublicKey
) {
  if (!config.lockClaim) {
    throw new Error('Missing lockClaim in configuration');
  }
  if (
    config.lockClaim.maxAmount !== null &&
    config.lockClaim.maxAmount !== undefined &&
    !(config.lockClaim.maxAmount > 0)
  ) {
    throw new Error(`lockClaim.maxAmount must be null or > 0 (got ${config.lockClaim.maxAmount})`);
  }

  console.log('\n> Initializing Met Lock claim...');
  const payerBalance = await connection.getBalance(wallet.publicKey);
  if (payerBalance === 0) {
    throw new Error(
      `Wallet ${wallet.publicKey.toString()} has 0 SOL — fund it first; even dry-run simulation requires an existing fee payer account`
    );
  }

  const client = new LockClient(connection, DEFAULT_COMMITMENT_LEVEL);

  let escrowState;
  try {
    escrowState = await client.getEscrow(escrow);
  } catch (error) {
    throw new Error(
      `No vesting escrow found at ${escrow.toString()}: ${error instanceof Error ? error.message : String(error)}`
    );
  }

  if (!escrowState.recipient.equals(wallet.publicKey)) {
    throw new Error(
      `Wallet ${wallet.publicKey.toString()} is not the recipient of escrow ${escrow.toString()} (recipient is ${escrowState.recipient.toString()})`
    );
  }

  console.log(`- Escrow ${escrow.toString()}`);
  console.log(`- Token mint ${escrowState.tokenMint.toString()}`);

  let maxAmount: BN;
  if (config.lockClaim.maxAmount === null || config.lockClaim.maxAmount === undefined) {
    maxAmount = U64_MAX;
    console.log('- maxAmount omitted -> claiming everything currently vested (u64::MAX cap)');
  } else {
    const tokenProgram = getTokenProgram(escrowState.tokenProgramFlag);
    const mint = await getMint(
      connection,
      escrowState.tokenMint,
      connection.commitment,
      tokenProgram
    );
    maxAmount = getAmountInLamports(config.lockClaim.maxAmount, mint.decimals);
    console.log(
      `- Claiming up to ${config.lockClaim.maxAmount} (${maxAmount.toString()} base units)`
    );
  }

  const claimTx = await client.claimV2({
    escrow,
    recipient: wallet.publicKey,
    maxAmount,
    payer: wallet.publicKey,
  });

  modifyComputeUnitPriceIx(claimTx, config.computeUnitPriceMicroLamports ?? 0);

  if (config.dryRun) {
    console.log('\n> Simulating claim transaction...');
    await runSimulateTransaction(connection, [wallet.payer], wallet.publicKey, [claimTx]);
    console.log('> Claim simulation successful');
  } else {
    console.log('\n>> Sending claim transaction...');
    const txHash = await sendAndConfirmTransaction(connection, claimTx, [wallet.payer], {
      commitment: connection.commitment,
      maxRetries: DEFAULT_SEND_TX_MAX_RETRIES,
    });
    console.log(`>>> Claimed successfully with tx hash: ${txHash}`);
  }
}
