import { Connection, PublicKey, Keypair, Transaction } from '@solana/web3.js';
import { Wallet } from '@coral-xyz/anchor';
import {
  Zap,
  estimateDlmmDirectSwap,
  DlmmSingleSided,
  DEFAULT_JUPITER_API_URL,
} from '@meteora-ag/zap-sdk';
import {
  CpAmm,
  getTokenProgram as getDammV2TokenProgram,
  getTokenDecimals as getDammV2TokenDecimals,
  getCurrentPoint,
  derivePositionAddress,
  getBaseFeeHandlerFromPodAlignedData,
  FeeRateLimiter,
  type PoolState,
} from '@meteora-ag/cp-amm-sdk';
import DLMM, { getTokenProgramId, StrategyType } from '@meteora-ag/dlmm';
import {
  getAccount,
  getAssociatedTokenAddressSync,
  TokenAccountNotFoundError,
  TokenInvalidAccountOwnerError,
} from '@solana/spl-token';
import BN from 'bn.js';
import Decimal from 'decimal.js';
import { ZapConfig } from '../../utils/types';
import {
  getAmountInLamports,
  getAmountInTokens,
  promptForSelection,
  sendOrderedTransactions,
  combineTransactions,
  OrderedTransactionStep,
} from '../../helpers';
import { SOL_TOKEN_MINT } from '../../utils/constants';

/**
 * 0-SOL fee-payer guard, shared by every write action below.
 */
async function assertFunded(connection: Connection, payer: PublicKey): Promise<void> {
  const balance = await connection.getBalance(payer);
  if (balance === 0) {
    throw new Error(
      `Wallet ${payer.toString()} has 0 SOL — fund it first; even dry-run simulation requires an existing fee payer account`
    );
  }
}

/**
 * Refuse a DAMM v2 zap-in against a Rate-Limiter-fee-mode pool.
 *
 * The zap program CPIs into cp-amm's swap to rebalance, and the rate limiter rejects that
 * with error 6049 (FailToValidateSingleSwapInstruction) regardless of how the transaction is
 * arranged, so this must run pre-flight — the zap-in step depends on a prior step, and a dry
 * run cannot simulate it.
 *
 * The fee mode is POD/bytemuck-packed into `baseFeeInfo.data` on a fetched pool, not the
 * Borsh layout used by client-constructed pool-creation params, so it must decode with
 * `getBaseFeeHandlerFromPodAlignedData` rather than the Borsh variant.
 */
function assertPoolIsZapInCompatible(poolState: PoolState, poolAddress: PublicKey): void {
  const baseFeeHandler = getBaseFeeHandlerFromPodAlignedData(
    poolState.poolFees.baseFee.baseFeeInfo.data
  );
  if (baseFeeHandler instanceof FeeRateLimiter) {
    throw new Error(
      `DAMM v2 pool ${poolAddress.toString()} uses the Rate Limiter base-fee mode, which is not ` +
        'compatible with zap-in: the zap program swaps by CPI into cp-amm, and the rate limiter ' +
        'rejects that with error 6049 (FailToValidateSingleSwapInstruction) no matter how the ' +
        'transactions are arranged. Stopping now, before any transaction is sent.\n' +
        'To zap into a pool you are creating, give it a fee-scheduler base-fee mode instead ' +
        '(damm_v2_config.jsonc baseFeeMode 0 or 1). For a pool that already exists with the rate ' +
        'limiter, add liquidity directly with damm-v2-add-liquidity instead of zapping.'
    );
  }
}

/**
 * Confirm `owner` holds at least `amountLamports` of `mint`, honoring the native-SOL
 * wSOL-wrap convention used throughout this codebase (dynamic_vault, fee_sharing): a
 * native-SOL mint only needs actual SOL lamports in the wallet, not a pre-funded wSOL ATA.
 */
async function assertHoldsAtLeast(
  connection: Connection,
  owner: PublicKey,
  mint: PublicKey,
  tokenProgram: PublicKey,
  amountLamports: BN,
  decimals: number,
  humanAmount: number,
  verb: string
): Promise<void> {
  if (mint.equals(SOL_TOKEN_MINT)) {
    const solBalance = await connection.getBalance(owner);
    if (solBalance < Number(amountLamports.toString())) {
      throw new Error(
        `Wallet ${owner.toString()} has ${solBalance} lamports of SOL but ${verb} ${humanAmount} SOL ` +
          `needs ${amountLamports.toString()} lamports to wrap, plus a little more for rent and fees — ` +
          'fund the wallet with more SOL first.'
      );
    }
    return;
  }

  const ata = getAssociatedTokenAddressSync(mint, owner, true, tokenProgram);
  let balance = new BN(0);
  try {
    const account = await getAccount(connection, ata, connection.commitment, tokenProgram);
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
      `Wallet ${owner.toString()} holds ${getAmountInTokens(balance, decimals)} of mint ${mint.toString()} ` +
        `but ${verb} ${humanAmount} needs ${getAmountInTokens(amountLamports, decimals)} — fund the wallet's ` +
        'token account first.'
    );
  }
}

/**
 * Zap a single input token directly into a DAMM v2 position (direct route only — the
 * non-input side is sourced from the POOL ITSELF, never Jupiter).
 *
 * Reads config.zapInDammV2: inputMint (must be tokenA or tokenB of the pool — direct
 * routes require the input to already be one of the pool's own tokens), amountIn (human
 * units of inputMint), slippageBps, maxSqrtPriceChangeBps, maxTransferAmountExtendPercentage,
 * positionMode ("new" creates a fresh empty position first, co-signed by a throwaway
 * keypair; "existing" deposits into the wallet's own position on this pool, prompting when
 * there is more than one).
 *
 * Two-phase SDK call (verified against the installed @meteora-ag/zap-sdk@1.3.2 .d.ts, the
 * SDK's own examples/zapInDammV2DirectPool.ts, and tests/zapInDammV2.test.ts):
 * `getZapInDammV2DirectPoolParams` -> `buildZapInDammV2Transaction`. The response is an
 * ORDERED multi-transaction bundle — setupTransaction? -> swapTransactions[] ->
 * ledgerTransaction -> zapInTransaction -> cleanUpTransaction — sent in that exact order via
 * the shared `sendOrderedTransactions` helper.
 *
 * No-Jupiter guarantee (verified against the SDK source, not just its docs): passing
 * `jupiterQuote: null` makes the SDK's internal route picker take the
 * `else if (dammV2Quote !== null)` branch unconditionally — the Jupiter branch requires
 * `jupiterQuote !== null` first, so `buildJupiterSwapTransaction` (the only place that would
 * hit Jupiter's live API) is provably unreachable here. `dammV2Quote` itself is our own
 * REFERENCE quote for exactly 1 unit of inputMint priced through the pool's own liquidity
 * (per the SDK's own JSDoc: "used for price calculation, not the actual amountIn") — computed
 * with `cpAmm.getQuote`, the same public helper `damm-v2-swap` already uses elsewhere in this
 * codebase.
 */
