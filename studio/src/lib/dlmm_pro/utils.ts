import {
  DLMM_PRO_PROGRAM_ID,
  DlmmProClient,
  MAX_BASIS_POINT,
  PoolErrorCode,
  PoolExtension,
  decodeLimitOrderDataFromData,
  decodePositionsFromData,
  deriveLimitOrder,
  derivePosition,
  isSupportExtension,
  type DecodedLimitOrderData,
  type DecodedPoolExtensions,
  type DecodedPosition,
  type DecodedPositionWithReward,
  type LimitOrder,
  type Pool,
  type PositionArray,
  type PositionVesting,
} from '@meteora-ag/dlmm-pro-sdk';
import { Mint, TOKEN_2022_PROGRAM_ID, unpackMint } from '@solana/spl-token';
import {
  ComputeBudgetProgram,
  Connection,
  Keypair,
  PublicKey,
  sendAndConfirmTransaction,
  Transaction,
  TransactionError,
  TransactionInstruction,
} from '@solana/web3.js';
import BN from 'bn.js';
import Decimal from 'decimal.js';
import { DEFAULT_SEND_TX_MAX_RETRIES, TX_SIZE_LIMIT_BYTES } from '../../utils/constants';
import { DlmmProConfig } from '../../utils/types';

// A Q64.64 sqrt price has up to 29 digits, more than decimal.js keeps by default.
const PreciseDecimal = Decimal.clone({ precision: 64 });
const SQRT_PRICE_SCALE = new PreciseDecimal(2).pow(64);
const TICK_BASE = new PreciseDecimal('1.0001');
const LN_TICK_BASE = TICK_BASE.ln();
// Prices are printed with PRICE_DIGITS significant digits, so a price pasted back from the
// output can sit just off the tick it came from. A price this close to a tick, in ticks,
// counts as on it.
const TICK_TOLERANCE = '0.0001';
const PRICE_DIGITS = 10;

const MAX_COMPUTE_UNITS = 1_400_000;
const COMPUTE_UNIT_HEADROOM = 1.2;
const SIGNATURE_SIZE = 64;
const PUBLIC_KEY_SIZE = 32;
const BLOCKHASH_SIZE = 32;
const MESSAGE_HEADER_SIZE = 3;
const MAX_ACCOUNTS_PER_REQUEST = 100;

// What converts between a price in whole tokens and the pool's ticks.
export interface PriceGrid {
  decimalsX: number;
  decimalsY: number;
  tickSpacing: number;
}

export interface PoolContext {
  address: PublicKey;
  state: Pool;
  extensions: DecodedPoolExtensions;
  mintX: Mint;
  mintY: Mint;
  grid: PriceGrid;
  // Positions and ticks of a liquidity mining pool carry reward data, which changes how they decode.
  withReward: boolean;
}

export interface PositionAccount {
  nftMint: PublicKey;
  address: PublicKey;
  layoutVersion: number;
  vesting: PositionVesting;
  slots: DecodedPosition[] | DecodedPositionWithReward[];
}

export interface LimitOrderAccount {
  nftMint: PublicKey;
  address: PublicKey;
  ticks: DecodedLimitOrderData[];
}

export interface TransactionStep {
  label: string;
  tx: Transaction;
  signers: Keypair[];
  // The step reads state an earlier step writes, so a simulation of it alone would fail.
  dependsOnPriorStep?: boolean;
}

export async function fetchMint(connection: Connection, address: PublicKey): Promise<Mint> {
  const info = await connection.getAccountInfo(address, connection.commitment);
  if (!info) {
    throw new Error(`Mint account not found: ${address.toString()}`);
  }
  return unpackMint(address, info, info.owner);
}

export async function loadPool(client: DlmmProClient, address: PublicKey): Promise<PoolContext> {
  const { pool: state, extensions } = await client.state.fetchPoolWithExtensions(address);
  const [mintX, mintY] = await Promise.all([
    fetchMint(client.connection, state.tokenXMint),
    fetchMint(client.connection, state.tokenYMint),
  ]);
  return {
    address,
    state,
    extensions,
    mintX,
    mintY,
    grid: {
      decimalsX: mintX.decimals,
      decimalsY: mintY.decimals,
      tickSpacing: state.tickSpacing,
    },
    withReward: isSupportExtension(state.extensions, PoolExtension.LiquidityMining),
  };
}

