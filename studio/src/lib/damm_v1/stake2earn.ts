import {
  Connection,
  Keypair,
  PublicKey,
  Transaction,
  sendAndConfirmTransaction,
} from '@solana/web3.js';
import { Wallet } from '@coral-xyz/anchor';
import {
  getAccount,
  getAssociatedTokenAddressSync,
  TOKEN_PROGRAM_ID,
  TokenAccountNotFoundError,
  TokenInvalidAccountOwnerError,
} from '@solana/spl-token';
import { DammV1Config, Stake2EarnFarmConfig, LockLiquidityAllocation } from '../../utils/types';
import { DEFAULT_SEND_TX_MAX_RETRIES, STAKE2EARN_PROGRAM_IDS } from '../../utils/constants';
import StakeForFee, { deriveFeeVault, U64_MAX } from '@meteora-ag/m3m3';
import BN from 'bn.js';
import {
  fromAllocationsToAmount,
  getAmountInLamports,
  getAmountInTokens,
  modifyComputeUnitPriceIx,
  runSimulateTransaction,
} from '../../helpers';
import AmmImpl from '@meteora-ag/dynamic-amm-sdk';
import { SEEDS } from '@meteora-ag/dynamic-amm-sdk/dist/cjs/src/amm/constants';
import {
  deriveCustomizablePermissionlessConstantProductPoolAddress,
  createProgram,
  getAssociatedTokenAccount,
} from '@meteora-ag/dynamic-amm-sdk/dist/cjs/src/amm/utils';

/**
 * Create a DammV1 pool with Stake2Earn
 * @param connection - The connection to the cluster
 * @param payer - The payer for the transaction
 * @param poolKey - The key of the pool
 * @param stakeMint
 * @param config
 * @param dryRun
 * @param computeUnitPriceMicroLamports
 * @param opts
 * @returns
 */
export async function createDammV1Stake2EarnPool(
  connection: Connection,
  payer: Keypair,
  poolKey: PublicKey,
  stakeMint: PublicKey,
  config: Stake2EarnFarmConfig,
  dryRun: boolean,
  computeUnitPriceMicroLamports: number,
  opts?: {
    m3m3ProgramId: PublicKey;
  }
): Promise<void> {
  const m3m3ProgramId =
    opts?.m3m3ProgramId ?? new PublicKey(STAKE2EARN_PROGRAM_IDS['mainnet-beta']);
  const m3m3VaultPubkey = deriveFeeVault(poolKey, m3m3ProgramId);
  console.log(`- M3M3 fee vault ${m3m3VaultPubkey}`);

  // Check if the stake2earn vault already exists
  const m3m3VaultAccount = await connection.getAccountInfo(m3m3VaultPubkey, connection.commitment);

  if (m3m3VaultAccount) {
    console.log(`>>> M3M3 farm is already existed. Skip creating new farm.`);
    return;
  }

  console.log(`>> Creating M3M3 fee farm...`);
  const topListLength = config.topListLength;
  const unstakeLockDuration = new BN(config.unstakeLockDurationSecs);
  const secondsToFullUnlock = new BN(config.secondsToFullUnlock);
  const startFeeDistributeTimestamp = new BN(config.startFeeDistributeTimestamp);

  console.log(`- Using topListLength: ${topListLength}`);
  console.log(`- Using unstakeLockDuration ${unstakeLockDuration}`);
  console.log(`- Using secondsToFullUnlock ${secondsToFullUnlock}`);
  console.log(`- Using startFeeDistributeTimestamp ${startFeeDistributeTimestamp}`);

  // stake2earn farm didn't exist
  const createTx = await StakeForFee.createFeeVault(
    connection,
    poolKey,
    stakeMint,
    payer.publicKey,
    {
      topListLength,
      unstakeLockDuration,
      secondsToFullUnlock,
      startFeeDistributeTimestamp,
      padding: [],
    }
  );

  modifyComputeUnitPriceIx(createTx, computeUnitPriceMicroLamports);

  if (dryRun) {
    console.log(`> Simulating create m3m3 farm tx...`);
    await runSimulateTransaction(connection, [payer], payer.publicKey, [createTx]);
  } else {
    console.log(`>> Sending create m3m3 farm transaction...`);
    const txHash = await sendAndConfirmTransaction(connection, createTx, [payer], {
      commitment: connection.commitment,
      maxRetries: DEFAULT_SEND_TX_MAX_RETRIES,
    }).catch((err: any) => {
      console.error(err);
      throw err;
    });
    console.log(`>>> M3M3 farm initialized successfully with tx hash: ${txHash}`);
  }
}