export async function zapInDammV2(
  config: ZapConfig,
  connection: Connection,
  wallet: Wallet,
  poolAddress: PublicKey
) {
  if (!config.zapInDammV2) {
    throw new Error('Missing zapInDammV2 in configuration');
  }
  const {
    inputMint,
    amountIn,
    slippageBps,
    maxSqrtPriceChangeBps,
    maxTransferAmountExtendPercentage,
    positionMode,
  } = config.zapInDammV2;

  if (!(amountIn > 0)) {
    throw new Error(`zapInDammV2.amountIn must be > 0 (got ${amountIn})`);
  }
  if (positionMode !== 'new' && positionMode !== 'existing') {
    throw new Error(`zapInDammV2.positionMode must be "new" or "existing" (got "${positionMode}")`);
  }

  console.log('\n> Initializing Zap-in DAMM v2 (direct route)...');
  await assertFunded(connection, wallet.publicKey);

  const cpAmm = new CpAmm(connection);
  const poolState: PoolState = await cpAmm.fetchPoolState(poolAddress);
  const inputTokenMint = new PublicKey(inputMint);

  if (
    !inputTokenMint.equals(poolState.tokenAMint) &&
    !inputTokenMint.equals(poolState.tokenBMint)
  ) {
    throw new Error(
      `zapInDammV2.inputMint (${inputTokenMint.toString()}) is not tokenA or tokenB of pool ` +
        `${poolAddress.toString()} (tokenA=${poolState.tokenAMint.toString()}, ` +
        `tokenB=${poolState.tokenBMint.toString()}). Direct-route zap-in requires the input mint ` +
        "to already be one of the pool's two tokens — Jupiter-routed (indirect) zaps are not " +
        'covered by this action.'
    );
  }

  assertPoolIsZapInCompatible(poolState, poolAddress);

  const tokenAProgram = getDammV2TokenProgram(poolState.tokenAFlag);
  const tokenBProgram = getDammV2TokenProgram(poolState.tokenBFlag);
  const isInputA = inputTokenMint.equals(poolState.tokenAMint);
  const inputTokenProgram = isInputA ? tokenAProgram : tokenBProgram;
  const inputDecimals = await getDammV2TokenDecimals(connection, inputTokenMint, inputTokenProgram);
  const amountInLamports = getAmountInLamports(amountIn, inputDecimals);

  console.log(`- Pool ${poolAddress.toString()}`);
  console.log(
    `- Input mint ${inputTokenMint.toString()} (${isInputA ? 'tokenA' : 'tokenB'}, ${inputDecimals} decimals)`
  );
  console.log(`- Amount in: ${amountIn} (${amountInLamports.toString()} base units)`);
  if (poolState.tokenAMint.equals(SOL_TOKEN_MINT) || poolState.tokenBMint.equals(SOL_TOKEN_MINT)) {
    console.log(
      '- Note: this pool pairs with native SOL — the zap SDK transiently wraps/unwraps a small ' +
        'amount of SOL as part of its setup/clean-up steps even when the input side is not SOL; ' +
        'keep a little extra SOL headroom beyond fees.'
    );
  }

  await assertHoldsAtLeast(
    connection,
    wallet.publicKey,
    inputTokenMint,
    inputTokenProgram,
    amountInLamports,
    inputDecimals,
    amountIn,
    'depositing'
  );

  const zap = new Zap(connection);

  // Resolve the position to deposit into. `positionNftKeypair` stays undefined for
  // "existing" mode (nothing to create/co-sign); `positionAddress` is the on-chain position
  // PDA either way — computed directly via `derivePositionAddress` for "new" mode (a pure,
  // deterministic function of the mint, verified exported by the installed cp-amm-sdk) so it
  // is available for logging/recovery purposes even before the position actually exists.
  let positionNftMint: PublicKey;
  let positionNftKeypair: Keypair | undefined;
  let positionAddress: PublicKey;
  const preambleSteps: OrderedTransactionStep[] = [];

  if (positionMode === 'new') {
    positionNftKeypair = Keypair.generate();
    positionNftMint = positionNftKeypair.publicKey;
    positionAddress = derivePositionAddress(positionNftMint);

    console.log(
      `- Creating a fresh, empty DAMM v2 position (NFT mint ${positionNftMint.toString()})`
    );
    const createPositionTx = await cpAmm.createPosition({
      owner: wallet.publicKey,
      payer: wallet.publicKey,
      pool: poolAddress,
      positionNft: positionNftMint,
    });
    preambleSteps.push({
      label: 'create position',
      tx: createPositionTx,
      signers: [wallet.payer, positionNftKeypair],
    });
  } else {
    const userPositions = await cpAmm.getUserPositionByPool(poolAddress, wallet.publicKey);
    if (userPositions.length === 0) {
      throw new Error(
        `positionMode is "existing" but wallet ${wallet.publicKey.toString()} holds no position on ` +
          `pool ${poolAddress.toString()}. Set positionMode to "new" to create one first.`
      );
    }

    let chosen = userPositions[0]!;
    if (userPositions.length > 1) {
      const selectedIndex = await promptForSelection(
        userPositions.map(
          (p, i) =>
            `Position ${i + 1}: ${p.position.toString()} (unlocked liquidity ${p.positionState.unlockedLiquidity.toString()})`
        ),
        'Multiple positions found on this pool — which one should the zap deposit into?'
      );
      chosen = userPositions[selectedIndex]!;
    }
    positionNftMint = chosen.positionState.nftMint;
    positionAddress = chosen.position;
    console.log(`- Depositing into existing position ${chosen.position.toString()}`);
  }

  // Reference DAMM v2 quote for exactly 1 unit of inputMint (price only — NOT the real
  // trade amount, per the SDK's own param docs) so getZapInDammV2DirectPoolParams can price
  // the internal rebalancing swap without ever needing a Jupiter quote.
  const currentSlot = await connection.getSlot();
  const currentTime = (await connection.getBlockTime(currentSlot)) ?? Math.floor(Date.now() / 1000);
  const tokenADecimal = await getDammV2TokenDecimals(
    connection,
    poolState.tokenAMint,
    tokenAProgram
  );
  const tokenBDecimal = await getDammV2TokenDecimals(
    connection,
    poolState.tokenBMint,
    tokenBProgram
  );
  const oneInputToken = getAmountInLamports(1, inputDecimals);

  let dammV2Quote: {
    swapInAmount: BN;
    consumedInAmount: BN;
    swapOutAmount: BN;
    minSwapOutAmount: BN;
    totalFee: BN;
    priceImpact: Decimal;
  } | null = null;
  try {
    dammV2Quote = cpAmm.getQuote({
      inAmount: oneInputToken,
      inputTokenMint,
      slippage: slippageBps / 100,
      poolState,
      currentTime,
      currentSlot,
      tokenADecimal,
      tokenBDecimal,
    });
  } catch (error) {
    console.log(
      '- Could not compute a reference DAMM v2 quote (pool may be single-sided or too thin to ' +
        `quote 1 unit): ${error instanceof Error ? error.message : String(error)}`
    );
  }

  const directParams = await zap.getZapInDammV2DirectPoolParams({
    user: wallet.publicKey,
    inputTokenMint,
    amountIn: amountInLamports,
    pool: poolAddress,
    positionNftMint,
    maxSqrtPriceChangeBps,
    maxTransferAmountExtendPercentage,
    // Unused on this code path: only read inside the Jupiter branch, which is unreachable
    // because jupiterQuote is always null below (verified against the SDK source).
    maxAccounts: 20,
    slippageBps,
    dammV2Quote,
    jupiterQuote: null,
  });

  const bundle = await zap.buildZapInDammV2Transaction(directParams);

  console.log(`\n>>> Position NFT mint: ${positionNftMint.toString()}`);
  if (positionMode === 'new' && config.dryRun) {
    console.log(
      '>>> DRY RUN — this is a placeholder from a throwaway keypair. A NEW position mint will'
    );
    console.log('>>> be generated and printed when you run with dryRun=false. Do NOT save it.');
  } else {
    console.log('>>> Save this — it identifies the position this zap deposited into.');
  }

  const combinedSigners = positionNftKeypair ? [positionNftKeypair] : [];
  const steps: OrderedTransactionStep[] = buildDammV2ZapInSteps(
    preambleSteps,
    bundle,
    combinedSigners
  );

  await sendOrderedTransactions(
    connection,
    steps,
    wallet.payer,
    config.dryRun,
    config.computeUnitPriceMicroLamports ?? 0,
    {
      retrySafety: 'not-idempotent',
      recoveryAddress: positionAddress.toString(),
    }
  );
}

