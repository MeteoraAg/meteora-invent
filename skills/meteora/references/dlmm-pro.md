# DLMM Pro — Tick-Based Concentrated Liquidity

> **Source of truth:** `@meteora-ag/dlmm-pro-sdk@0.1.4` (github.com/MeteoraAg/dlmm-pro-sdk,
> per-function reference in `docs.md`) — as of 2026-11-25. DLMM Pro is in beta: read the
> SDK `CHANGELOG.md` before trusting a snippet against a newer version.
> Program ID (mainnet **and** devnet): `dPro1D5wiqnGMH8vMDG23jh35btTHoWdyqXjqkqxe8n`
> Access registry (token badges): `regUFehW9oycnaV2auYyfqyYjKG1W1uLNT7rtUeemQr`
> Deps: web3.js v1 (^1.98), Anchor 0.32, `bn.js`, `decimal.js`, `@solana/spl-token` 0.4.
> TypeScript: the types resolve under `Bundler`, `Node16` and `NodeNext`, from ES modules and
> CommonJS (0.1.4+; earlier versions lose the enums and types under `Node16`/`NodeNext`).
> **DLMM Pro is a separate program from DLMM — bins, `@meteora-ag/dlmm` and DLMM pool
> addresses do not apply here.**

## Mental model

Prices sit on **ticks**: tick `i` has price `1.0001^i`, in atoms of token Y per atom of
token X. A pool's **tick spacing** (1–256) sets which ticks range edges and orders can use.
A **position** is a Token 2022 NFT holding up to 45 **ranges**, each `[tickLowerId,
tickUpperId)` with its own liquidity, fees and rewards; a liquidity shape (`Spot`, `Curve`,
`BidAsk`, `Wave`) is just a set of weighted ranges. A **limit order** is also an NFT, with up
to 25 ticks on one side: an ask sells X above the current tick, a bid buys X with Y at or
below it. Orders share tick state with LP liquidity, fill at the exact tick price, and earn a
share of the fee.

Pools are created three ways, and nothing about a pool can be changed afterwards:

| | Static config | Launch pool | Dynamic config |
|---|---|---|---|
| Settings come from | A published config (index) | The creator | The creator |
| Who can create | Anyone | Anyone holding both tokens | The config's authority (issued by Meteora) |
| Pools per pair | One per config | One | One per config |
| Activation rules | No | Yes | Yes |

Fees: a base fee (`Fixed`, time scheduler, or market cap scheduler; 0.01%–99%) plus an
optional dynamic fee, collected in the output token or always in token Y (`OnlyY`).
Extensions, fixed at creation: `LiquidityMining` (two reward slots) and `ActivationAccess`
(open swaps, deposits and withdrawals at set times or once price hits a target, with one
whitelisted wallet per action).

Studio actions (ACT path): `dlmm-pro-create-pool`, `dlmm-pro-open-position`,
`dlmm-pro-remove-liquidity`, `dlmm-pro-lock-position`, `dlmm-pro-claim-fees`,
`dlmm-pro-get-positions`, `dlmm-pro-swap`, `dlmm-pro-place-limit-order`,
`dlmm-pro-get-limit-orders`, `dlmm-pro-cancel-limit-order`. Template:
`configs/dlmm_pro_config.jsonc`. **Not in the studio (BUILD path):** adding to an existing
position, resizing ranges, compounding fees, delegates, reward campaigns, partner fee claims.

## Client setup

```ts
import { Connection, PublicKey } from '@solana/web3.js'
import { DlmmProClient } from '@meteora-ag/dlmm-pro-sdk'   // named export, no default
import BN from 'bn.js'

const connection = new Connection(RPC_URL, 'confirmed')
const client = new DlmmProClient(connection)   // optional: commitment, programId
const pool = new PublicKey(POOL_ADDRESS)
const poolState = await client.state.fetchPool(pool)   // re-fetch before every quote/build
```

Services: `client.pool`, `client.position`, `client.limitOrder`, `client.reward` build
transactions; `client.state` reads accounts. Nothing is cached — every builder reads what it
needs at call time.

**Every builder returns `{ tx, ... }`**: an unsigned legacy `Transaction` with `feePayer`
set and **no blockhash** (`sendAndConfirmTransaction` fills it in). New NFT mints (positions,
limit orders) are **extra signers**. Missing associated token accounts are created, and
native SOL is wrapped and unwrapped, inside the same transaction.