/**
 * Lock liquidity for a DammV1 pool with Stake2Earn
 * @param connection - The connection to the cluster
 * @param payer - The payer for the transaction
 * @param baseMint - The mint for the base token
 * @param quoteMint - The mint for the quote token
 * @param allocations - The allocations for the liquidity
 * @param dryRun - Whether to simulate the transaction
 * @param computeUnitPriceMicroLamports - The compute unit price for the transaction
 * @param opts - The options for the transaction
 * @returns The pool address
 */
export async function lockLiquidityStake2Earn(
  connection: Connection,
  payer: Keypair,
  baseMint: PublicKey,
  quoteMint: PublicKey,
  allocations: LockLiquidityAllocation[],
  dryRun: boolean,
  computeUnitPriceMicroLamports: number,
  opts?: {
    m3m3ProgramId: PublicKey;
  }
): Promise<void> {
  const m3m3ProgramId =
    opts?.m3m3ProgramId ?? new PublicKey(STAKE2EARN_PROGRAM_IDS['mainnet-beta']);

  const poolKey = deriveCustomizablePermissionlessConstantProductPoolAddress(
    baseMint,
    quoteMint,
    createProgram(connection as any).ammProgram.programId
  );
  console.log(`- Pool address: ${poolKey}`);

  const stake2EarnVaultPubkey = deriveFeeVault(poolKey, m3m3ProgramId);
  console.log(`- Stake2Earn fee vault ${stake2EarnVaultPubkey}`);

  if (allocations.length === 0) {
    throw new Error('Missing allocations in lockLiquidity configuration');
  }

  const allocationContainsFeeFarmAddress = allocations.some((allocation) =>
    new PublicKey(allocation.address).equals(stake2EarnVaultPubkey)
  );
  if (!allocationContainsFeeFarmAddress) {
    throw new Error('Lock liquidity allocations does not contain Stake2Earn fee farm address');
  }

  const [lpMint] = PublicKey.findProgramAddressSync(
    [Buffer.from(SEEDS.LP_MINT), poolKey.toBuffer()],
    createProgram(connection as any).ammProgram.programId
  );
  const payerPoolLp = getAssociatedTokenAccount(lpMint, payer.publicKey);
  const payerPoolLpBalance = (
    await connection.getTokenAccountBalance(payerPoolLp, connection.commitment)
  ).value.amount;
  console.log('- payerPoolLpBalance %s', payerPoolLpBalance.toString());

  const allocationByAmounts = fromAllocationsToAmount(new BN(payerPoolLpBalance), allocations);

  const pool = await AmmImpl.create(connection as any, poolKey);

  for (const allocation of allocationByAmounts) {
    console.log('\n> Lock liquidity %s', allocation.address.toString());
    const tx = await pool.lockLiquidity(allocation.address, allocation.amount, payer.publicKey);
    modifyComputeUnitPriceIx(tx as any, computeUnitPriceMicroLamports);

    if (dryRun) {
      console.log(
        `\n> Simulating lock liquidity tx for address ${allocation.address} with amount = ${allocation.amount}... / percentage = ${allocation.percentage}`
      );
      await runSimulateTransaction(connection, [payer], payer.publicKey, [tx as any]);
    } else {
      const txHash = await sendAndConfirmTransaction(connection, tx as any, [payer], {
        commitment: connection.commitment,
        maxRetries: DEFAULT_SEND_TX_MAX_RETRIES,
      }).catch((err) => {
        console.error(err);
        throw err;
      });

      console.log(
        `>>> Lock liquidity successfully with tx hash: ${txHash} for address ${allocation.address} with amount ${allocation.amount}`
      );
    }
  }
}

/**
 * Resolve the M3M3 (Stake2Earn) program id: an explicit override, or the mainnet-beta id,
 * which is also what's deployed on devnet and (per start-test-validator) localhost.
 */
function resolveM3m3ProgramId(opts?: { m3m3ProgramId: PublicKey }): PublicKey {
  return opts?.m3m3ProgramId ?? new PublicKey(STAKE2EARN_PROGRAM_IDS['mainnet-beta']);
}

/**
 * 0-SOL fee-payer guard, matching the alpha_vault/presale_vault precedent — even a dry-run
 * simulation needs an existing fee payer account.
 */