/**
 * Builds the ordered step list for a DAMM v2 direct-route zap-in bundle. `preambleSteps` is
 * either `[]` (positionMode "existing") or a single "create position" step (positionMode
 * "new"); `bundle` is the SDK's response from `buildZapInDammV2Transaction`.
 *
 * EMPIRICAL F4 FIX (verified on localnet — see studio/src/tests/e2e-review-fixes-zap.sh, two
 * rounds of empirical evidence):
 *
 * Round 1 finding: `sendOrderedTransactions`' dry-run simulates each step independently
 * against UNCHANGED chain state, so any step whose accounts are only created/initialized by
 * an EARLIER step fails simulation once that earlier step is only simulated too (never
 * actually landing on-chain). Confirmed empirically: dry-running the ORIGINAL 5-separate-step
 * bundle failed "zap in" simulation with Anchor error 3007 `AccountOwnedByWrongProgram` on the
 * `ledger` account (created by the immediately-preceding "ledger update" step) — and, for
 * positionMode "new", the same problem applies in principle to the `position` account created
 * by the separate preceding "create position" step (the reviewer's original hypothesis).
 *
 * Round 1 attempted fix (REVERTED): combining create-position + setup + ledger + zap-in +
 * clean-up into ONE transaction resolves the dry-run problem (confirmed — the account
 * -ownership error disappeared) but empirically BREAKS A REAL SEND for the template's default
 * pool config: `damm_v2_config.jsonc`'s default `baseFeeMode: 2` (Rate Limiter) rejects it
 * on-chain with `AnchorError ... FailToValidateSingleSwapInstruction` (error 6049) — the
 * rate-limiter fee mode requires the swap-performing instruction to be the ONLY thing in its
 * transaction (`zapInDammV2` CPIs into cp-amm's `Swap2` internally to do the rebalance swap,
 * confirmed in the simulation logs), which is almost certainly WHY the SDK's own response
 * shape keeps `zapInTransaction` as its own separate field in the first place — not merely a
 * transaction-size convenience. Combining zap-in with anything else is therefore NOT safe in
 * general, regardless of size headroom.
 *
 * Actual fix: combine ONLY create-position (if any) + setup + ledger into ONE transaction —
 * none of those three invoke the rate-limited swap path (confirmed: CreatePosition ran fine
 * alongside other instructions in the round-1 experiment; only the ZapInDammV2 instruction
 * itself tripped the check), so this is safe and resolves both dependency problems above
 * without touching zap-in's isolation. "zap in" and "clean up" stay in their OWN untouched
 * transactions exactly as the SDK built them, marked `dependsOnPriorStep: true` so dry-run
 * honestly DEFERS simulating them (they still depend on the combined step having actually
 * landed, which a simulation never does) instead of either misreporting a failure (the
 * original bug) or falsely claiming full verification. A live send is unaffected either way —
 * all steps still send for real, in order.
 *
 * Whenever `bundle.swapTransactions` is non-empty — believed unreachable for this action today
 * (studio always calls `getZapInDammV2DirectPoolParams` with `jupiterQuote: null`, and the
 * installed zap-sdk's `dammV2Quote` branch, the only one reachable with a null jupiterQuote,
 * never populates `swapTransactions` — verified by reading the compiled SDK source) — this
 * falls back to the fully-separate, fully-deferred step list instead of assuming it is safe to
 * combine a not-yet-landed swap's output into the same transaction as anything reading it.
 */
