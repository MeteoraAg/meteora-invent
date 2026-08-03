import { Connection, PublicKey, Keypair, Transaction } from '@solana/web3.js';
import { Wallet } from '@coral-xyz/anchor';
import { Zap } from '@meteora-ag/zap-sdk';
import {
  CpAmm,
  getTokenProgram as getDammV2TokenProgram,
  getTokenDecimals as getDammV2TokenDecimals,
  getCurrentPoint,
  type PoolState,
} from '@meteora-ag/cp-amm-sdk';
import DLMM, { getTokenProgramId } from '@meteora-ag/dlmm';
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

  // Resolve the position to deposit into.
  let positionNftMint: PublicKey;
  const preambleSteps: OrderedTransactionStep[] = [];

  if (positionMode === 'new') {
    const positionNftKeypair = Keypair.generate();
    positionNftMint = positionNftKeypair.publicKey;

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
  console.log('>>> Save this — it identifies the position this zap deposited into.');

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
    });
  });
  steps.push({ label: 'ledger update', tx: bundle.ledgerTransaction, signers: [] });
  steps.push({ label: 'zap in', tx: bundle.zapInTransaction, signers: [] });
  steps.push({ label: 'clean up', tx: bundle.cleanUpTransaction, signers: [] });

  await sendOrderedTransactions(
    connection,
    steps,
    wallet.payer,
    config.dryRun,
    config.computeUnitPriceMicroLamports ?? 0
  );
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
      config.computeUnitPriceMicroLamports ?? 0
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
    config.computeUnitPriceMicroLamports ?? 0
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
      config.computeUnitPriceMicroLamports ?? 0
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
    config.computeUnitPriceMicroLamports ?? 0
  );
}