async function assertFunded(connection: Connection, payer: PublicKey): Promise<void> {
  const balance = await connection.getBalance(payer);
  if (balance === 0) {
    throw new Error(
      `Wallet ${payer.toString()} has 0 SOL — fund it first; even dry-run simulation requires an existing fee payer account`
    );
  }
}

/** Shared simulate-or-send tail used by every Stake2Earn user-op below. */
async function simulateOrSend(
  connection: Connection,
  wallet: Wallet,
  dryRun: boolean,
  tx: Transaction,
  label: string,
  extraSigners: Keypair[] = []
): Promise<void> {
  const signers = [wallet.payer, ...extraSigners];
  if (dryRun) {
    console.log(`\n> Simulating ${label} transaction...`);
    await runSimulateTransaction(connection, signers, wallet.publicKey, [tx]);
    console.log(`> ${label} simulation successful`);
  } else {
    console.log(`\n>> Sending ${label} transaction...`);
    const txHash = await sendAndConfirmTransaction(connection, tx, signers, {
      commitment: connection.commitment,
      maxRetries: DEFAULT_SEND_TX_MAX_RETRIES,
    });
    console.log(`>>> ${label} succeeded with tx hash: ${txHash}`);
  }
}

/**
 * Load a StakeForFee instance for `poolAddress`'s Stake2Earn farm, first checking the fee vault
 * account actually exists. StakeForFee.create()/fetchAccountStates() reads `.data` off whatever
 * getMultipleAccountsInfo returns for it with no null guard, so a missing farm would otherwise
 * surface as a raw "Cannot read properties of null" TypeError instead of an actionable message.
 */
async function loadStakeForFee(
  connection: Connection,
  poolAddress: PublicKey,
  m3m3ProgramId: PublicKey
): Promise<StakeForFee> {
  const feeVaultKey = deriveFeeVault(poolAddress, m3m3ProgramId);
  const feeVaultAccount = await connection.getAccountInfo(feeVaultKey, connection.commitment);
  if (!feeVaultAccount) {
    throw new Error(
      `No Stake2Earn farm found for pool ${poolAddress.toString()} (expected fee vault ` +
        `${feeVaultKey.toString()}). Run damm-v1-create-stake2earn-farm first.`
    );
  }
  return StakeForFee.create(connection, poolAddress, { stakeForFeeProgramId: m3m3ProgramId });
}

/**
 * Confirm `owner` holds at least `amountLamports` of the stake mint in its associated token
 * account. Stake2Earn's `stake()` derives the staker's source ATA with no tokenProgram override
 * and hardcodes `tokenProgram: TOKEN_PROGRAM_ID` on the instruction itself (verified against the
 * compiled SDK) — the same classic-Token-Program assumption `farming/index.ts`'s own
 * `assertHoldsAtLeast` makes for its (also DAMM v1 LP) staking mint.
 */
async function assertHoldsAtLeast(
  connection: Connection,
  owner: PublicKey,
  mint: PublicKey,
  amountLamports: BN,
  decimals: number,
  humanAmount: number,
  verb: string
): Promise<void> {
  const ata = getAssociatedTokenAddressSync(mint, owner, true, TOKEN_PROGRAM_ID);
  let balance = new BN(0);
  try {
    const account = await getAccount(connection, ata, connection.commitment);
    balance = new BN(account.amount.toString());
  } catch (error) {
    if (
      !(error instanceof TokenAccountNotFoundError) &&
      !(error instanceof TokenInvalidAccountOwnerError)
    ) {
      throw error;
    }
  }
  if (balance.lt(amountLamports)) {
    throw new Error(
      `Wallet ${owner.toString()} holds ${getAmountInTokens(balance, decimals)} of the stake ` +
        `mint ${mint.toString()} but ${verb} ${humanAmount} needs ` +
        `${getAmountInTokens(amountLamports, decimals)} — fund the wallet's stake-mint token ` +
        'account first.'
    );
  }
}

/**
 * StakeForFee.getUnstakeByUser destructures the first result of an internal
 * stakeEscrow.all(owner, feeVault) memcmp scan with no length check (verified against the
 * compiled SDK) — a wallet with no stake escrow at all on this farm makes it throw a raw
 * TypeError instead of returning an empty list (observed on the installed SDK/Node as "Cannot
 * read properties of undefined (reading 'publicKey')"; older V8 phrasing for the same
 * destructure-of-undefined shape reads "Cannot destructure property 'publicKey' of
 * undefined") — matched below by shape, not by exact wording.
 */