function buildDammV2ZapInSteps(
  preambleSteps: OrderedTransactionStep[],
  bundle: {
    setupTransaction?: Transaction;
    swapTransactions: Transaction[];
    ledgerTransaction: Transaction;
    zapInTransaction: Transaction;
    cleanUpTransaction: Transaction;
  },
  combinedSigners: Keypair[]
): OrderedTransactionStep[] {
  if (bundle.swapTransactions.length === 0) {
    const mergeable = [...preambleSteps.map((step) => step.tx)];
    if (bundle.setupTransaction) {
      mergeable.push(bundle.setupTransaction);
    }
    mergeable.push(bundle.ledgerTransaction);

    return [
      {
        label:
          preambleSteps.length > 0
            ? 'create position + setup + ledger (combined into one transaction)'
            : 'setup + ledger (combined into one transaction)',
        tx: combineTransactions(mergeable),
        signers: combinedSigners,
      },
      {
        label: 'zap in',
        tx: bundle.zapInTransaction,
        signers: [],
        dependsOnPriorStep: true,
      },
      {
        label: 'clean up',
        tx: bundle.cleanUpTransaction,
        signers: [],
        dependsOnPriorStep: true,
      },
    ];
  }

  // Defensive fallback — see this function's doc. Not exercised by studio's own code today.
  const steps: OrderedTransactionStep[] = [...preambleSteps];
  if (bundle.setupTransaction) {
    steps.push({
      label: 'setup (wrap SOL / create ATAs)',
      tx: bundle.setupTransaction,
      signers: [],
    });
  }
  bundle.swapTransactions.forEach((tx, i) => {
    steps.push({
      label: `internal rebalance swap ${i + 1}/${bundle.swapTransactions.length}`,
      tx,
      signers: [],
      dependsOnPriorStep: i > 0,
    });
  });
  steps.push({
    label: 'ledger update',
    tx: bundle.ledgerTransaction,
    signers: [],
    dependsOnPriorStep: true,
  });
  steps.push({
    label: 'zap in',
    tx: bundle.zapInTransaction,
    signers: [],
    dependsOnPriorStep: true,
  });
  steps.push({
    label: 'clean up',
    tx: bundle.cleanUpTransaction,
    signers: [],
    dependsOnPriorStep: true,
  });
  return steps;
}

/**
 * Jupiter client config resolution order for `zapInDlmm`'s live quote calls: an explicit
 * `JUPITER_API_URL` / `JUPITER_API_KEY` in `studio/.env` (loaded by the action script the same
 * way `generate_keypair.ts` loads `PRIVATE_KEY`) override the zap-sdk's own default. Verified
 * against the installed `@meteora-ag/zap-sdk@1.3.2` dist: the default endpoint is
 * `DEFAULT_JUPITER_API_URL` (`"https://api.jup.ag"`) and the default API key is `""` — Jupiter's
 * own docs (developers.jup.ag, checked live) confirm that endpoint accepts unauthenticated
 * ("keyless") requests at a shared, low rate limit, so neither env var is required to get a
 * quote at all; an API key only raises the ceiling. Returning `undefined` (not an empty string)
 * for an unset var lets the SDK fall back to ITS OWN default instead of us hard-coding it again.
 */
function resolveJupiterConfig(): { jupiterApiUrl?: string; jupiterApiKey?: string } {
  return {
    jupiterApiUrl: process.env.JUPITER_API_URL || undefined,
    jupiterApiKey: process.env.JUPITER_API_KEY || undefined,
  };
}

/**
 * `zapInDlmm`'s quote/build phase talks to Jupiter's live API, and the underlying error rarely
 * says why it failed. Verified end-to-end against a live mainnet pool (see studio-actions.md's
 * Zap section / this repo's functional-proof notes): the QUOTE phase (`estimateDlmmDirectSwap`)
 * degrades gracefully when Jupiter's quote endpoint alone is unreachable — internally it falls
 * back to the DLMM pool's own bin quote and only throws a generic "Failed to get ... swap quote"
 * once THAT also fails — but the BUILD phase does not have that safety net: once Jupiter's quote
 * has already won the comparison, `getZapInDlmmDirectParams` commits to fetching Jupiter's
 * swap-instructions for that exact quote (`buildJupiterSwapTransaction` ->
 * `getJupiterSwapInstruction`), which throws hard (`response.status` + body, no DLMM fallback)
 * if that specific call fails. Either failure is worth the same actionable hint, so both call
 * sites below are wrapped with it.
 */
function wrapJupiterQuoteFailure(error: unknown): Error {
  const message = error instanceof Error ? error.message : String(error);
  return new Error(
    'Jupiter quote failed — set JUPITER_API_KEY in studio/.env (get one at ' +
      'https://developers.jup.ag/portal) or JUPITER_API_URL for a custom endpoint. ' +
      `Underlying error: ${message}`
  );
}

/**
 * Zap a single input token into a BRAND-NEW DLMM position — Jupiter-quoted, unlike
 * `zapInDammV2`'s direct route. Verified against the installed `@meteora-ag/zap-sdk@1.3.2`
 * `.d.ts`, its compiled source, and its own `examples/zapInDlmmDirect(SingleSided).ts` (its
 * `docs.md` only covers `zapOut*`/Jupiter helpers, not zap-in — cross-checked against source
 * instead, same as `zapInDammV2`).
 *
 * Reads config.zapInDlmm: inputMint (must be tokenX or tokenY of the lbPair — direct route
 * only, same requirement as zapInDammV2), amountIn (human units of inputMint), swapSlippageBps,
 * minDeltaId/maxDeltaId (the position's bin range, as an offset from the CURRENT active bin —
 * e.g. -34/34), strategyType (0 Spot | 1 Curve | 2 BidAsk), singleSided ("x" | "y" | null),
 * favorXInActiveId (the active bin's own X/Y tie-break; forced to match singleSided whenever
 * it's set — mirrors the SDK's own `zapInDlmmDirectSingleSided.ts` example), maxActiveBinSlippage,
 * maxAccounts, maxTransferAmountExtendPercentage.
 *
 * ALWAYS creates a new position (a throwaway keypair co-signs once, and the resulting position
 * address is logged prominently) — verified against the SDK source: `buildZapInDlmmTransaction`
 * unconditionally calls the private `zapInDlmmForUninitializedPosition` (whose embedded IDL
 * marks `position` as a fresh `signer` account, matching `Keypair.generate()` in the SDK's own
 * examples). The companion instruction for an already-initialized position
 * (`zapInDlmmForInitializedPosition`) is only reachable through the separate, much heavier
 * `rebalanceDlmmPosition` flow (remove ALL liquidity -> swap -> re-add) — a different operation,
 * out of scope here; depositing into an existing DLMM position stays a BUILD-path task (see
 * `studio-actions.md` / `SKILL.md`'s "DLMM add-to-existing-position / rebalance" note).
 *
 * No Jupiter-free guarantee here (unlike zapInDammV2's `jupiterQuote: null` escape hatch):
 * `estimateDlmmDirectSwap` calls Jupiter's live quote API (`getBestSwapQuoteJupiterDlmm`)
 * whenever the deposit actually needs a rebalancing swap — i.e. whenever the input token's
 * natural split across the target bin range isn't already what the strategy wants, which is the
 * common case for a single-token deposit — and compares it against the pool's own bin quote,
 * keeping whichever pays out more; there is no parameter to force the DLMM-only route. When
 * Jupiter's quote wins, the build phase (`getZapInDlmmDirectParams`) also calls Jupiter's
 * swap-instructions endpoint to build that swap transaction.
 *
 * Three-phase SDK call: `estimateDlmmDirectSwap` -> `getZapInDlmmDirectParams` ->
 * `buildZapInDlmmTransaction`. Response is the same ordered multi-transaction bundle shape as
 * `zapInDammV2` — setupTransaction? -> swapTransactions[] -> ledgerTransaction ->
 * zapInTransaction -> cleanUpTransaction — sent in that exact order via the shared
 * `sendOrderedTransactions` helper.
 */
