# DAMM v2 — Constant-Product AMM (CP-AMM)

> **Source of truth:** `@meteora-ag/cp-amm-sdk@1.4.5` (github.com/MeteoraAg/damm-v2-sdk) —
> as of 2026-08-01.
> Program ID (mainnet **and** devnet): `cpamdpZCGKUy5JxQXB4dcpGPiikHawvSWAd6mEn1sGG`
> Deps: web3.js v1 (^1.95), Anchor 0.31, `bn.js`, `decimal.js`. Full per-function reference:
> `docs.md` in the SDK repo (~4,350 lines) and
> https://docs.meteora.ag/developer-guides/damm-v2/typescript-sdk/getting-started.md
> **DAMM v2 is a separate program from DAMM v1 — nothing here applies to v1 pools.**

## Mental model

Constant-product pools with **positions as NFTs** (not LP tokens). A position tracks
liquidity, unclaimed fees, and up to 2 farming rewards. Pools come from a shared **config**
(permissionless `createPool`) or fully custom (`createCustomPool`). Fees support time
schedulers, **market-cap schedulers**, rate limiters, and three collect modes — including
**Compounding** (fees auto-compound into liquidity; constant-product, no price range).
Liquidity can be vested, locked, or permanently locked. This is the default DBC graduation
target.

Studio actions (ACT path): `damm-v2-create-balanced-pool`, `damm-v2-create-one-sided-pool`,
`damm-v2-add-liquidity`, `damm-v2-remove-liquidity`, `damm-v2-claim-position-fee`,
`damm-v2-split-position`, `damm-v2-close-position`, `damm-v2-refresh-vesting`.
Template: `configs/damm_v2_config.jsonc`. There is **no studio swap** — swaps are BUILD path.

## Client setup

```ts
import { Connection } from '@solana/web3.js'
import { CpAmm } from '@meteora-ag/cp-amm-sdk'

const connection = new Connection(RPC_URL, 'confirmed')
const cpAmm = new CpAmm(connection)   // ONE argument — no commitment param
```

Flat class. Action methods return `Promise<Transaction>` **except**
`createCustomPool` / `createCustomPoolWithDynamicConfig` → `{ tx, pool, position }`.

## Method map

| Category | Methods |
|---|---|
| Create | `createPool` (from config) · `createCustomPool` · `createCustomPoolWithDynamicConfig` · `createPosition` · `createPositionAndAddLiquidity` · `preparePoolCreationParams` / `preparePoolCreationSingleSide` |
| Liquidity | `addLiquidity` · `removeLiquidity` · `removeAllLiquidity` · `removeAllLiquidityAndClosePosition` · `mergePosition` · `closePosition` |
| Swap | `swap` (exact-in) · `swap2` (`swapMode`: ExactIn / PartialFill / ExactOut) |
| Quotes | `getQuote` (legacy: needs `currentTime`+`currentSlot`) · `getQuote2` (needs `currentPoint`) · `getDepositQuote` · `getWithdrawQuote` · `getLiquidityDelta` |
| Lock/vest | `lockPosition` (union: `{vestingAccount}` OR `{innerPosition: true}`) · `permanentLockPosition` · `refreshVesting` · `splitPosition` (7 percentages) · `splitPosition2` (single `numerator` / 1e9) |
| Fees | `claimPositionFee` · `claimPositionFee2` (explicit receiver required) |
| Rewards | `initializeReward` · `initializeAndFundReward` · `fundReward` · `claimReward` · `updateRewardDuration/Funder` · `withdrawIneligibleReward` · `withdrawDeadLiquidityReward` (Compounding pools only) |
| Delegate | `updateDelegatePermission` (1.4.4+: SPL-approve + on-chain permission bitmask; revoke with `permission: 0`) |
| Reads | `fetchPoolState` · `fetchConfigState` · `fetchPositionState` · `fetchPoolFees` · `fetchPoolStatesByTokenAMint/BMint/Mint` · `getAllConfigs` / `getStaticConfigs` · `getAllPools/Positions` · `getAllPositionsByPool` · `getUserPositionByPool` · `getPositionsByUser` (sorted by liquidity desc) · `getPositionsByUserAndTokenMint` · `getAllVestingsByPosition` · `isLockedPosition` / `isPermanentLockedPosition` / `canUnlockPosition` · `isPoolExist` |