function isEmptyStakeEscrowDestructureBug(error: unknown): boolean {
  return (
    error instanceof TypeError &&
    /publicKey/.test(error.message) &&
    (/destructure/i.test(error.message) || /cannot read propert/i.test(error.message))
  );
}

/**
 * Wraps StakeForFee.getUnstakeByUser so a wallet with no stake escrow at all sees a clean empty
 * array (see isEmptyStakeEscrowDestructureBug above) while any OTHER failure — RPC/network
 * errors included — is rethrown with context instead of being swallowed into a misleading "no
 * pending unstakes", matching the sibling loaders' (loadFarm/loadDynamicVault/loadStakeForFee)
 * precedent of preserving and surfacing the real error.
 */
async function getPendingUnstakes(
  connection: Connection,
  owner: PublicKey,
  feeVaultKey: PublicKey
): ReturnType<typeof StakeForFee.getUnstakeByUser> {
  try {
    return await StakeForFee.getUnstakeByUser(connection, owner, feeVaultKey);
  } catch (error) {
    if (isEmptyStakeEscrowDestructureBug(error)) {
      return [];
    }
    throw new Error(
      `Failed to fetch pending unstake requests for wallet ${owner.toString()} on fee vault ` +
        `${feeVaultKey.toString()}: ${error instanceof Error ? error.message : String(error)}`
    );
  }
}

/**
 * Resolve the unstake account to act on for cancel/withdraw: config.stake2EarnWithdraw.unstakeKey
 * when set, otherwise lists every pending unstake this wallet has open on this farm (via
 * getPendingUnstakes) and tells the caller to set unstakeKey and re-run.
 */
async function resolveUnstakeKey(
  connection: Connection,
  stakeForFee: StakeForFee,
  owner: PublicKey,
  config: DammV1Config,
  decimals: number
): Promise<PublicKey> {
  const unstakeKeyRaw = config.stake2EarnWithdraw?.unstakeKey;
  if (unstakeKeyRaw) {
    return new PublicKey(unstakeKeyRaw);
  }

  const pending = await getPendingUnstakes(connection, owner, stakeForFee.feeVaultKey);
  if (pending.length === 0) {
    throw new Error(
      `No pending unstake requests found for wallet ${owner.toString()} on farm ` +
        `${stakeForFee.feeVaultKey.toString()} — run stake2earn-unstake first.`
    );
  }

  console.log(
    `\n> stake2EarnWithdraw.unstakeKey is not set — wallet ${owner.toString()} has ` +
      `${pending.length} pending unstake request(s):`
  );
  for (const entry of pending) {
    console.log(
      `  - ${entry.publicKey.toString()}: ${getAmountInTokens(entry.account.unstakeAmount, decimals)} ` +
        `(stake-mint units), releases at unix ${entry.account.releaseAt.toString()}`
    );
  }
  throw new Error('Set stake2EarnWithdraw.unstakeKey to one of the addresses above and re-run.');
}

/**
 * Stake into a DAMM v1 pool's Stake2Earn farm. Reads config.stake2EarnStake.amount (stake-mint
 * human units, converted via the mint's own decimals from accountStates.stakeMint). The SDK's
 * own stake() method already creates the caller's stake escrow inline (a prepended
 * initializeStakeEscrow instruction via getOrCreateStakeEscrowInstruction) when one doesn't
 * exist yet — verified against the compiled SDK and the SDK repo's own examples/index.ts — so
 * no separate escrow-check/create step or extra transaction is needed here.
 */
