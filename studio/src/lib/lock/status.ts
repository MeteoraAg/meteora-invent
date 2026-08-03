import { Connection, PublicKey } from '@solana/web3.js';
import {
  calculateTotalLockedVestingAmount,
  Escrow,
  getTokenProgram,
  LockClient,
} from '@meteora-ag/met-lock-sdk';
import { getMint } from '@solana/spl-token';
import BN from 'bn.js';
import { getAmountInTokens } from '../../helpers';
import { DEFAULT_COMMITMENT_LEVEL } from '../../utils/constants';

// vestingEscrow account layout (verified against the installed .d.ts and the SDK repo's
// scripts/sumCreatorLockVaultTotals.s.ts, which hardcodes CREATOR_OFFSET = 8 + 32 + 32):
// 8 discriminator | 32 recipient (offset 8) | 32 tokenMint (offset 40) | 32 creator (offset 72)
const RECIPIENT_MEMCMP_OFFSET = 8;
const CREATOR_MEMCMP_OFFSET = 8 + 32 + 32;

interface VestingAmounts {
  total: BN;
  claimed: BN;
  claimable: BN;
}

/**
 * Total/claimed/claimable for an escrow as of `nowUnixSeconds`. Not exported by
 * met-lock-sdk itself (docs.md doesn't cover this math at all) — mirrors the linear-vesting
 * formula from the SDK repo's own scripts/sumCreatorLockVaultTotals.s.ts `releasedAmount`
 * helper, built on top of the SDK's exported `calculateTotalLockedVestingAmount`.
 */
function computeVestingAmounts(escrow: Escrow, nowUnixSeconds: BN): VestingAmounts {
  const total = calculateTotalLockedVestingAmount(
    escrow.cliffUnlockAmount,
    escrow.amountPerPeriod,
    escrow.numberOfPeriod
  );
  const claimed = escrow.totalClaimedAmount;

  if (nowUnixSeconds.lt(escrow.cliffTime)) {
    return { total, claimed, claimable: new BN(0) };
  }

  const endTime = escrow.cancelledAt.isZero()
    ? nowUnixSeconds
    : BN.min(nowUnixSeconds, escrow.cancelledAt);

  let vested: BN;
  if (escrow.frequency.isZero()) {
    vested = total;
  } else {
    const elapsed = BN.max(endTime.sub(escrow.vestingStartTime), new BN(0));
    const periods = BN.min(elapsed.div(escrow.frequency), escrow.numberOfPeriod);
    vested = BN.min(escrow.cliffUnlockAmount.add(escrow.amountPerPeriod.mul(periods)), total);
  }

  const claimable = BN.max(vested.sub(claimed), new BN(0));
  return { total, claimed, claimable };
}

async function getCurrentOnChainTime(connection: Connection): Promise<BN> {
  const slot = await connection.getSlot();
  const blockTime = await connection.getBlockTime(slot);
  if (blockTime === null) {
    throw new Error('Unable to fetch current on-chain block time');
  }
  return new BN(blockTime);
}

/**
 * Print the status of a single vesting escrow (read-only, no keypair needed).
 * `getEscrow()` THROWS on a missing account — caught here and reported cleanly instead of
 * letting the raw "Account ... not found" error bubble up.
 */
export async function getEscrow(connection: Connection, escrow: PublicKey) {
  const client = new LockClient(connection, DEFAULT_COMMITMENT_LEVEL);

  let escrowState: Escrow;
  try {
    escrowState = await client.getEscrow(escrow);
  } catch (error) {
    throw new Error(
      `No vesting escrow found at ${escrow.toString()}: ${error instanceof Error ? error.message : String(error)}`
    );
  }

  const now = await getCurrentOnChainTime(connection);
  const { total, claimed, claimable } = computeVestingAmounts(escrowState, now);

  const tokenProgram = getTokenProgram(escrowState.tokenProgramFlag);
  const mint = await getMint(
    connection,
    escrowState.tokenMint,
    connection.commitment,
    tokenProgram
  );
  const decimals = mint.decimals;

  console.log(`\n> Escrow:         ${escrow.toString()}`);
  console.log(`> Recipient:      ${escrowState.recipient.toString()}`);
  console.log(`> Creator:        ${escrowState.creator.toString()}`);
  console.log(`> Token mint:     ${escrowState.tokenMint.toString()}`);
  console.log(
    `> Token program:  ${escrowState.tokenProgramFlag === 1 ? 'Token-2022' : 'SPL Token'}`
  );
  console.log(`> Vesting start:  ${escrowState.vestingStartTime.toString()} (unix seconds)`);
  console.log(`> Cliff time:     ${escrowState.cliffTime.toString()} (unix seconds)`);
  console.log(`> Frequency:      ${escrowState.frequency.toString()} seconds/period`);
  console.log(`> Periods:        ${escrowState.numberOfPeriod.toString()}`);
  if (!escrowState.cancelledAt.isZero()) {
    console.log(`> Cancelled at:   ${escrowState.cancelledAt.toString()} (unix seconds)`);
  }
  console.log(
    `> Total locked:   ${getAmountInTokens(total, decimals)} (${total.toString()} base units)`
  );
  console.log(
    `> Claimed so far: ${getAmountInTokens(claimed, decimals)} (${claimed.toString()} base units)`
  );
  console.log(
    `> Claimable now:  ${getAmountInTokens(claimable, decimals)} (${claimable.toString()} base units)`
  );
}

/**
 * List vesting escrows where `wallet` is the recipient or the creator (needs the wallet's
 * public key to filter by, but no signature — read-only).
 * `program.account.vestingEscrow.all` with a memcmp filter — offsets verified against the
 * SDK repo's scripts/sumCreatorLockVaultTotals.s.ts (CREATOR_OFFSET = 8 + 32 + 32).
 */
export async function listEscrows(
  connection: Connection,
  wallet: PublicKey,
  role: 'recipient' | 'creator'
) {
  const client = new LockClient(connection, DEFAULT_COMMITMENT_LEVEL);
  const offset = role === 'recipient' ? RECIPIENT_MEMCMP_OFFSET : CREATOR_MEMCMP_OFFSET;

  const accounts = await client.program.account.vestingEscrow.all([
    { memcmp: { offset, bytes: wallet.toBase58() } },
  ]);

  console.log(`\n> Escrows where ${wallet.toString()} is ${role}: ${accounts.length}`);
  if (accounts.length === 0) {
    return;
  }

  const now = await getCurrentOnChainTime(connection);

  // Raw base-unit amounts only — a decimals-aware view would need one getMint() RPC call
  // per distinct mint here. Run lock-get-escrow --escrow <address> for the formatted view.
  accounts.forEach(({ publicKey, account }, index) => {
    const { total, claimed, claimable } = computeVestingAmounts(account, now);
    console.log(`\n  [${index + 1}] Escrow ${publicKey.toString()}`);
    console.log(`      Mint:      ${account.tokenMint.toString()}`);
    console.log(`      Recipient: ${account.recipient.toString()}`);
    console.log(`      Creator:   ${account.creator.toString()}`);
    console.log(`      Total:     ${total.toString()} (base units)`);
    console.log(`      Claimed:   ${claimed.toString()} (base units)`);
    console.log(`      Claimable: ${claimable.toString()} (base units)`);
  });
}