/**
 * The tick a price in whole token Y per whole token X falls on, as a fraction. Tick `i` has
 * price 1.0001^i in atoms of Y per atom of X, so the price is scaled by the difference in
 * decimals first.
 */
function fractionalTick(grid: PriceGrid, price: number | string): Decimal {
  const atomPrice = new PreciseDecimal(price).mul(
    new PreciseDecimal(10).pow(grid.decimalsY - grid.decimalsX)
  );
  if (!atomPrice.isFinite() || atomPrice.lte(0)) {
    throw new Error(`Price must be a positive number, got ${price}`);
  }
  return atomPrice.ln().div(LN_TICK_BASE);
}

/** The highest usable tick whose price is at or below `price`. */
export function usableTickAtOrBelowPrice(grid: PriceGrid, price: number | string): number {
  const tick = fractionalTick(grid, price).plus(TICK_TOLERANCE);
  return tick.div(grid.tickSpacing).floor().toNumber() * grid.tickSpacing;
}

/** The lowest usable tick whose price is at or above `price`. */
export function usableTickAtOrAbovePrice(grid: PriceGrid, price: number | string): number {
  const tick = fractionalTick(grid, price).minus(TICK_TOLERANCE);
  return tick.div(grid.tickSpacing).ceil().toNumber() * grid.tickSpacing;
}

export function formatTickPrice(grid: PriceGrid, tickId: number): string {
  return TICK_BASE.pow(tickId)
    .mul(new PreciseDecimal(10).pow(grid.decimalsX - grid.decimalsY))
    .toSignificantDigits(PRICE_DIGITS)
    .toString();
}

export function formatSqrtPrice(grid: PriceGrid, sqrtPrice: BN): string {
  return new PreciseDecimal(sqrtPrice.toString())
    .div(SQRT_PRICE_SCALE)
    .pow(2)
    .mul(new PreciseDecimal(10).pow(grid.decimalsX - grid.decimalsY))
    .toSignificantDigits(PRICE_DIGITS)
    .toString();
}

/**
 * A range's unlocked liquidity once the program has released what has vested by
 * `currentPoint`, which it does at the start of every withdrawal.
 */
export function unlockedLiquidityAt(
  vesting: PositionVesting,
  slot: DecodedPosition,
  currentPoint: BN
): BN {
  if (vesting.initialize !== 1 || currentPoint.lt(vesting.cliffPoint)) {
    return slot.unlockedLiquidity;
  }
  let vestedBps = new BN(vesting.cliffUnlockBps);
  if (!vesting.periodFrequency.isZero() && vesting.bpsPerPeriod !== 0) {
    const periods = currentPoint.sub(vesting.cliffPoint).div(vesting.periodFrequency);
    vestedBps = periods.gten(vesting.numberOfPeriod)
      ? new BN(MAX_BASIS_POINT)
      : vestedBps.add(periods.muln(vesting.bpsPerPeriod));
  }
  const vested = slot.vestingLiquidity
    .add(slot.releasedVestingLiquidity)
    .mul(vestedBps)
    .divn(MAX_BASIS_POINT);
  return slot.unlockedLiquidity.add(vested).sub(slot.releasedVestingLiquidity);
}

export function assertBps(field: string, value: number, min: number): void {
  if (!Number.isInteger(value) || value < min || value > 10_000) {
    throw new Error(`${field} must be an integer from ${min} to 10000, got ${value}`);
  }
}

// A canceled tick stays in the order with a zero amount and a zero age.
export function isOpenLimitOrderTick(tick: DecodedLimitOrderData): boolean {
  return !tick.amount.isZero() || !tick.age.isZero();
}

/**
 * Position and limit order NFTs are Token 2022 mints with 0 decimals and a supply of 1, so the
 * wallet's candidates are its Token 2022 accounts holding exactly 1 token of such a mint.
 */