export async function stake(
  config: DammV1Config,
  connection: Connection,
  wallet: Wallet,
  poolAddress: PublicKey,
  opts?: { m3m3ProgramId: PublicKey }
): Promise<void> {
  if (!config.stake2EarnStake) {
    throw new Error('Missing stake2EarnStake in configuration');
  }
  const { amount } = config.stake2EarnStake;
  if (!(amount > 0)) {
    throw new Error(`stake2EarnStake.amount must be > 0 (got ${amount})`);
  }

  console.log('\n> Initializing Stake2Earn stake...');
  await assertFunded(connection, wallet.publicKey);

  const m3m3ProgramId = resolveM3m3ProgramId(opts);
  const stakeForFee = await loadStakeForFee(connection, poolAddress, m3m3ProgramId);
  const decimals = stakeForFee.accountStates.stakeMint.decimals;

  console.log(`- Pool ${poolAddress.toString()}`);
  console.log(`- Fee vault ${stakeForFee.feeVaultKey.toString()}`);
  console.log(`- Stake mint ${stakeForFee.accountStates.feeVault.stakeMint.toString()}`);

  const balanceBefore = await stakeForFee.getUserStakeAndClaimBalance(wallet.publicKey);
  if (balanceBefore.stakeEscrow) {
    console.log(
      `- Existing staked amount: ${getAmountInTokens(balanceBefore.stakeEscrow.stakeAmount, decimals)}`
    );
  } else {
    console.log(
      '- No existing stake escrow for this wallet — one will be created by this transaction.'
    );
  }

  const amountLamports = getAmountInLamports(amount, decimals);
  await assertHoldsAtLeast(
    connection,
    wallet.publicKey,
    stakeForFee.accountStates.feeVault.stakeMint,
    amountLamports,
    decimals,
    amount,
    'staking'
  );
  console.log(`- Staking up to ${amount} (${amountLamports.toString()} base units)`);

  const stakeTx = await stakeForFee.stake(amountLamports, wallet.publicKey);
  modifyComputeUnitPriceIx(stakeTx, config.computeUnitPriceMicroLamports ?? 0);

  await simulateOrSend(connection, wallet, config.dryRun, stakeTx, 'stake');
}

/**
 * Claim accrued trading fees from a Stake2Earn stake escrow. Reads config.stake2EarnClaim.maxFee
 * (null = claim everything pending, sent as the SDK's exported U64_MAX). Prints
 * unclaimFee.feeA/feeB (in tokenA/tokenB decimals respectively — they can differ) before
 * claiming, and refuses clearly when both are zero instead of sending a no-op transaction.
 */
export async function claimFee(
  config: DammV1Config,
  connection: Connection,
  wallet: Wallet,
  poolAddress: PublicKey,
  opts?: { m3m3ProgramId: PublicKey }
): Promise<void> {
  if (!config.stake2EarnClaim) {
    throw new Error('Missing stake2EarnClaim in configuration');
  }
  const maxFeeRaw = config.stake2EarnClaim.maxFee;
  if (maxFeeRaw !== null && maxFeeRaw !== undefined && !(Number(maxFeeRaw) > 0)) {
    throw new Error(`stake2EarnClaim.maxFee must be null or > 0 (got ${maxFeeRaw})`);
  }

  console.log('\n> Initializing Stake2Earn claim-fee...');
  await assertFunded(connection, wallet.publicKey);

  const m3m3ProgramId = resolveM3m3ProgramId(opts);
  const stakeForFee = await loadStakeForFee(connection, poolAddress, m3m3ProgramId);

  console.log(`- Pool ${poolAddress.toString()}`);
  console.log(`- Fee vault ${stakeForFee.feeVaultKey.toString()}`);

  const balance = await stakeForFee.getUserStakeAndClaimBalance(wallet.publicKey);
  if (!balance.stakeEscrow) {
    throw new Error(
      `No stake escrow found for wallet ${wallet.publicKey.toString()} on farm ` +
        `${stakeForFee.feeVaultKey.toString()} — stake first with stake2earn-stake.`
    );
  }

  const feeADecimals = stakeForFee.accountStates.tokenAMint.decimals;
  const feeBDecimals = stakeForFee.accountStates.tokenBMint.decimals;
  console.log(`- Pending fee A: ${getAmountInTokens(balance.unclaimFee.feeA, feeADecimals)}`);
  console.log(`- Pending fee B: ${getAmountInTokens(balance.unclaimFee.feeB, feeBDecimals)}`);

  if (balance.unclaimFee.feeA.lten(0) && balance.unclaimFee.feeB.lten(0)) {
    throw new Error(
      `Nothing to claim yet for wallet ${wallet.publicKey.toString()} on farm ` +
        `${stakeForFee.feeVaultKey.toString()}.`
    );
  }

  let maxFee: BN;
  if (maxFeeRaw === null || maxFeeRaw === undefined) {
    maxFee = U64_MAX;
    console.log('- maxFee omitted -> claiming everything pending (u64::MAX cap)');
  } else {
    maxFee = new BN(maxFeeRaw.toString());
    console.log(
      `- maxFee capped at ${maxFee.toString()} raw base units (applies to both feeA and feeB)`
    );
  }

  const claimTx = await stakeForFee.claimFee(wallet.publicKey, maxFee);
  modifyComputeUnitPriceIx(claimTx, config.computeUnitPriceMicroLamports ?? 0);

  await simulateOrSend(connection, wallet, config.dryRun, claimTx, 'claim-fee');
}