## Method map

| Category | Methods |
|---|---|
| Pool creation | `pool.initializePoolWithStaticConfig` · `pool.initializeLaunchPool` · `pool.initializePoolWithDynamicConfig` → `{ tx, pool, ... }` |
| Swap | `pool.quoteExactIn({ pool, inputAmount, swapForY, swapper })` → `{ quote, tickArrays, tickArrayBitmapExtension }` → `pool.swap({...})` (exact-in only) |
| Positions | `position.openPosition` (empty) · `addLiquidity` (explicit liquidity) · `addLiquidityByWeight` (shape) · `addLiquidityImbalance` (one slot, from wallet balances) · `expandPosition` / `removePosition` (add/delete ranges) |
| Remove/close | `position.removeLiquidity` · `removeLiquidityByBps({ parameters: { bps, bitmap: null, ... } })` · `closePosition` (every range must be empty) |
| Fees/rewards | `position.getClaimableFees({ pool, nftMint })` → `{ feeX, feeY, bitmap, tickRanges, slots }` · `position.claimFee` · `position.compoundFees` · `reward.claimReward` |
| Locks | `position.lockPermanentPosition({ bps })` · `position.lockVestingPosition({ parameters })` — owner only, one vesting schedule per position |
| Limit orders | `limitOrder.openLimitOrder` · `cancelLimitOrder` (defaults to every open tick) · `closeLimitOrder` (after every tick is cancelled) |
| Rewards (creator/authority) | `reward.initializeReward` · `setRewardEmission` · `updateRewardAuthority` · `withdrawIneligibleRewards` |
| Pool upkeep | `pool.initializeTickArray` · `initializeTickBitmapExtension` · `increaseOracleLength` · `claimPartnerFee` |
| Reads | `state.fetchPool` · `fetchPoolWithExtensions` (rewards, activation) · `fetchPositionArrayWithPositions(derivePosition(nftMint), { withReward })` · `decodeLimitOrderData(deriveLimitOrder(nftMint))` · `fetchTickArraysWithTicks` · `fetchStaticConfig(deriveStaticConfig(index))` |
| Shapes | `buildLiquidityShape` · `multiplierFromAmounts` · `encodeAddLiquidityByWeight` · `amountsFromShape` · `limitOrderTicksFromShape` · `relativeTickFromSlippage` |
| Tick/price math | `getSqrtPriceFromTickId` · `tickIdFromSqrtPrice` · `tickUiPrice(tickId, decimalsX, decimalsY)` · `isUsableTickId` · `getLiquidityFromAmounts` · `getAmountsFromLiquidity` |
| Fee/activation builders | `fixedBaseFeeParameters(bps)` · `timeSchedulerBaseFeeParameters` · `marketCapSchedulerBaseFeeParameters` · `baseFeeParameters` (picks by mode) · `getDynamicFeeParams(baseFeeBps, tickSpacing)` · `openActivationParameters` · `bondingCurveActivationParameters` · `timeBasedActivationParameters` |
| PDAs | `derivePool(config, x, y)` · `deriveLaunchPool(x, y)` · `derivePosition(nftMint)` · `deriveLimitOrder(nftMint)` · `deriveStaticConfig(index)` · `deriveDynamicConfig(authority, index)` · `deriveTokenBadge(mint)` |

## Core flow: quote + swap

```ts
const swapForY = true                              // true: sell X for Y; false: buy X with Y
const inputAmount = new BN(1_000_000)              // base units of the INPUT token

const { quote, tickArrays, tickArrayBitmapExtension } = await client.pool.quoteExactIn({
  pool, inputAmount, swapForY, swapper: wallet.publicKey,
})
// The program reverts unless the swap consumes the whole input.
if (!quote.amountLeft.isZero()) throw new Error('Not enough liquidity for this input')

const { tx } = await client.pool.swap({
  pool,
  tokenXMint: poolState.tokenXMint,
  tokenYMint: poolState.tokenYMint,
  user: wallet.publicKey,
  swapForY,
  tickArrays,                                      // from the quote, in traversal order
  tickArrayBitmapExtension,
  parameters: {
    inputAmount,
    minimumOutputAmount: quote.transferFeeExcludedOutAmount.muln(9_900).divn(10_000), // 1%
  },
})
await sendAndConfirmTransaction(connection, tx, [wallet])
```

