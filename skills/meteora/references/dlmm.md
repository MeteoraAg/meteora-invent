# DLMM — Dynamic Liquidity Market Maker

> **Source of truth:** `@meteora-ag/dlmm@1.9.14` (github.com/MeteoraAg/dlmm-sdk, TS client in
> `ts-client/`) — verified against SDK source 2026-08-01.
> Program ID (mainnet **and** devnet): `LBUZKhRxPF3XUpBCjp4YzTKgLccjZhTSDM9YuVaPwxo`
> Deps: web3.js v1 (^1.91), Anchor 0.31, `bn.js`, `decimal.js`.
> ⚠️ The SDK README's "Static functions" table lists `createPermissionLbPair`,
> `getClaimableLMReward`, `getClaimableSwapFee` — **these don't exist**. Trust this file,
> the source, and `ts-client/src/examples/` over the README tables.

## Mental model

Liquidity lives in discrete **bins**; each bin is a price point (`binStep` bps apart). The
**active bin** earns fees; deposits spread across a bin range via a **strategy**
(`Spot` = uniform, `Curve` = concentrated around active, `BidAsk` = edges). Positions span
up to 1400 bins (wide ranges = multiple txs/positions). Fees are dynamic (base + volatility).
Pools created with `ConcreteFunctionType.LimitOrder` (default) also accept **limit orders**
that fill as price crosses their bins.

Studio actions (ACT path): `dlmm-create-pool`, `dlmm-seed-liquidity-lfg`,
`dlmm-seed-liquidity-single-bin`, `dlmm-set-pool-status`, `dlmm-place-limit-order`,
`dlmm-get-limit-orders`, `dlmm-cancel-limit-order`. Template: `configs/dlmm_config.jsonc`.
**No studio swap / claim-fees / add-to-existing-position** — those are BUILD path.

## Client setup

```ts
import { Connection, PublicKey } from '@solana/web3.js'
import DLMM from '@meteora-ag/dlmm'          // default export; StrategyType etc. are named exports
import BN from 'bn.js'

const connection = new Connection(RPC_URL, 'confirmed')
const dlmm = await DLMM.create(connection, new PublicKey(POOL_ADDRESS))
// multiple pools: DLMM.createMultiple(connection, [pk1, pk2, ...])
// devnet: pass { cluster: 'devnet' } as the third arg
```

The instance caches pool state from creation time — call `await dlmm.refetchStates()`
before quoting/building if the instance is not fresh.

## Method map