/**
 * Request to unstake from a Stake2Earn farm. Reads config.stake2EarnUnstake.amount (stake-mint
 * human units, must not exceed the current staked amount). Generates a FRESH `unstake` keypair
 * that co-signs this transaction — its public key is the handle every later
 * stake2earn-cancel-unstake / stake2earn-withdraw call needs (via
 * config.stake2EarnWithdraw.unstakeKey), so it is logged prominently below. Tokens stay locked
 * for the farm's unstakeLockDuration (see stake2earn-get-status) before stake2earn-withdraw can
 * release them.
 */
export async function unstakeStart(
  config: DammV1Config,
  connection: Connection,
  wallet: Wallet,
  poolAddress: PublicKey,
  opts?: { m3m3ProgramId: PublicKey }
): Promise<void> {
  if (!config.stake2EarnUnstake) {
    throw new Error('Missing stake2EarnUnstake in configuration');
  }
  const { amount } = config.stake2EarnUnstake;
  if (!(amount > 0)) {
    throw new Error(`stake2EarnUnstake.amount must be > 0 (got ${amount})`);
  }

  console.log('\n> Initializing Stake2Earn unstake request...');
  await assertFunded(connection, wallet.publicKey);

  const m3m3ProgramId = resolveM3m3ProgramId(opts);
  const stakeForFee = await loadStakeForFee(connection, poolAddress, m3m3ProgramId);
  const decimals = stakeForFee.accountStates.stakeMint.decimals;

  console.log(`- Pool ${poolAddress.toString()}`);
  console.log(`- Fee vault ${stakeForFee.feeVaultKey.toString()}`);

  const balance = await stakeForFee.getUserStakeAndClaimBalance(wallet.publicKey);
  if (!balance.stakeEscrow) {
    throw new Error(
      `No stake escrow found for wallet ${wallet.publicKey.toString()} on farm ` +
        `${stakeForFee.feeVaultKey.toString()} — stake first with stake2earn-stake.`
    );
  }
  console.log(
    `- Currently staked: ${getAmountInTokens(balance.stakeEscrow.stakeAmount, decimals)}`
  );

  const amountLamports = getAmountInLamports(amount, decimals);
  if (amountLamports.gt(balance.stakeEscrow.stakeAmount)) {
    throw new Error(
      `Requested unstake ${amount} exceeds the current staked amount of ` +
        `${getAmountInTokens(balance.stakeEscrow.stakeAmount, decimals)}.`
    );
  }
  console.log(`- Requesting unstake of ${amount} (${amountLamports.toString()} base units)`);

  const unstakeKeypair = Keypair.generate();
  const unstakeTx = await stakeForFee.unstake(
    amountLamports,
    unstakeKeypair.publicKey,
    wallet.publicKey
  );
  modifyComputeUnitPriceIx(unstakeTx, config.computeUnitPriceMicroLamports ?? 0);

  const unlockDurationSecs =
    stakeForFee.accountStates.feeVault.configuration.unstakeLockDuration.toString();

  console.log('\n' + '='.repeat(70));
  console.log(
    config.dryRun ? '  STAKE2EARN — UNSTAKE REQUEST (DRY RUN)' : '  STAKE2EARN — UNSTAKE REQUEST'
  );
  console.log('='.repeat(70));
  if (config.dryRun) {
    console.log('  Unstake account (THROWAWAY — dry run only, do NOT save):');
    console.log(`    ${unstakeKeypair.publicKey.toString()}`);
    console.log('  >>> DRY RUN — this address is a placeholder from a throwaway keypair. A NEW');
    console.log('  >>> address will be generated and printed when you run with dryRun=false.');
  } else {
    console.log('  Unstake account (SAVE THIS — needed by stake2earn-cancel-unstake and');
    console.log('  stake2earn-withdraw, via config.stake2EarnWithdraw.unstakeKey):');
    console.log(`    ${unstakeKeypair.publicKey.toString()}`);
  }
  console.log(`  Amount:                     ${amount} (${amountLamports.toString()} base units)`);
  console.log(`  Farm's unstakeLockDuration: ${unlockDurationSecs} seconds from now`);
  console.log('='.repeat(70));

  await simulateOrSend(connection, wallet, config.dryRun, unstakeTx, 'unstake-request', [
    unstakeKeypair,
  ]);

  if (!config.dryRun) {
    console.log(`>>> Unstake account: ${unstakeKeypair.publicKey.toString()}`);
  }
}