`quote.transferFeeExcludedOutAmount` is what the swapper receives; size `minimumOutputAmount`
from it. `quoteExactIn` throws `PoolError` `LiquidityIsZero` when no liquidity lies in the
swap direction and `InvalidActivationAccess` before the pool opens for `swapper`.

## Core flow: open position + add liquidity

```ts
import {
  LiquidityLayout, StrategyType, buildLiquidityShape, encodeAddLiquidityByWeight,
  getTokenProgram, multiplierFromAmounts, readClock,
} from '@meteora-ag/dlmm-pro-sdk'
import { getMint } from '@solana/spl-token'
import { Keypair, sendAndConfirmTransaction } from '@solana/web3.js'

const { tickSpacing, tickCurrentId, sqrtPrice } = poolState
const aligned = Math.floor(tickCurrentId / tickSpacing) * tickSpacing

// 1. Shape: weighted ranges over usable ticks. Its ranges become the position's slots.
const shape = buildLiquidityShape({
  strategy: StrategyType.Curve,                    // Spot | Curve | BidAsk | Wave
  minTickId: aligned - 20 * tickSpacing,           // first column
  maxTickId: aligned + 20 * tickSpacing,           // last column (covers up to maxTickId + tickSpacing)
  tickSpacing,
  currentTickId: tickCurrentId,
  layout: LiquidityLayout.Horizontal,              // fewer ranges for Curve/BidAsk
  maxRanges: 10,                                   // coarsen to fit; hard cap is 45
})

// 2. Open the position NFT (the nft keypair signs once).
const nft = Keypair.generate()
const opened = await client.position.openPosition({
  pool, owner: wallet.publicKey, payer: wallet.publicKey,
  nftMint: nft.publicKey, tickRanges: shape.ranges,
})
await sendAndConfirmTransaction(connection, opened.tx, [wallet, nft])

// 3. Size the deposit to both budgets (transfer fees included), then deposit by weight.
const [mintX, mintY] = await Promise.all([
  getMint(connection, poolState.tokenXMint, 'confirmed', getTokenProgram(poolState.tokenXFlag)),
  getMint(connection, poolState.tokenYMint, 'confirmed', getTokenProgram(poolState.tokenYFlag)),
])
const amountX = new BN(1_000_000_000)
const amountY = new BN(100_000_000)
const multiplier = multiplierFromAmounts({
  ranges: shape.ranges, tickSpacing, currentTickId: tickCurrentId, currentSqrtPrice: sqrtPrice,
  amountX, amountY, mintX, mintY, epoch: (await readClock(connection)).epoch,
})
const added = await client.position.addLiquidityByWeight({
  pool, nftMint: nft.publicKey, owner: wallet.publicKey, signer: wallet.publicKey,
  tokenXMint: poolState.tokenXMint, tokenYMint: poolState.tokenYMint,
  tickRanges: shape.ranges,
  parameters: encodeAddLiquidityByWeight({
    ranges: shape.ranges, maxAmountX: amountX, maxAmountY: amountY, multiplier,
  }),
})
await sendAndConfirmTransaction(connection, added.tx, [wallet])
```

A range above the current tick takes only X, a range at or below it only Y, a range around
it both — `multiplierFromAmounts` throws `InvalidParameters` when a needed side has no
budget. Strategy choice: `Spot` = even · `Curve` = concentrated at the price · `BidAsk` =
weighted to the edges · `Wave` = even near the price, rising to the edges (at most 9 ranges).

## Core flow: claim fees / read positions / exit