async function getNftMints(connection: Connection, owner: PublicKey): Promise<PublicKey[]> {
  const { value: tokenAccounts } = await connection.getParsedTokenAccountsByOwner(owner, {
    programId: TOKEN_2022_PROGRAM_ID,
  });
  return tokenAccounts
    .map(({ account }) => account.data.parsed.info)
    .filter((info) => info.tokenAmount.decimals === 0 && info.tokenAmount.amount === '1')
    .map((info) => new PublicKey(info.mint));
}

/** Account data per address, or null where the account is missing or not owned by DLMM Pro. */
async function getProgramAccountData(
  client: DlmmProClient,
  addresses: PublicKey[]
): Promise<(Buffer | null)[]> {
  const data: (Buffer | null)[] = [];
  for (let i = 0; i < addresses.length; i += MAX_ACCOUNTS_PER_REQUEST) {
    const infos = await client.connection.getMultipleAccountsInfo(
      addresses.slice(i, i + MAX_ACCOUNTS_PER_REQUEST),
      client.commitment
    );
    data.push(...infos.map((info) => (info?.owner.equals(DLMM_PRO_PROGRAM_ID) ? info.data : null)));
  }
  return data;
}

function decodePositionHeader(client: DlmmProClient, data: Buffer): PositionArray {
  return client.program.coder.accounts.decode<PositionArray>('positionArray', data);
}

/**
 * Decodes the ranges of a position that belongs to `pool`. Their layout depends on the pool's
 * liquidity mining extension, so a position of another pool must not be decoded with it.
 */
function decodePosition(
  pool: PoolContext,
  nftMint: PublicKey,
  header: PositionArray,
  data: Buffer
): PositionAccount {
  return {
    nftMint,
    address: derivePosition(nftMint),
    layoutVersion: header.layoutVersion,
    vesting: header.vesting,
    slots: decodePositionsFromData(data, pool.withReward),
  };
}

export async function findPositions(
  client: DlmmProClient,
  pool: PoolContext,
  owner: PublicKey
): Promise<PositionAccount[]> {
  const nftMints = await getNftMints(client.connection, owner);
  const accounts = await getProgramAccountData(
    client,
    nftMints.map((mint) => derivePosition(mint))
  );
  return nftMints.flatMap((nftMint, index) => {
    const data = accounts[index];
    if (!data) {
      return [];
    }
    const header = decodePositionHeader(client, data);
    return header.pool.equals(pool.address) ? [decodePosition(pool, nftMint, header, data)] : [];
  });
}

/**
 * The position `nftMint` names, or the wallet's only position on the pool when it is null.
 */
export async function resolvePosition(
  client: DlmmProClient,
  pool: PoolContext,
  owner: PublicKey,
  nftMint: PublicKey | null
): Promise<PositionAccount> {
  if (nftMint) {
    const [data] = await getProgramAccountData(client, [derivePosition(nftMint)]);
    if (!data) {
      throw new Error(
        `No DLMM Pro position exists for NFT mint ${nftMint.toString()}. Pass the position's NFT mint, as printed by dlmm-pro-get-positions.`
      );
    }
    const header = decodePositionHeader(client, data);
    if (!header.pool.equals(pool.address)) {
      throw new Error(
        `Position ${nftMint.toString()} belongs to pool ${header.pool.toString()}, not ${pool.address.toString()}`
      );
    }
    return decodePosition(pool, nftMint, header, data);
  }

  const [position, ...others] = await findPositions(client, pool, owner);
  if (!position) {
    throw new Error(
      `No positions found on pool ${pool.address.toString()} for wallet ${owner.toString()}`
    );
  }
  if (others.length > 0) {
    const nftMints = [position, ...others].map((entry) => `  ${entry.nftMint.toString()}`);
    throw new Error(
      `Wallet ${owner.toString()} has ${nftMints.length} positions on this pool. Pass --position <NFT_MINT> to choose one:\n${nftMints.join('\n')}`
    );
  }
  return position;
}

function decodeLimitOrder(
  client: DlmmProClient,
  nftMint: PublicKey,
  data: Buffer
): LimitOrderAccount & { pool: PublicKey } {
  const header = client.program.coder.accounts.decode<LimitOrder>('limitOrder', data);
  return {
    nftMint,
    address: deriveLimitOrder(nftMint),
    pool: header.pool,
    ticks: decodeLimitOrderDataFromData(data),
  };
}