/**
 * Cancel a pending unstake request, restoring its tokens to the stake escrow. Reads
 * config.stake2EarnWithdraw.unstakeKey (falls back to listing this wallet's open unstake
 * requests when unset — see resolveUnstakeKey).
 */
export async function cancelUnstake(
  config: DammV1Config,
  connection: Connection,
  wallet: Wallet,
  poolAddress: PublicKey,
  opts?: { m3m3ProgramId: PublicKey }
): Promise<void> {
  console.log('\n> Initializing Stake2Earn cancel-unstake...');
  await assertFunded(connection, wallet.publicKey);

  const m3m3ProgramId = resolveM3m3ProgramId(opts);
  const stakeForFee = await loadStakeForFee(connection, poolAddress, m3m3ProgramId);
  const decimals = stakeForFee.accountStates.stakeMint.decimals;

  const unstakeKey = await resolveUnstakeKey(
    connection,
    stakeForFee,
    wallet.publicKey,
    config,
    decimals
  );
  console.log(`- Unstake account ${unstakeKey.toString()}`);

  const unstakeAccount = await stakeForFee.stakeForFeeProgram.account.unstake.fetch(unstakeKey);
  if (!unstakeAccount.owner.equals(wallet.publicKey)) {
    throw new Error(
      `Wallet ${wallet.publicKey.toString()} is not the owner of unstake account ` +
        `${unstakeKey.toString()} (owner is ${unstakeAccount.owner.toString()}).`
    );
  }
  console.log(`- Unstake amount: ${getAmountInTokens(unstakeAccount.unstakeAmount, decimals)}`);

  const cancelTx = await stakeForFee.cancelUnstake(unstakeKey, wallet.publicKey);
  modifyComputeUnitPriceIx(cancelTx, config.computeUnitPriceMicroLamports ?? 0);

  await simulateOrSend(connection, wallet, config.dryRun, cancelTx, 'cancel-unstake');
}

/**
 * Withdraw a released unstake request back to the wallet. Reads
 * config.stake2EarnWithdraw.unstakeKey (falls back to listing this wallet's open unstake
 * requests when unset — see resolveUnstakeKey). Pre-checks the farm's own on-chain clock
 * snapshot against the unstake's releaseAt — the SDK's withdraw() builds the transaction
 * regardless and only the on-chain program enforces the lock, so this exists purely to fail
 * with a clear "still locked" message instead of a program revert.
 */
export async function withdrawUnstake(
  config: DammV1Config,
  connection: Connection,
  wallet: Wallet,
  poolAddress: PublicKey,
  opts?: { m3m3ProgramId: PublicKey }
): Promise<void> {
  console.log('\n> Initializing Stake2Earn withdraw...');
  await assertFunded(connection, wallet.publicKey);

  const m3m3ProgramId = resolveM3m3ProgramId(opts);
  const stakeForFee = await loadStakeForFee(connection, poolAddress, m3m3ProgramId);
  const decimals = stakeForFee.accountStates.stakeMint.decimals;

  const unstakeKey = await resolveUnstakeKey(
    connection,
    stakeForFee,
    wallet.publicKey,
    config,
    decimals
  );
  console.log(`- Unstake account ${unstakeKey.toString()}`);

  const unstakeAccount = await stakeForFee.stakeForFeeProgram.account.unstake.fetch(unstakeKey);
  if (!unstakeAccount.owner.equals(wallet.publicKey)) {
    throw new Error(
      `Wallet ${wallet.publicKey.toString()} is not the owner of unstake account ` +
        `${unstakeKey.toString()} (owner is ${unstakeAccount.owner.toString()}).`
    );
  }

  const nowSec = stakeForFee.accountStates.clock.unixTimestamp;
  console.log(`- Unstake amount: ${getAmountInTokens(unstakeAccount.unstakeAmount, decimals)}`);
  console.log(
    `- Releases at unix ${unstakeAccount.releaseAt.toString()} (on-chain clock now: ${nowSec.toString()})`
  );
  if (nowSec.lt(unstakeAccount.releaseAt)) {
    throw new Error(
      `Unstake ${unstakeKey.toString()} is still locked for ~${unstakeAccount.releaseAt.sub(nowSec).toString()} ` +
        `more seconds (releases at unix ${unstakeAccount.releaseAt.toString()}) — the farm's ` +
        'unstakeLockDuration has not elapsed yet.'
    );
  }

  const withdrawTx = await stakeForFee.withdraw(unstakeKey, wallet.publicKey);
  modifyComputeUnitPriceIx(withdrawTx, config.computeUnitPriceMicroLamports ?? 0);

  await simulateOrSend(connection, wallet, config.dryRun, withdrawTx, 'withdraw');
}