```ts
import { PoolExtension, derivePosition, isSupportExtension } from '@meteora-ag/dlmm-pro-sdk'

const withReward = isSupportExtension(poolState.extensions, PoolExtension.LiquidityMining)
const { positionArray, positions } = await client.state.fetchPositionArrayWithPositions(
  derivePosition(nftMint), { withReward },         // withReward MUST match the pool
)
// positions[i]: { tickLowerId, tickUpperId, unlockedLiquidity, permanentLockedLiquidity,
//                 vestingLiquidity, feePendingX/Y, ... }

const accounts = {
  pool, nftMint, owner: wallet.publicKey, signer: wallet.publicKey,
  tokenXMint: poolState.tokenXMint, tokenYMint: poolState.tokenYMint,
}
const claimable = await client.position.getClaimableFees({ pool, nftMint })  // feeX, feeY: BN
const claimed = await client.position.claimFee({
  ...accounts, bitmap: claimable.bitmap, tickRanges: claimable.tickRanges,
})

// Exit: withdraw 100% of the unlocked liquidity of every range, claim, then close.
const tickRanges = positions.map(({ tickLowerId, tickUpperId }) => ({ tickLowerId, tickUpperId }))
const removed = await client.position.removeLiquidityByBps({
  ...accounts, tickRanges,
  parameters: {
    minAmountX: new BN(0), minAmountY: new BN(0),  // set real minimums on mainnet
    expectedLayoutVersion: positionArray.layoutVersion, bps: 10_000, bitmap: null,
  },
})
const closed = await client.position.closePosition({
  pool, owner: wallet.publicKey, nftMint, rentReceiver: wallet.publicKey, tickRanges,
})
```

`closePosition` fails with `PositionIsNotEmpty` while any range holds liquidity, unclaimed
fees or unclaimed rewards — remove, `claimFee`, and `reward.claimReward` for every
initialized reward slot first. Permanently locked liquidity can never be withdrawn.

**Finding a wallet's positions and orders:** there is no index by owner. Read the wallet's
Token 2022 accounts holding exactly 1 token of a 0-decimal mint, then check which mints have
a program-owned account at `derivePosition(mint)` / `deriveLimitOrder(mint)` and compare its
`pool` field. Decode ranges only after the pool matches (`withReward` differs per pool).

## Limit orders

```ts
const nft = Keypair.generate()
const { tx, limitOrder } = await client.limitOrder.openLimitOrder({
  pool, nftMint: nft.publicKey, owner: wallet.publicKey, payer: wallet.publicKey,
  tokenMint: poolState.tokenYMint,                 // bid pays in Y; an ask pays in X
  parameters: {
    isAskSide: false,
    maxAmount: new BN(500_000_000),                // cap on the deposit, transfer fee included
    relativeTick: null,                            // null = ticks[].id are absolute tick ids
    ticks: [{ id: aligned - 2 * tickSpacing, amount: new BN(500_000_000) }],  // 1..25, ascending
  },
})
await sendAndConfirmTransaction(connection, tx, [wallet, nft])   // nft keypair signs

// Later: cancel every open tick (collects unfilled deposit + proceeds + fee share), then close.
const cancelled = await client.limitOrder.cancelLimitOrder({
  pool, nftMint: nft.publicKey, owner: wallet.publicKey, signer: wallet.publicKey,
  tokenXMint: poolState.tokenXMint, tokenYMint: poolState.tokenYMint,
})
const closedOrder = await client.limitOrder.closeLimitOrder({
  pool, nftMint: nft.publicKey, owner: wallet.publicKey, rentReceiver: wallet.publicKey,
})
```

Tick ids must be usable ticks (multiples of the tick spacing). A bid must sit at or below the
current tick and an ask strictly above it when the transaction lands, or the program rejects
it with `InvalidParameters`. For orders that should follow the price, build ticks with
`limitOrderTicksFromShape({ relative: true })` and pass `relativeTickFromSlippage(...)` as
`relativeTick`. Fill state is on the tick, not the order: compare the tick's `orderAge` with
the order's `age` (0 = resting, 1 = being filled, 2+ = filled; SDK `docs.md` has the
arithmetic). **Proceeds and fees are only paid out by `cancelLimitOrder`.**

## Pool creation