export async function findLimitOrders(
  client: DlmmProClient,
  poolAddress: PublicKey,
  owner: PublicKey
): Promise<LimitOrderAccount[]> {
  const nftMints = await getNftMints(client.connection, owner);
  const accounts = await getProgramAccountData(
    client,
    nftMints.map((mint) => deriveLimitOrder(mint))
  );
  return nftMints.flatMap((nftMint, index) => {
    const data = accounts[index];
    if (!data) {
      return [];
    }
    const order = decodeLimitOrder(client, nftMint, data);
    return order.pool.equals(poolAddress) ? [order] : [];
  });
}

export async function resolveLimitOrder(
  client: DlmmProClient,
  poolAddress: PublicKey,
  nftMint: PublicKey
): Promise<LimitOrderAccount> {
  const [data] = await getProgramAccountData(client, [deriveLimitOrder(nftMint)]);
  if (!data) {
    throw new Error(
      `No DLMM Pro limit order exists for NFT mint ${nftMint.toString()}. Pass the order's NFT mint, as printed by dlmm-pro-get-limit-orders.`
    );
  }
  const order = decodeLimitOrder(client, nftMint, data);
  if (!order.pool.equals(poolAddress)) {
    throw new Error(
      `Limit order ${nftMint.toString()} belongs to pool ${order.pool.toString()}, not ${poolAddress.toString()}`
    );
  }
  return order;
}

function withComputeBudget(tx: Transaction, units: number, microLamports: number): Transaction {
  const budgeted = new Transaction().add(
    ComputeBudgetProgram.setComputeUnitLimit({ units }),
    ComputeBudgetProgram.setComputeUnitPrice({ microLamports }),
    ...tx.instructions
  );
  budgeted.feePayer = tx.feePayer;
  return budgeted;
}

/** Bytes of the compact-u16 that prefixes an array of `length` items. */
function compactLengthSize(length: number): number {
  if (length < 0x80) return 1;
  return length < 0x4000 ? 2 : 3;
}

/**
 * Size of the signed transaction on the wire. Counted from the compiled message, because
 * `Message.serialize()` throws once the instructions outgrow a packet instead of reporting a
 * size over the limit.
 */
function transactionSize(tx: Transaction, microLamports: number): number {
  const probe = withComputeBudget(tx, MAX_COMPUTE_UNITS, microLamports);
  // The size does not depend on the blockhash, so any 32 bytes stand in for it.
  probe.recentBlockhash = PublicKey.default.toString();
  const message = probe.compileMessage();

  const signatureCount = message.header.numRequiredSignatures;
  const signatures = compactLengthSize(signatureCount) + signatureCount * SIGNATURE_SIZE;
  const accountKeys =
    compactLengthSize(message.accountKeys.length) + message.accountKeys.length * PUBLIC_KEY_SIZE;
  const instructions = message.compiledInstructions.reduce(
    (size, instruction) =>
      size +
      1 + // program id index
      compactLengthSize(instruction.accountKeyIndexes.length) +
      instruction.accountKeyIndexes.length +
      compactLengthSize(instruction.data.length) +
      instruction.data.length,
    compactLengthSize(message.compiledInstructions.length)
  );
  return signatures + MESSAGE_HEADER_SIZE + accountKeys + BLOCKHASH_SIZE + instructions;
}

function assertFitsInOneTransaction(tx: Transaction, microLamports: number, label: string): void {
  const size = transactionSize(tx, microLamports);
  if (size > TX_SIZE_LIMIT_BYTES) {
    throw new Error(
      `The ${label} transaction is ${size} bytes, over the ${TX_SIZE_LIMIT_BYTES} byte limit. Use fewer ranges or ticks, or a narrower price range, so that it touches fewer tick arrays.`
    );
  }
}

function describeSimulationError(
  instructions: TransactionInstruction[],
  err: TransactionError
): string {
  if (err === 'AccountNotFound') {
    return 'the fee payer account does not exist. Fund the wallet with SOL first, a dry run needs it too.';
  }
  if (typeof err === 'object' && 'InstructionError' in err) {
    const [index, detail] = err.InstructionError as [number, unknown];
    const code =
      typeof detail === 'object' && detail !== null && 'Custom' in detail ? detail.Custom : null;
    if (
      typeof code === 'number' &&
      PoolErrorCode[code] !== undefined &&
      instructions[index]?.programId.equals(DLMM_PRO_PROGRAM_ID)
    ) {
      return `DLMM Pro error ${code} (${PoolErrorCode[code]})`;
    }
  }
  return JSON.stringify(err);
}