PDAs: `derivePoolAddress`, `deriveCustomizablePoolAddress`, `derivePositionAddress`,
`derivePositionNftAccount`, `deriveTokenVaultAddress`, `deriveRewardVaultAddress`, …
Fee params: `getBaseFeeParams` (dispatches by mode), `getDynamicFeeParams`,
`bpsToFeeNumerator` / `feeNumeratorToBps`. Helper: `getTokenProgram(poolState.tokenAFlag)`.

## Core flow: quote + swap
```ts
import { BN } from '@coral-xyz/anchor'
import { TOKEN_PROGRAM_ID, TOKEN_2022_PROGRAM_ID, getMint, Mint } from '@solana/spl-token'

const poolState = await cpAmm.fetchPoolState(poolAddress)

// token2022 pools need { mint, currentEpoch } for transfer-fee math — else pass null
let tokenAInfo: { mint: Mint; currentEpoch: number } | null = null   // build via getMint +
let tokenBInfo: { mint: Mint; currentEpoch: number } | null = null   // getEpochInfo if owner is TOKEN_2022_PROGRAM_ID

const currentSlot = await connection.getSlot()
const blockTime = await connection.getBlockTime(currentSlot)

const quote = cpAmm.getQuote({
  inAmount: new BN(1_000_000),
  inputTokenMint: poolState.tokenBMint,
  slippage: 0.5,                              // percent
  poolState,
  currentTime: blockTime!, currentSlot,
  inputTokenInfo: tokenBInfo!, outputTokenInfo: tokenAInfo!,  // null is fine for plain SPL mints
  tokenADecimal: 6, tokenBDecimal: 9,
})
// { swapInAmount, consumedInAmount, swapOutAmount, minSwapOutAmount, totalFee, priceImpact }

const swapTx = await cpAmm.swap({
  payer: wallet.publicKey, pool: poolAddress,
  inputTokenMint: poolState.tokenBMint, outputTokenMint: poolState.tokenAMint,
  amountIn: new BN(1_000_000), minimumAmountOut: quote.minSwapOutAmount,
  tokenAVault: poolState.tokenAVault, tokenBVault: poolState.tokenBVault,
  tokenAMint: poolState.tokenAMint, tokenBMint: poolState.tokenBMint,
  tokenAProgram: TOKEN_PROGRAM_ID, tokenBProgram: TOKEN_PROGRAM_ID,   // per mint owner
  referralTokenAccount: null,
})
// set feePayer + recentBlockhash, sign with wallet, send
```

## Core flow: positions + claim fees
```ts
import { getTokenProgram } from '@meteora-ag/cp-amm-sdk'

const userPositions = await cpAmm.getUserPositionByPool(poolAddress, userAddress)
const position = userPositions[0]            // { position, positionNftAccount, positionState }
const poolState = await cpAmm.fetchPoolState(poolAddress)

const claimTx = await cpAmm.claimPositionFee({
  receiver: wallet.publicKey, owner: wallet.publicKey,
  pool: poolAddress, position: position.position,
  positionNftAccount: position.positionNftAccount,
  tokenAVault: poolState.tokenAVault, tokenBVault: poolState.tokenBVault,
  tokenAMint: poolState.tokenAMint, tokenBMint: poolState.tokenBMint,
  tokenAProgram: getTokenProgram(poolState.tokenAFlag),
  tokenBProgram: getTokenProgram(poolState.tokenBFlag),
})
```