| Category | Methods (instance unless marked static) |
|---|---|
| Pool creation (static) | `DLMM.createLbPair2` (preset params v2) · `DLMM.createCustomizablePermissionlessLbPair2` (custom fee/activation/alpha-vault; prefer the `2` variants — token-2022 aware) · `DLMM.getAllPresetParameters` · `DLMM.getPairPubkeyIfExists` |
| Positions | `createEmptyPosition` · `initializePositionAndAddLiquidityByStrategy` · `addLiquidityByStrategy` · `addLiquidityByStrategyChunkable` (wide) · `initializeMultiplePositionAndAddLiquidityByStrategy2` (wide+parallel) · `increasePositionLength` / `decreasePositionLength` |
| Remove/close | `removeLiquidity({ user, position, fromBinId, toBinId, bps: BN (0–10000; 10000 = 100%), shouldClaimAndClose? })` → **`Transaction[]`** · `closePosition` · `closePositionIfEmpty` |
| Swap | `getBinArrayForSwap(swapForY, count=4)` → `swapQuote(inAmount, swapForY, allowedSlippageBps: BN, binArrays, isPartialFill?, maxExtraBinArrays≤3)` → `swap({...})`; also `swapQuoteExactOut`/`swapExactOut`, `swapWithPriceImpact` |
| Limit orders | `quoteCreateLimitOrder` · `placeLimitOrder` · `cancelLimitOrder` · `closeLimitOrderIfEmpty` · `getLimitOrderByUserAndLbPair(user)` · static `DLMM.getLimitOrdersByUserAndTokenAddress` — only on pools where `isSupportLimitOrder(lbPairState)` |
| Fees/rewards | `claimSwapFee` / `claimAllSwapFee` · `claimLMReward` / `claimAllLMRewards` · `claimAllRewardsByPosition` · `claimAllRewards` — all return **`Transaction[]`**; throw `"No fee to claim"` when empty (wrap in try/catch) |
| Rebalance (1.6+) | `simulateRebalancePositionWithBalancedStrategy` → `rebalancePosition(response, maxActiveBinSlippage)` · `quoteExtendPosition` · `quoteCreatePosition` |
| Seeding | `seedLiquidity` (LFG curve) · `seedLiquiditySingleBin` — used by the studio seed actions |
| Admin | `setActivationPoint` · `setPairStatus(Permissionless)` · `syncWithMarketPrice` · `increaseOracleLength` · `getOracle()` (TWAP, 1.9.5+) |
| Reads | `getActiveBin()` · `getBinsAroundActiveBin` · `getBinsBetweenMinAndMaxPrice` · `getFeeInfo()` · `getDynamicFee()` · `getPosition(pubkey)` · `getPositionsByUserAndLbPair(user)` · static `DLMM.getAllLbPairPositionsByUser(connection, user)` · static `DLMM.getPositionsByUserAndTokenAddress` (1.9.13) · `getLbPairLockInfo` |
| Price/bin math | `DLMM.getPricePerLamport(xDec, yDec, price)` · `DLMM.getBinIdFromPrice(price, binStep, min)` · instance `toPricePerLamport` / `fromPricePerLamport` · helper `getPriceOfBinByBinId` (standalone export, not a method) |

## Core flow: quote + swap (verified from SDK examples)

```ts
const swapForY = true                            // true: sell X for Y; false: buy X with Y
const binArrays = await dlmm.getBinArrayForSwap(swapForY)

const quote = dlmm.swapQuote(
  new BN(5_000 * 10 ** 6),   // in amount, base units of the input token
  swapForY,
  new BN(10),                // allowed slippage in bps
  binArrays,
  false,                     // isPartialFill
  3,                         // maxExtraBinArrays (0..3)
)
// { consumedInAmount, outAmount, minOutAmount, priceImpact, fee, protocolFee, binArraysPubkey, endPrice }

const swapTx = await dlmm.swap({
  inToken: dlmm.tokenX.publicKey,               // swapForY: in = X, out = Y
  outToken: dlmm.tokenY.publicKey,
  inAmount: new BN(5_000 * 10 ** 6),
  minOutAmount: quote.minOutAmount,
  lbPair: dlmm.pubkey,
  user: wallet.publicKey,
  binArraysPubkey: quote.binArraysPubkey,
})
```

## Core flow: open position + add liquidity (verified from SDK README/tests)

```ts
import { StrategyType } from '@meteora-ag/dlmm'
import { Keypair, sendAndConfirmTransaction } from '@solana/web3.js'

const activeBin = await dlmm.getActiveBin()
const RANGE = 10                                  // bins each side (≤ default position width)
const minBinId = activeBin.binId - RANGE
const maxBinId = activeBin.binId + RANGE

const positionKp = new Keypair()
const createTx = await dlmm.initializePositionAndAddLiquidityByStrategy({
  positionPubKey: positionKp.publicKey,
  user: wallet.publicKey,
  totalXAmount: new BN(100 * 10 ** X_DECIMALS),
  totalYAmount: new BN(0.5 * 10 ** 9),
  strategy: { minBinId, maxBinId, strategyType: StrategyType.Spot },
})
await sendAndConfirmTransaction(connection, createTx, [wallet, positionKp])  // position kp signs
```