/**
 * Simulates the transaction, then sends it unless `dryRun` is set. DLMM Pro builders add no
 * compute budget instructions, so the compute unit limit is sized from the simulation.
 * @returns The transaction signature, or null on a dry run
 */
export async function executeTransaction(
  connection: Connection,
  config: DlmmProConfig,
  tx: Transaction,
  signers: Keypair[],
  label: string
): Promise<string | null> {
  const microLamports = config.computeUnitPriceMicroLamports ?? 0;
  assertFitsInOneTransaction(tx, microLamports, label);

  console.log(`\n> Simulating ${label} tx...`);
  // Simulated at a zero price. A price on the maximum limit would make the fee payer cover a
  // priority fee several times what the sized transaction pays.
  const simulated = withComputeBudget(tx, MAX_COMPUTE_UNITS, 0);
  const { value: simulation } = await connection.simulateTransaction(simulated, signers);
  if (simulation.err) {
    if (simulation.logs?.length) {
      console.error(`Logs:\n${simulation.logs.join('\n')}`);
    }
    throw new Error(
      `Simulation of ${label} failed: ${describeSimulationError(simulated.instructions, simulation.err)}`
    );
  }
  const unitsConsumed = simulation.unitsConsumed ?? MAX_COMPUTE_UNITS;
  console.log(`>>> Simulated ${label} tx successfully (${unitsConsumed} compute units)`);
  if (config.dryRun) {
    return null;
  }

  console.log(`>> Sending ${label} transaction...`);
  const units = Math.min(Math.ceil(unitsConsumed * COMPUTE_UNIT_HEADROOM), MAX_COMPUTE_UNITS);
  const signature = await sendAndConfirmTransaction(
    connection,
    withComputeBudget(tx, units, microLamports),
    signers,
    { commitment: connection.commitment, maxRetries: DEFAULT_SEND_TX_MAX_RETRIES }
  );
  console.log(`>>> ${label} tx hash: ${signature}`);
  return signature;
}

/**
 * Runs steps that must land in order. They are sent as one atomic transaction when they fit in
 * one, which also lets a dry run simulate the steps that depend on an earlier one. Otherwise
 * each step is its own transaction and a dry run skips the dependent steps.
 */
export async function executeSteps(
  connection: Connection,
  config: DlmmProConfig,
  payer: Keypair,
  steps: TransactionStep[]
): Promise<void> {
  const microLamports = config.computeUnitPriceMicroLamports ?? 0;
  const merged = new Transaction().add(...steps.flatMap((step) => step.tx.instructions));
  merged.feePayer = payer.publicKey;

  if (transactionSize(merged, microLamports) <= TX_SIZE_LIMIT_BYTES) {
    const signers = new Map(
      steps.flatMap((step) => step.signers).map((signer) => [signer.publicKey.toString(), signer])
    );
    const label = steps.map((step) => step.label).join(' + ');
    await executeTransaction(connection, config, merged, [...signers.values()], label);
    return;
  }

  // Checked up front so that an oversized later step fails before an earlier one is sent.
  for (const step of steps) {
    assertFitsInOneTransaction(step.tx, microLamports, step.label);
  }
  const sent: string[] = [];
  for (const step of steps) {
    if (config.dryRun && step.dependsOnPriorStep) {
      console.log(
        `\n> Skipping the ${step.label} simulation: it depends on an earlier transaction, which a dry run does not send`
      );
      continue;
    }
    try {
      await executeTransaction(connection, config, step.tx, step.signers, step.label);
    } catch (error) {
      if (sent.length === 0) {
        throw error;
      }
      const reason = error instanceof Error ? error.message : String(error);
      throw new Error(
        `${reason}\nThe earlier transactions already landed (${sent.join(', ')}). Check the position or order on-chain before running this action again.`
      );
    }
    if (!config.dryRun) {
      sent.push(step.label);
    }
  }
}