export async function zapInDlmm(
  config: ZapConfig,
  connection: Connection,
  wallet: Wallet,
  poolAddress: PublicKey
) {
  if (!config.zapInDlmm) {
    throw new Error('Missing zapInDlmm in configuration');
  }
  const {
    inputMint,
    amountIn,
    swapSlippageBps,
    minDeltaId,
    maxDeltaId,
    strategyType,
    singleSided,
    favorXInActiveId,
    maxActiveBinSlippage,
    maxAccounts,
    maxTransferAmountExtendPercentage,
  } = config.zapInDlmm;

  if (!(amountIn > 0)) {
    throw new Error(`zapInDlmm.amountIn must be > 0 (got ${amountIn})`);
  }
  if (strategyType !== 0 && strategyType !== 1 && strategyType !== 2) {
    throw new Error(
      `zapInDlmm.strategyType must be 0 (Spot), 1 (Curve), or 2 (BidAsk) (got ${strategyType})`
    );
  }
  if (singleSided !== null && singleSided !== 'x' && singleSided !== 'y') {
    throw new Error(
      `zapInDlmm.singleSided must be "x", "y", or null (got ${JSON.stringify(singleSided)})`
    );
  }
  if (minDeltaId > maxDeltaId) {
    throw new Error(
      `zapInDlmm.minDeltaId (${minDeltaId}) must be <= zapInDlmm.maxDeltaId (${maxDeltaId})`
    );
  }

  console.log('\n> Initializing Zap-in DLMM (Jupiter-quoted)...');
  await assertFunded(connection, wallet.publicKey);

  const jupiterConfig = resolveJupiterConfig();
  console.log(
    `- Jupiter endpoint: ${jupiterConfig.jupiterApiUrl ?? DEFAULT_JUPITER_API_URL}` +
      (jupiterConfig.jupiterApiKey
        ? ' (using JUPITER_API_KEY)'
        : ' (keyless — set JUPITER_API_KEY in studio/.env for a higher rate limit)')
  );

  const dlmm = await DLMM.create(connection, poolAddress);
  const inputTokenMint = new PublicKey(inputMint);

  if (
    !inputTokenMint.equals(dlmm.lbPair.tokenXMint) &&
    !inputTokenMint.equals(dlmm.lbPair.tokenYMint)
  ) {
    throw new Error(
      `zapInDlmm.inputMint (${inputTokenMint.toString()}) is not tokenX or tokenY of lbPair ` +
        `${poolAddress.toString()} (tokenX=${dlmm.lbPair.tokenXMint.toString()}, ` +
        `tokenY=${dlmm.lbPair.tokenYMint.toString()}). Direct-route zap-in requires the input ` +
        "mint to already be one of the pool's two tokens."
    );
  }

  const { tokenXProgram, tokenYProgram } = getTokenProgramId(dlmm.lbPair);
  const isInputX = inputTokenMint.equals(dlmm.lbPair.tokenXMint);
  const inputTokenProgram = isInputX ? tokenXProgram : tokenYProgram;
  const inputDecimals = isInputX ? dlmm.tokenX.mint.decimals : dlmm.tokenY.mint.decimals;
  const amountInLamports = getAmountInLamports(amountIn, inputDecimals);

  console.log(`- Pool ${poolAddress.toString()}`);
  console.log(
    `- Input mint ${inputTokenMint.toString()} (${isInputX ? 'tokenX' : 'tokenY'}, ${inputDecimals} decimals)`
  );
  console.log(`- Amount in: ${amountIn} (${amountInLamports.toString()} base units)`);
  console.log(
    `- Active bin: ${dlmm.lbPair.activeId}, target range [${dlmm.lbPair.activeId + minDeltaId}, ` +
      `${dlmm.lbPair.activeId + maxDeltaId}]`
  );
  if (
    dlmm.lbPair.tokenXMint.equals(SOL_TOKEN_MINT) ||
    dlmm.lbPair.tokenYMint.equals(SOL_TOKEN_MINT)
  ) {
    console.log(
      '- Note: this pool pairs with native SOL — the zap SDK transiently wraps/unwraps a small ' +
        'amount of SOL as part of its setup/clean-up steps even when the input side is not SOL; ' +
        'keep a little extra SOL headroom beyond fees.'
    );
  }

  await assertHoldsAtLeast(
    connection,
    wallet.publicKey,
    inputTokenMint,
    inputTokenProgram,
    amountInLamports,
    inputDecimals,
    amountIn,
    'depositing'
  );

  const singleSidedMode: DlmmSingleSided | undefined =
    singleSided === 'x' ? DlmmSingleSided.X : singleSided === 'y' ? DlmmSingleSided.Y : undefined;
  // The active bin must be depositable with whichever side the deposit is single-sided in, or
  // the on-chain instruction has nothing to put there — mirrors the SDK's own
  // examples/zapInDlmmDirectSingleSided.ts, which derives this the same way.
  const resolvedFavorXInActiveId = singleSided === null ? favorXInActiveId : singleSided === 'x';

  console.log(
    '\n> Requesting a swap quote for the rebalancing swap (Jupiter or the pool itself, whichever pays more)...'
  );
  const estimate = await estimateDlmmDirectSwap({
    amountIn: amountInLamports,
    inputTokenMint,
    lbPair: poolAddress,
    connection,
    swapSlippageBps,
    minDeltaId,
    maxDeltaId,
    strategy: strategyType as StrategyType,
    singleSided: singleSidedMode,
    config: jupiterConfig,
  }).catch((error) => {
    throw wrapJupiterQuoteFailure(error);
  });

  const zap = new Zap(connection, jupiterConfig);

  const positionKeypair = Keypair.generate();
  console.log(`\n>>> Position: ${positionKeypair.publicKey.toString()}`);
  if (config.dryRun) {
    console.log(
      '>>> DRY RUN — this is a placeholder from a throwaway keypair. A NEW position will be'
    );
    console.log('>>> generated and printed when you run with dryRun=false. Do NOT save it.');
  } else {
    console.log('>>> Save this — it identifies the position this zap deposited into.');
  }

  const directParams = await zap
    .getZapInDlmmDirectParams({
      user: wallet.publicKey,
      maxActiveBinSlippage,
      favorXInActiveId: resolvedFavorXInActiveId,
      maxAccounts,
      maxTransferAmountExtendPercentage,
      directSwapEstimate: estimate.result,
      ...estimate.context,
    })
    .catch((error) => {
      throw wrapJupiterQuoteFailure(error);
    });

  const bundle = await zap.buildZapInDlmmTransaction({
    ...directParams,
    position: positionKeypair.publicKey,
  });

  const steps: OrderedTransactionStep[] = buildDlmmZapInSteps(bundle, positionKeypair);

  await sendOrderedTransactions(
    connection,
    steps,
    wallet.payer,
    config.dryRun,
    config.computeUnitPriceMicroLamports ?? 0,
    {
      retrySafety: 'not-idempotent',
      recoveryAddress: positionKeypair.publicKey.toString(),
    }
  );
}