Strategy choice: `Spot` = uniform (safe default, stable pairs) · `Curve` = concentrated
around active bin (max fees, calm markets) · `BidAsk` = weighted to edges (volatility /
DCA). Wide ranges (> ~69 bins): use `initializeMultiplePositionAndAddLiquidityByStrategy2`.
Bin-step heuristic when creating pools (rule of thumb): stables 1–10, majors 10–25,
mid-caps 25–100, new/volatile tokens 80–400.

## Core flow: claim fees / read positions

```ts
const { userPositions } = await dlmm.getPositionsByUserAndLbPair(wallet.publicKey)
// positionData: { totalXAmount/totalYAmount: string (base-unit decimal strings),
//                 feeX/feeY: BN, rewardOne/rewardTwo, lowerBinId/upperBinId, positionBinData }

const claimTxs = await dlmm.claimAllSwapFee({ owner: wallet.publicKey, positions: userPositions })
for (const tx of claimTxs) await sendAndConfirmTransaction(connection, tx, [wallet])
```

Cross-pool: `DLMM.getAllLbPairPositionsByUser(connection, user)` → `Map<poolAddress, PositionInfo>`.

## Limit orders

```ts
const rentQuote = await dlmm.quoteCreateLimitOrder({ bins: [{ id: binId }] })
// placeLimitOrder({ owner, payer, sender, limitOrder: newLimitOrderPubkey,
//                   params: { bins, isAskSide, relativeBin } })
// cancelLimitOrder({ limitOrderPubkey, owner, rentReceiver, binIds })  — withdraws fills + fees
```

Only on pools created with the limit-order function type (studio default
`concreteFunctionType: 0`). Guard with `isSupportLimitOrder(dlmm.lbPair)`. Max 50 bins/order
(studio) — SDK constant `MAX_BIN_PER_LIMIT_ORDER`. Prices snap to bins (converted via the
pool's binStep) — check the resolved bin IDs in the rent quote / dry run before committing.
**Fees earned inside a limit order are only recovered by cancelling it** — position
fee-claim methods don't touch limit-order fees.

## Version fences

- `removeLiquidity`, `claimSwapFee`, `claimLMReward` return **`Transaction[]`** since 1.6.0 — iterate, don't send a single tx.
- Position v1 removed (1.9.8); only PositionV2/extended positions exist. `updateBinArray` gone.
- `createCustomizablePermissionlessLbPair(2)` and `getPairPubkeyIfExists` take `concreteFunctionType` + `collectFeeMode` params since 1.9.8 — omitting them on lookups can miss the pair.
- `swapQuote` no longer takes a `swapInitiator` arg; current tail is `binArrays, isPartialFill?, maxExtraBinArrays` (throws above 3).
- Renames: `setActivationSlot` → `setActivationPoint`; `swapQuoteAtBin` → `swapExactInQuoteAtBin`; `admin` → `signer` in pair-status methods. `removeLiquiditySingleSide` removed.
- `getBinArraysRequiredByPositionRange` deprecated (1.9.14) → use `...Range2` for v2 liquidity instructions.
- `createLbPair2` needs a **presetParameter2** account (v1 presets are a separate list).
- `CollectFeeMode` here = `{ InputOnly=0, OnlyY=1 }` — not the DBC/CP-AMM enums.
- The ts-client compiles with `strictNullChecks: false` — expect `| null` surprises in strict consumer projects.

## Deep links

- SDK repo: `ts-client/README.md` (recipes; ignore its stale static-methods table), `ts-client/src/examples/`, `ts-client/scripts/*.s.ts`, `ts-client/src/test/`
- https://docs.meteora.ag/core-products/dlmm/what-is-dlmm.md
- https://docs.meteora.ag/developer-guides/dlmm/typescript-sdk/getting-started.md
- Data API: `https://dlmm.datapi.meteora.ag` (30 RPS — see `data-and-apis.md`)
- Studio actions: `studio-actions.md` §DLMM · config template: `configs/dlmm_config.jsonc`