/**
 * Print the status of a DAMM v1 Stake2Earn farm (read-only): whether the farm exists yet, the
 * top-staker list size and entry threshold (getTopStakerListEntryStakeAmount), and — with a
 * wallet — that wallet's stakeAmount/inTopList/pending fees plus any open unstake requests
 * (via the SDK's static getUnstakeByUser).
 */
export async function getStatus(
  connection: Connection,
  poolAddress: PublicKey,
  walletPubkey?: PublicKey,
  opts?: { m3m3ProgramId: PublicKey }
): Promise<void> {
  const m3m3ProgramId = resolveM3m3ProgramId(opts);
  const feeVaultKey = deriveFeeVault(poolAddress, m3m3ProgramId);

  console.log(`\n> Pool:      ${poolAddress.toString()}`);
  console.log(`> Fee vault: ${feeVaultKey.toString()}`);

  const feeVaultAccount = await connection.getAccountInfo(feeVaultKey, connection.commitment);
  if (!feeVaultAccount) {
    console.log(
      '> No Stake2Earn farm exists for this pool yet — run damm-v1-create-stake2earn-farm first.'
    );
    return;
  }

  const stakeForFee = await StakeForFee.create(connection, poolAddress, {
    stakeForFeeProgramId: m3m3ProgramId,
  });
  const decimals = stakeForFee.accountStates.stakeMint.decimals;
  const feeVault = stakeForFee.accountStates.feeVault;

  console.log(`> Stake mint:               ${feeVault.stakeMint.toString()}`);
  console.log(`> Quote mint:               ${feeVault.quoteMint.toString()}`);
  console.log(
    `> Total staked:             ${getAmountInTokens(feeVault.metrics.totalStakedAmount, decimals)}`
  );
  console.log(`> Total stake escrows:      ${feeVault.metrics.totalStakeEscrowCount.toString()}`);
  console.log(
    `> Top-staker list:          ${feeVault.topStakerInfo.currentLength.toString()} / ${feeVault.topStakerInfo.topListLength.toString()}`
  );
  console.log(
    `> Top-list entry threshold: ${getAmountInTokens(stakeForFee.getTopStakerListEntryStakeAmount(), decimals)}`
  );
  console.log(
    `> Unstake lock duration:    ${feeVault.configuration.unstakeLockDuration.toString()} seconds`
  );
  console.log(
    `> Seconds to full unlock:   ${feeVault.configuration.secondsToFullUnlock.toString()} seconds`
  );

  if (!walletPubkey) {
    return;
  }

  console.log(`\n> Wallet: ${walletPubkey.toString()}`);
  const balance = await stakeForFee.getUserStakeAndClaimBalance(walletPubkey);
  if (!balance.stakeEscrow) {
    console.log('> No stake escrow found for this wallet on this farm (it has not staked yet).');
  } else {
    console.log(
      `> Staked amount:           ${getAmountInTokens(balance.stakeEscrow.stakeAmount, decimals)}`
    );
    console.log(`> In top list:             ${Boolean(balance.stakeEscrow.inTopList)}`);
    console.log(
      `> Ongoing partial unstake: ${getAmountInTokens(balance.stakeEscrow.ongoingTotalPartialUnstakeAmount, decimals)}`
    );
    console.log(
      `> Pending fee A:           ${getAmountInTokens(balance.unclaimFee.feeA, stakeForFee.accountStates.tokenAMint.decimals)}`
    );
    console.log(
      `> Pending fee B:           ${getAmountInTokens(balance.unclaimFee.feeB, stakeForFee.accountStates.tokenBMint.decimals)}`
    );
  }

  const pendingUnstakes = await getPendingUnstakes(connection, walletPubkey, feeVaultKey);
  console.log(`\n> Open unstake requests (${pendingUnstakes.length}):`);
  for (const entry of pendingUnstakes) {
    console.log(
      `  - ${entry.publicKey.toString()}: ${getAmountInTokens(entry.account.unstakeAmount, decimals)} ` +
        `(stake-mint units), releases at unix ${entry.account.releaseAt.toString()}`
    );
  }
}