/**
 * Builds the ordered step list for a DLMM zap-in bundle. Same empirically-verified F4 bug as
 * `buildDammV2ZapInSteps` (see its doc, including the ROUND 1 finding/revert): the "zap in"
 * instruction's `ledger` account is created by the immediately-preceding "ledger update" step,
 * so `sendOrderedTransactions`' per-step-independent dry-run simulation fails it with an
 * uninitialized-account error unless that dependency is removed.
 *
 * This function deliberately never combines "zap in" itself with anything else, for two
 * independent reasons, either of which is sufficient on its own:
 * 1. DAMM v2's `zapInDammV2` instruction was empirically found to internally CPI into a
 *    rate-limited swap that on-chain REJECTS being combined with any other instruction in the
 *    same transaction (`FailToValidateSingleSwapInstruction`, cp-amm error 6049 — see
 *    `buildDammV2ZapInSteps`'s doc for the full empirical trail). DLMM is a different program
 *    with a different fee model and has not been observed to have the identical restriction,
 *    but this has NOT been verified empirically for DLMM (Jupiter-dependent, cannot run on
 *    localnet — see this file's zap-in-dlmm doc), so the same conservative isolation is kept
 *    here rather than assumed safe.
 * 2. DLMM zap-in's rebalancing swap is genuinely common (per this file's `zapInDlmm` doc:
 *    needed whenever the deposit isn't already balanced for the target range) and can be
 *    Jupiter-routed — Jupiter routes can already sit close to the transaction size ceiling on
 *    their own, so combining a real swap transaction into the same transaction as anything
 *    else is not safe to assume fits.
 *
 * So: combine ONLY setup + ledger into one transaction when there is no swap to worry about
 * (neither invokes anything swap-related); "zap in" and "clean up" always stay in their OWN
 * untouched transactions exactly as the SDK built them, marked `dependsOnPriorStep: true` so
 * dry-run honestly DEFERS simulating them (they still depend on the combined step's real
 * effect) instead of misreporting a failure. A live send always runs every step for real, in
 * order, regardless of this flag.
 */
function buildDlmmZapInSteps(
  bundle: {
    setupTransaction?: Transaction;
    swapTransactions: Transaction[];
    ledgerTransaction: Transaction;
    zapInTransaction: Transaction;
    cleanUpTransaction: Transaction;
  },
  positionKeypair: Keypair
): OrderedTransactionStep[] {
  if (bundle.swapTransactions.length === 0) {
    const mergeable = [bundle.ledgerTransaction];
    if (bundle.setupTransaction) {
      mergeable.unshift(bundle.setupTransaction);
    }
    return [
      {
        label: bundle.setupTransaction
          ? 'setup + ledger (combined into one transaction)'
          : 'ledger update',
        tx: combineTransactions(mergeable),
        signers: [],
      },
      {
        label: 'zap in (initializes the new position)',
        tx: bundle.zapInTransaction,
        signers: [positionKeypair],
        dependsOnPriorStep: true,
      },
      {
        label: 'clean up',
        tx: bundle.cleanUpTransaction,
        signers: [],
        dependsOnPriorStep: true,
      },
    ];
  }

  // A real rebalancing swap is part of this bundle — keep steps separate (safe regardless of
  // transaction size) and defer dry-run simulation of whatever depends on it landing for real.
  const steps: OrderedTransactionStep[] = [];
  if (bundle.setupTransaction) {
    steps.push({
      label: 'setup (wrap SOL / create ATAs)',
      tx: bundle.setupTransaction,
      signers: [],
    });
  }
  bundle.swapTransactions.forEach((tx, i) => {
    steps.push({
      label: `rebalance swap ${i + 1}/${bundle.swapTransactions.length}`,
      tx,
      signers: [],
      dependsOnPriorStep: i > 0,
    });
  });
  steps.push({
    label: 'ledger update',
    tx: bundle.ledgerTransaction,
    signers: [],
    dependsOnPriorStep: true,
  });
  steps.push({
    label: 'zap in (initializes the new position)',
    tx: bundle.zapInTransaction,
    signers: [positionKeypair],
    dependsOnPriorStep: true,
  });
  steps.push({
    label: 'clean up',
    tx: bundle.cleanUpTransaction,
    signers: [],
    dependsOnPriorStep: true,
  });
  return steps;
}

/**
 * Zap OUT of an existing single-pool position into ONE output token: remove the wallet's
 * unlocked liquidity from its position, then convert whichever side isn't `outputMint` into
 * `outputMint`, atomically. Reads config.zapOut: protocol ("damm-v2" | "dlmm"), outputMint,
 * slippageBps.
 *
 * The remove-liquidity instruction(s) and the zap-out swap MUST land in the SAME on-chain
 * transaction (verified against the SDK's own examples/removeDammV2LiquidityAndZapOut.ts,
 * examples/removeDlmmLiquidityAndZapOut.ts, and tests/zapOutDammV2.test.ts): the swap reads a
 * balance DELTA (current on-chain balance minus a `preUserTokenBalance` snapshot taken when the
 * zap-out instruction was built) to know how much the preceding removal actually freed up.
 * Building the removal and the swap as two separate, sequentially-CONFIRMED transactions would
 * make that delta read as zero (the balance would already reflect the removal by the time the
 * swap tx is built) and swap nothing — so unlike zap-in, this is combined into one Transaction
 * per protocol branch rather than left as separate ordered steps (DLMM's `removeLiquidity` can
 * still return multiple transactions for wide positions; only the LAST one is combined with the
 * swap, and any earlier ones are sent first as their own ordered steps).
 */