## Core flow: deposit into an existing position
```ts
const poolState = await cpAmm.fetchPoolState(poolAddress)
const [userPosition] = await cpAmm.getUserPositionByPool(poolAddress, wallet.publicKey)
// positions come sorted by liquidity, largest first (inherits getPositionsByUser's order)

const amountIn = new BN(50_000_000)      // base units of ONE side; isTokenA says which
const isTokenA = false

const depositQuote = await cpAmm.getDepositQuote({
  inAmount: amountIn,
  isTokenA,
  minSqrtPrice: poolState.sqrtMinPrice,
  maxSqrtPrice: poolState.sqrtMaxPrice,
  sqrtPrice: poolState.sqrtPrice,
  collectFeeMode: poolState.collectFeeMode,   // required since 1.3.7
  tokenAAmount: poolState.tokenAAmount,
  tokenBAmount: poolState.tokenBAmount,
  liquidity: poolState.liquidity,
})  // -> { actualInputAmount, consumedInputAmount, outputAmount, liquidityDelta }

const maxAmountTokenA = isTokenA ? amountIn : depositQuote.outputAmount
const maxAmountTokenB = isTokenA ? depositQuote.outputAmount : amountIn

const addTx = await cpAmm.addLiquidity({
  owner: wallet.publicKey,
  pool: poolAddress,
  position: userPosition.position,
  positionNftAccount: userPosition.positionNftAccount,
  liquidityDelta: depositQuote.liquidityDelta,
  maxAmountTokenA, maxAmountTokenB,
  // max* / *Threshold bound what the instruction may consume per side; the studio sets
  // thresholds equal to the max amounts
  tokenAAmountThreshold: maxAmountTokenA, tokenBAmountThreshold: maxAmountTokenB,
  tokenAMint: poolState.tokenAMint, tokenBMint: poolState.tokenBMint,
  tokenAVault: poolState.tokenAVault, tokenBVault: poolState.tokenBVault,
  tokenAProgram: getTokenProgram(poolState.tokenAFlag),
  tokenBProgram: getTokenProgram(poolState.tokenBFlag),
})
```

New positions: `createPosition` / `createPositionAndAddLiquidity` take a fresh
`positionNft: Keypair().publicKey` — **that keypair must co-sign** the transaction (same
pattern as the token-2022 `{ tx, pool, position }` creators). Withdraw:
`getWithdrawQuote` → `removeLiquidity` (needs `vestings[]` from
`getAllVestingsByPosition` + `currentPoint`).

## Version fences

- `collectFeeMode` is **required** on `getLiquidityDelta`, `getDepositQuote`,
  `getWithdrawQuote`, `preparePoolCreationParams` since 1.3.7 — older call shapes won't typecheck.
- `CollectFeeMode` here = `{ BothToken=0, OnlyB=1, Compounding=2 }` — **not** the DBC or DLMM enums.
- `claimPartnerFee` / `ClaimPartnerFeeParams` → **removed** (1.3.7). Fee results expose `claimingFee` + `compoundingFee`, not `tradingFee`/`partnerFee`.
- `BaseFeeMode` has 5 variants; param renamed `feeSchedulerParam` → `feeTimeSchedulerParam` (1.2.7); market-cap scheduler takes `priceMultiple` (1.4.2), not starting/ending market caps.
- Max total fee is 99% only on pool layout V1 (`MAX_FEE_BPS_V1 = 9900`); legacy V0 pools cap at 50%. `PoolVersion` → renamed `LayoutVersion`.
- On-chain signer account renamed `owner` → `signer` on position instructions (1.4.4) — affects hand-built instructions only; SDK param names unchanged.
- `lockPosition` is a discriminated union — pass `vestingAccount` OR `innerPosition: true`, never both.
- `new CpAmm(connection, commitment)` → wrong; constructor takes only `connection`.
- Token-2022 pools: omitting `inputTokenInfo`/`outputTokenInfo` (or `tokenAInfo`/`tokenBInfo`) gives wrong quotes — transfer-fee math needs `{ mint, currentEpoch }`.

## Deep links

- SDK repo `docs.md`, `examples/` (6 end-to-end flows), `scripts/*.s.ts` (~30 operational scripts)
- https://docs.meteora.ag/core-products/damm-v2/what-is-damm-v2.md
- Data API: `https://damm-v2.datapi.meteora.ag` (see `data-and-apis.md`)
- Studio actions: `studio-actions.md` §DAMM v2 · config template: `configs/damm_v2_config.jsonc`