```ts
import {
  ActivationType, CollectFeeMode, PoolExtension, deriveStaticConfig, encodePoolExtensions,
  fixedBaseFeeParameters, getDynamicFeeParams, getSqrtPriceFromTickId,
} from '@meteora-ag/dlmm-pro-sdk'

// Price is token Y per token X in ATOMS: scale a UI price by 10^(decimalsY - decimalsX).
const atomPrice = uiPrice * 10 ** (decimalsY - decimalsX)
const tick = Math.floor(Math.log(atomPrice) / Math.log(1.0001) / tickSpacing) * tickSpacing
const initialSqrtPrice = getSqrtPriceFromTickId(tick)

// A. Static config: the config fixes tick spacing, fees, fee token and extensions.
const fromStatic = await client.pool.initializePoolWithStaticConfig({
  config: deriveStaticConfig(60),                  // 60 = tick spacing 32, fixed 0.25%
  tokenXMint, tokenYMint, creator: wallet.publicKey, payer: wallet.publicKey, initialSqrtPrice,
})

// B. Launch pool: no config, the payer must hold a non-zero balance of both tokens.
const launched = await client.pool.initializeLaunchPool({
  tokenXMint, tokenYMint, creator: wallet.publicKey, payer: wallet.publicKey,
  parameters: {
    poolFees: {
      baseFeeParameter: fixedBaseFeeParameters(25),             // 0.25%
      dynamicFeeParameter: getDynamicFeeParams(25, tickSpacing), // or null
    },
    tickSpacing,
    collectFeeMode: CollectFeeMode.OutputToken,
    initialSqrtPrice,
    activationType: ActivationType.Timestamp,
    activationPoint: null,                         // only with a TimeBased activation slot
    extensions: encodePoolExtensions([PoolExtension.LiquidityMining]),
    poolActivation: null,                          // required with ActivationAccess
  },
})
// both: { tx, pool, ... }; signer: payer
```

- **Make the launched token X and the quote token Y.** Price is Y per X, and bonding-curve
  targets and market cap fee schedulers react to that price rising.
- Start on a usable tick (as above): a position that begins at the initial price then needs
  only token X, which is how a new token is seeded.
- Static configs: 1,848 public configs, same addresses on mainnet and devnet,
  `index = 924 × extension + 132 × schedule + 4 × tier + variant`. Table and addresses:
  https://docs.meteora.ag/developer-guides/dlmm-pro/pool-fee-configs.md
- `OnlyY` needs token Y to be wrapped SOL, USDC, or a mint with a token badge
  (`tokenBadgeY: deriveTokenBadge(mint)`), else `InvalidTokenBadge`. Token 2022 mints with
  extensions beyond transfer fee / metadata need a badge too (`UnsupportedMint`).
- A new pool has no liquidity: quotes throw `LiquidityIsZero` until a position is funded.

## Gotchas

- **No compute budget is added by any builder.** A position with many ranges, or a
  transaction that creates tick arrays, passes the default 200,000 compute units. Simulate,
  then `tx.instructions.unshift(ComputeBudgetProgram.setComputeUnitLimit({ units }),
  ComputeBudgetProgram.setComputeUnitPrice({ microLamports }))` — budget instructions go
  first.
- **Transaction size:** every distinct tick array a transaction touches is one more account.
  Ranges or order ticks spread over a wide price span can exceed 1,232 bytes — use fewer
  ranges/ticks or a narrower span, or open small and grow with `expandPosition`.
- `expandPosition` / `removePosition` change `layoutVersion`; pass the version you read as
  `expectedLayoutVersion` so a stale slot index fails instead of hitting the wrong range.
- Errors: builders throw `PoolError` with a `code` from `PoolErrorCode`, which uses the
  program's numbering — `PoolErrorCode[6020]` is `"NotConsumingFullAmountIn"` for a failed
  transaction's `{ Custom: 6020 }`.
- `tickPrice` / `tickUiPrice` keep full precision at every tick from 0.1.4. In 0.1.3 and
  earlier they lost precision below about tick -200,000.
- Amounts are `BN` base units everywhere; `emissionPerSecond` for rewards is Q64.64.
- Operator and admin instructions are not wrapped; build them with
  `client.program.methods.<instruction>(...)`.
- `CollectFeeMode` here = `{ OutputToken=0, OnlyY=1 }` — not the DLMM/DBC/CP-AMM enums.

## Deep links

- SDK repo: `docs.md` (every function, parameters, errors), `README.md`, `CHANGELOG.md`, `tests/`
- https://docs.meteora.ag/core-products/dlmm-pro/what-is-dlmm-pro.md
- https://docs.meteora.ag/developer-guides/dlmm-pro/typescript-sdk/getting-started.md
- https://docs.meteora.ag/developer-guides/dlmm-pro/typescript-sdk/examples.md (complete scripts for every flow)
- https://docs.meteora.ag/developer-guides/dlmm-pro/program/errors.md
- Studio actions: `studio-actions.md` §DLMM Pro · config template: `configs/dlmm_pro_config.jsonc`