export async function zapOut(
  config: ZapConfig,
  connection: Connection,
  wallet: Wallet,
  poolAddress: PublicKey
) {
  if (!config.zapOut) {
    throw new Error('Missing zapOut in configuration');
  }
  const { protocol, outputMint, slippageBps } = config.zapOut;

  console.log(`\n> Initializing Zap-out (${protocol})...`);
  await assertFunded(connection, wallet.publicKey);

  if (protocol === 'damm-v2') {
    await zapOutDammV2(
      config,
      connection,
      wallet,
      poolAddress,
      new PublicKey(outputMint),
      slippageBps
    );
  } else if (protocol === 'dlmm') {
    await zapOutDlmm(
      config,
      connection,
      wallet,
      poolAddress,
      new PublicKey(outputMint),
      slippageBps
    );
  } else {
    throw new Error(`zapOut.protocol must be "damm-v2" or "dlmm" (got "${protocol}")`);
  }
}

async function zapOutDammV2(
  config: ZapConfig,
  connection: Connection,
  wallet: Wallet,
  poolAddress: PublicKey,
  outputMint: PublicKey,
  slippageBps: number
) {
  const cpAmm = new CpAmm(connection);
  const poolState: PoolState = await cpAmm.fetchPoolState(poolAddress);

  if (!outputMint.equals(poolState.tokenAMint) && !outputMint.equals(poolState.tokenBMint)) {
    throw new Error(
      `zapOut.outputMint (${outputMint.toString()}) is not tokenA or tokenB of pool ` +
        `${poolAddress.toString()} (tokenA=${poolState.tokenAMint.toString()}, ` +
        `tokenB=${poolState.tokenBMint.toString()}).`
    );
  }

  const userPositions = await cpAmm.getUserPositionByPool(poolAddress, wallet.publicKey);
  if (userPositions.length === 0) {
    throw new Error(
      `Wallet ${wallet.publicKey.toString()} holds no position on pool ${poolAddress.toString()}.`
    );
  }
  let chosen = userPositions[0]!;
  if (userPositions.length > 1) {
    const selectedIndex = await promptForSelection(
      userPositions.map(
        (p, i) =>
          `Position ${i + 1}: ${p.position.toString()} (unlocked liquidity ${p.positionState.unlockedLiquidity.toString()})`
      ),
      'Multiple positions found on this pool — which one should be zapped out?'
    );
    chosen = userPositions[selectedIndex]!;
  }

  const liquidityToRemove = chosen.positionState.unlockedLiquidity;
  if (liquidityToRemove.isZero()) {
    throw new Error(
      `Position ${chosen.position.toString()} has no unlocked liquidity to remove (vested/locked ` +
        'liquidity is out of scope for zap-out).'
    );
  }
  console.log(`- Position ${chosen.position.toString()}`);
  console.log(`- Removing all unlocked liquidity: ${liquidityToRemove.toString()}`);

  const withdrawQuote = cpAmm.getWithdrawQuote({
    liquidityDelta: liquidityToRemove,
    sqrtPrice: poolState.sqrtPrice,
    minSqrtPrice: poolState.sqrtMinPrice,
    maxSqrtPrice: poolState.sqrtMaxPrice,
    collectFeeMode: poolState.collectFeeMode,
    tokenAAmount: poolState.tokenAAmount,
    tokenBAmount: poolState.tokenBAmount,
    liquidity: poolState.liquidity,
  });

  const currentPoint = await getCurrentPoint(connection, poolState.activationType);
  const tokenAProgram = getDammV2TokenProgram(poolState.tokenAFlag);
  const tokenBProgram = getDammV2TokenProgram(poolState.tokenBFlag);

  const removeLiquidityTx = await cpAmm.removeLiquidity({
    owner: wallet.publicKey,
    position: chosen.position,
    pool: poolAddress,
    positionNftAccount: chosen.positionNftAccount,
    liquidityDelta: liquidityToRemove,
    tokenAAmountThreshold: withdrawQuote.outAmountA,
    tokenBAmountThreshold: withdrawQuote.outAmountB,
    tokenAMint: poolState.tokenAMint,
    tokenBMint: poolState.tokenBMint,
    tokenAVault: poolState.tokenAVault,
    tokenBVault: poolState.tokenBVault,
    tokenAProgram,
    tokenBProgram,
    currentPoint,
    vestings: [],
  });

  const isOutputA = outputMint.equals(poolState.tokenAMint);
  const inputMint = isOutputA ? poolState.tokenBMint : poolState.tokenAMint;
  const estimatedAmountIn = isOutputA ? withdrawQuote.outAmountB : withdrawQuote.outAmountA;

  console.log(
    `- Expected removal: tokenA=${withdrawQuote.outAmountA.toString()} tokenB=${withdrawQuote.outAmountB.toString()}`
  );
  console.log(`- Output mint: ${outputMint.toString()}`);

  const zap = new Zap(connection);

  if (estimatedAmountIn.isZero()) {
    console.log('- Position is already single-sided in the output token — skipping the swap step.');
    await sendOrderedTransactions(
      connection,
      [{ label: 'remove liquidity', tx: removeLiquidityTx, signers: [] }],
      wallet.payer,
      config.dryRun,
      config.computeUnitPriceMicroLamports ?? 0,
      {
        // Idempotent: unlike zap-in, zap-out never mints a fresh keypair — a re-run re-reads
        // this SAME position's CURRENT unlocked liquidity from chain state, so it converges
        // (removes whatever is left) instead of repeating an already-landed removal.
        retrySafety: 'idempotent',
        recoveryAddress: chosen.position.toString(),
      }
    );
    return;
  }

  const currentSlot = await connection.getSlot();
  const currentTime = (await connection.getBlockTime(currentSlot)) ?? Math.floor(Date.now() / 1000);
  const tokenADecimal = await getDammV2TokenDecimals(
    connection,
    poolState.tokenAMint,
    tokenAProgram
  );
  const tokenBDecimal = await getDammV2TokenDecimals(
    connection,
    poolState.tokenBMint,
    tokenBProgram
  );

  const swapQuote = cpAmm.getQuote({
    inAmount: estimatedAmountIn,
    inputTokenMint: inputMint,
    slippage: slippageBps / 100,
    poolState,
    currentTime,
    currentSlot,
    tokenADecimal,
    tokenBDecimal,
  });

  const inputTokenProgram = isOutputA ? tokenBProgram : tokenAProgram;
  const outputTokenProgram = isOutputA ? tokenAProgram : tokenBProgram;

  const zapOutTx = await zap.zapOutThroughDammV2({
    user: wallet.publicKey,
    poolAddress,
    inputMint,
    outputMint,
    inputTokenProgram,
    outputTokenProgram,
    amountIn: estimatedAmountIn,
    minimumSwapAmountOut: swapQuote.minSwapOutAmount,
    maxSwapAmount: estimatedAmountIn,
    percentageToZapOut: 100,
  });

  const combinedTx = new Transaction().add(removeLiquidityTx).add(zapOutTx);

  await sendOrderedTransactions(
    connection,
    [
      {
        label: `remove liquidity + zap out to ${outputMint.toString()}`,
        tx: combinedTx,
        signers: [],
      },
    ],
    wallet.payer,
    config.dryRun,
    config.computeUnitPriceMicroLamports ?? 0,
    {
      retrySafety: 'idempotent',
      recoveryAddress: chosen.position.toString(),
    }
  );
}

async function zapOutDlmm(
  config: ZapConfig,
  connection: Connection,
  wallet: Wallet,
  poolAddress: PublicKey,
  outputMint: PublicKey,
  slippageBps: number
) {
  const dlmm = await DLMM.create(connection, poolAddress);

  if (!outputMint.equals(dlmm.lbPair.tokenXMint) && !outputMint.equals(dlmm.lbPair.tokenYMint)) {
    throw new Error(
      `zapOut.outputMint (${outputMint.toString()}) is not tokenX or tokenY of lbPair ` +
        `${poolAddress.toString()} (tokenX=${dlmm.lbPair.tokenXMint.toString()}, ` +
        `tokenY=${dlmm.lbPair.tokenYMint.toString()}).`
    );
  }

  const { userPositions } = await dlmm.getPositionsByUserAndLbPair(wallet.publicKey);
  if (userPositions.length === 0) {
    throw new Error(
      `Wallet ${wallet.publicKey.toString()} holds no position on lbPair ${poolAddress.toString()}.`
    );
  }
  let chosen = userPositions[0]!;
  if (userPositions.length > 1) {
    const selectedIndex = await promptForSelection(
      userPositions.map(
        (p, i) =>
          `Position ${i + 1}: ${p.publicKey.toString()} (bins ${p.positionData.lowerBinId}..${p.positionData.upperBinId}, ` +
          `x=${p.positionData.totalXAmount} y=${p.positionData.totalYAmount})`
      ),
      'Multiple positions found on this pool — which one should be zapped out?'
    );
    chosen = userPositions[selectedIndex]!;
  }

  const { positionData } = chosen;
  const totalXAmount = new BN(positionData.totalXAmount);
  const totalYAmount = new BN(positionData.totalYAmount);
  if (totalXAmount.isZero() && totalYAmount.isZero()) {
    throw new Error(`Position ${chosen.publicKey.toString()} has no liquidity to remove.`);
  }

  console.log(`- Position ${chosen.publicKey.toString()}`);
  console.log(
    `- Removing all liquidity: x=${totalXAmount.toString()} y=${totalYAmount.toString()}`
  );

  // skipUnwrapSOL: true — required whenever composing removeLiquidity with zap-sdk (per the
  // installed @meteora-ag/dlmm .d.ts's own removeLiquidity docstring) so the zap-out step below
  // reads the correct pre/post SOL balance delta instead of DLMM auto-unwrapping it first.
  const removeLiquidityTxs = await dlmm.removeLiquidity({
    position: chosen.publicKey,
    user: wallet.publicKey,
    fromBinId: positionData.lowerBinId,
    toBinId: positionData.upperBinId,
    bps: new BN(10_000), // 100% of this position's liquidity
    shouldClaimAndClose: true,
    skipUnwrapSOL: true,
  });
  if (removeLiquidityTxs.length === 0) {
    throw new Error(
      `dlmm.removeLiquidity returned no transactions for position ${chosen.publicKey.toString()}.`
    );
  }

  const isOutputX = outputMint.equals(dlmm.lbPair.tokenXMint);
  const inputMint = isOutputX ? dlmm.lbPair.tokenYMint : dlmm.lbPair.tokenXMint;
  const estimatedAmountIn = isOutputX ? totalYAmount : totalXAmount;
  const swapForY = !isOutputX; // input is X (swap X->Y) when output is Y, i.e. swapForY = !isOutputX

  console.log(`- Output mint: ${outputMint.toString()}`);

  const steps: OrderedTransactionStep[] = removeLiquidityTxs
    .slice(0, -1)
    .map((tx, i): OrderedTransactionStep => ({
      label: `remove liquidity (${i + 1}/${removeLiquidityTxs.length})`,
      tx,
      signers: [],
    }));
  const lastRemoveLiquidityTx = removeLiquidityTxs[removeLiquidityTxs.length - 1]!;

  if (estimatedAmountIn.isZero()) {
    console.log('- Position is already single-sided in the output token — skipping the swap step.');
    steps.push({
      label: `remove liquidity (${removeLiquidityTxs.length}/${removeLiquidityTxs.length})`,
      tx: lastRemoveLiquidityTx,
      signers: [],
    });
    await sendOrderedTransactions(
      connection,
      steps,
      wallet.payer,
      config.dryRun,
      config.computeUnitPriceMicroLamports ?? 0,
      {
        // Idempotent: no fresh keypair is ever minted, and a re-run re-reads THIS position's
        // current remaining liquidity from chain state, so it converges instead of repeating
        // an already-landed removal.
        retrySafety: 'idempotent',
        recoveryAddress: chosen.publicKey.toString(),
      }
    );
    return;
  }

  const binArrays = await dlmm.getBinArrayForSwap(swapForY);
  const swapQuote = dlmm.swapQuote(estimatedAmountIn, swapForY, new BN(slippageBps), binArrays);

  const { tokenXProgram, tokenYProgram } = getTokenProgramId(dlmm.lbPair);
  const inputTokenProgram = isOutputX ? tokenYProgram : tokenXProgram;
  const outputTokenProgram = isOutputX ? tokenXProgram : tokenYProgram;

  const zap = new Zap(connection);
  const zapOutTx = await zap.zapOutThroughDlmm({
    user: wallet.publicKey,
    lbPairAddress: poolAddress,
    inputMint,
    outputMint,
    inputTokenProgram,
    outputTokenProgram,
    amountIn: estimatedAmountIn,
    minimumSwapAmountOut: swapQuote.minOutAmount,
    maxSwapAmount: estimatedAmountIn,
    percentageToZapOut: 100,
  });

  const combinedTx = new Transaction().add(lastRemoveLiquidityTx).add(zapOutTx);
  steps.push({
    label: `remove liquidity (${removeLiquidityTxs.length}/${removeLiquidityTxs.length}) + zap out to ${outputMint.toString()}`,
    tx: combinedTx,
    signers: [],
  });

  await sendOrderedTransactions(
    connection,
    steps,
    wallet.payer,
    config.dryRun,
    config.computeUnitPriceMicroLamports ?? 0,
    {
      retrySafety: 'idempotent',
      recoveryAddress: chosen.publicKey.toString(),
    }
  );
}
