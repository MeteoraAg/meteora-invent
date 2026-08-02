# DBC — Dynamic Bonding Curve

> **Source of truth:** `@meteora-ag/dynamic-bonding-curve-sdk@1.5.11`
> (github.com/MeteoraAg/dynamic-bonding-curve-sdk) — verified against SDK source 2026-08-01.
> Program ID (mainnet **and** devnet): `dbcij3LWUppWqq96dh6gJWwBifmcGfLSB5D4DuSMaqN`
> Deps: web3.js v1 (^1.98), Anchor 0.31, `bn.js`. Full per-function reference:
> `packages/dynamic-bonding-curve/docs.md` in the SDK repo (~5,000 lines) and
> https://docs.meteora.ag/developer-guides/dbc/typescript-sdk/getting-started.md

## Mental model

1. A **partner** creates a reusable **config** (curve shape, fees, migration rules, LP split).
2. A **creator** launches a **virtual pool** (+ token mint) on that config.
3. Traders buy/sell along the curve; quote tokens accumulate as `quoteReserve`.
4. When `quoteReserve` ≥ `migrationQuoteThreshold`, the pool **graduates**: migrate to
   DAMM v1 or DAMM v2 (per config), LP is distributed/locked per config, trading moves there.

Roles matter for fee claims: *partner* = `feeClaimer` on the config; *creator* = pool creator.
Both can have trading-fee shares, surplus, and migration-fee withdrawals.

## Launch intake contract (ACT path — collect before executing)

| Field | Ask / default |
|---|---|
| Network / RPC | Ask; default devnet first run. Mainnet needs explicit confirmation. |
| Wallet + funding | ≥0.05 SOL pool, ~0.1 recommended (see `wallets-and-txs.md`) |
| Token identity | **Ask:** name, symbol, image (path/URL), description, socials. Or an existing metadata `uri`. |
| Supply / decimals | Default 1,000,000,000 / base 6, quote 9. Human units in configs, not lamports. |
| Quote mint | Default SOL `So11111111111111111111111111111111111111112`; USDC on request. |
| Curve shape | Ask intent → mode: "simple" → `buildCurveMode: 0` (defaults: 20% supply on migration, threshold 10 quote); "target market caps" → mode 1 (`initialMarketCap`, `migrationMarketCap`); advanced → modes 2–5 (below). Set ONLY the chosen mode's shape fields — comment out the other modes' (the template ships mode 0 active). |
| Graduation cost expectation | The SOL needed to graduate (`migrationQuoteThreshold`) is derived from the curve, not set directly in modes 1–5 — read it right after creation (`pnpm studio dbc-get-status --baseMint <MINT>`, printed in quote base units). Measured example: caps 20→600 SOL with the default 50/40/5/5 LP split ⇒ threshold ≈ 92.6 SOL. Devnet airdrops are 5 SOL/call — use small caps for devnet rehearsals. |
| Fees | Defaults: fee scheduler 100→100 bps, `dynamicFeeEnabled: true`, `creatorTradingFeePercentage: 50`, `collectFeeMode: 0` (quote). Min base fee **25 bps**. |
| Fee-share asks | "X% of trading fees" maps to TWO knobs — clarify which: `creatorTradingFeePercentage` splits **bonding-curve-phase** fees between creator and partner (`feeClaimer`); `liquidityDistribution` percentages set who owns the **post-graduation** LP (and its fees). Self-launches where the owner is both partner and creator receive 100% either way — the split only matters with a launchpad/partner. |
| Migration target | Default DAMM v2 (`migrationOption: 1`), `migrationFeeOption: 3` (2% LP fee). Option 6 = customizable (needs `migratedPoolFee`). |
| LP distribution | Must total 100% across partner/creator × claimable/permanent-locked; **≥10% locked or vesting ≥1 day post-migration** (protocol rule). |
| Addresses | **Ask:** `feeClaimer`, `leftoverReceiver`, pool `creator`. |
| Token-2022 hook | Default no. If yes: `tokenType: 1` + `transferHookProgram` on config AND pool. |

Studio actions: `dbc-create-config` (save the logged config pubkey) → `dbc-create-pool
--config <that pubkey>` (or run `dbc-create-pool` alone to do both at once) → (trade) →
`dbc-migrate-to-damm-v2` (or `-v1`). Template: `configs/dbc_config.jsonc`. Swap/claim/status:
`dbc-swap`, `dbc-claim-trading-fee`, `dbc-get-status`. Post-migration withdrawals (leftover/surplus/migration
fee) are BUILD-only. Details: `studio-actions.md`.

## Client setup (BUILD path)

```ts
import { Connection } from '@solana/web3.js'
import { DynamicBondingCurveClient } from '@meteora-ag/dynamic-bonding-curve-sdk'

const connection = new Connection(RPC_URL, 'confirmed')
const client = new DynamicBondingCurveClient(connection, 'confirmed')
// namespaces: client.partner / client.creator / client.pool / client.migration / client.state
```

All methods build **unsigned `Transaction`s** — you set blockhash + feePayer and sign.

## Method map

### `client.partner` — config + partner fees
| Method | Purpose |
|---|---|
| `createConfig` / `createConfigWithTransferHook` | Create pool config from `buildCurve*` output |
| `createConfigAndPool(WithTransferHook)` | Config + pool in one tx |
| `createConfigAndPoolWithFirstBuy(WithTransferHook)` | Returns `{ createConfigTx, createPoolWithFirstBuyTx }` — two txs for bundling |
| `createPartnerMetadata` | Partner metadata for a feeClaimer |
| `claimPartnerTradingFee` / `claimPartnerTradingFeeToReceiver` | Claim partner share (`maxBaseAmount`, `maxQuoteAmount`) |
| `claimPartnerTradingFee2` | **Transfer-hook pools only** (renamed semantics in 1.5.8) |
| `partnerWithdrawSurplus` / `partnerWithdrawMigrationFee` / `claimPartnerPoolCreationFee` | Post-migration withdrawals |

### `client.creator` — pool creation + creator fees
| Method | Purpose |
|---|---|
| `createPool(WithTransferHook)` | Launch on existing config (`name`, `symbol`, `uri`, `payer`, `poolCreator`, `config`, `baseMint`) |
| `createPoolWithFirstBuy(WithTransferHook)` | Pool + optional first buy in one tx |
| `createPoolWithPartnerAndCreatorFirstBuy(WithTransferHook)` | Pool + partner buy + creator buy |
| `createPoolMetadata` | Pool metadata (param key is `virtualPool` here) |
| `claimCreatorTradingFee` / `claimCreatorTradingFeeToReceiver` / `claimCreatorTradingFee2` (hook) | Creator fee claims |
| `creatorWithdrawSurplus` / `creatorWithdrawMigrationFee` / `transferPoolCreator` | Creator ops |

### `client.pool` — trading
| Method | Purpose |
|---|---|
| `swap` | Exact-in (`owner`, `pool`, `amountIn`, `minimumAmountOut`, `swapBaseForQuote`, `referralTokenAccount`) |
| `swap2` / `swap2WithTransferHook` | `swapMode`: ExactIn / PartialFill / ExactOut (ExactOut: `amountOut` + `maximumAmountIn`) |
| `swapQuote` / `swapQuote2` | Off-chain quotes (see snippet — need pool + config state, `currentPoint`) |
| `getQuoteFromInputAmount` / `getQuoteFromOutputAmount` | **Pre-launch** quotes simulated from a `buildCurve*` output (1.5.10+) |

### `client.migration`
Order — **DAMM v2**: (`createLocker` if locked vesting configured) → `migrateToDammV2`.
**DAMM v1**: `createDammV1MigrationMetadata` → (`createLocker` if vesting) → `migrateToDammV1`
→ `lockDammV1LpToken` → `claimDammV1LpToken`. Plus `withdrawLeftover` after migration.

`migrateToDammV2` returns **`{ transaction, firstPositionNftKeypair, secondPositionNftKeypair }`
— both keypairs must sign.** Graduated-pool fee tiers come from
`DAMM_V2_MIGRATION_FEE_ADDRESS[0..6]` / `DAMM_V1_MIGRATION_FEE_ADDRESS[0..5]` (index = `migrationFeeOption`).

### `client.state` — reads (no wallet needed)
`getPoolConfig(s)(ByOwner)` · `getPool(s)` · `getPoolsByConfig/ByCreator` ·
`getPoolByBaseMint(mint)` · `getPoolMigrationQuoteThreshold` ·
`getPoolQuoteTokenCurveProgress(poolAddress): Promise<number>` (0–1; same for
`...BaseToken...`) · `getPoolFeeMetrics` · `getPoolFeeBreakdown(poolAddress)` →
`{ creator: {...}, partner: {...} }`, each with `unclaimedBaseFee`, `unclaimedQuoteFee`,
`claimedBaseFee`, `claimedQuoteFee`, `totalBaseFee`, `totalQuoteFee` (all `BN`, base units) ·
`getPoolsFeesByConfig/ByCreator` · `getPoolMetadata` / `getPartnerMetadata`.

**Post-graduation detection & successor pool:** `pool.poolState.isMigrated` (numeric flag,
0 = on curve) is set once the pool has migrated (progress reaches 1.0 at the threshold;
`pnpm studio dbc-get-status` prints it). The fetched config account exposes the routing fields
camelCased from the IDL — `migrationOption` (0 = DAMM v1, 1 = v2), `migrationFeeOption`,
`activationType`. Find the graduated DAMM v2 pool with the DBC helper
`deriveDammV2PoolAddress(config, tokenAMint, tokenBMint)` or by scanning
`cpAmm.fetchPoolStatesByTokenMint(baseMint)` from `@meteora-ag/cp-amm-sdk` (returns
`Array<{ publicKey, account: PoolState }>`) — then trade via `damm-v2.md`. The migrated liquidity becomes DAMM v2 **position NFTs** split between
partner and creator per the config's `liquidityDistribution` (permanent-locked shares stay
locked); check with `cpAmm.getUserPositionByPool(pool, owner)`. A trading UI must handle
this switch or it breaks at graduation.

## Core flow: build curve → create config (verified from SDK scripts)

```ts
import { Connection, Keypair, PublicKey, sendAndConfirmTransaction } from '@solana/web3.js'
import {
  buildCurveWithMarketCap, DynamicBondingCurveClient,
  ActivationType, BaseFeeMode, CollectFeeMode, MigrationFeeOption, MigrationOption,
  TokenAuthorityOption, TokenDecimal, TokenType,
} from '@meteora-ag/dynamic-bonding-curve-sdk'

const curveConfig = buildCurveWithMarketCap({
  token: {
    tokenType: TokenType.SPLToken,          // Token2022 for hook launches
    tokenBaseDecimal: TokenDecimal.SIX,
    tokenQuoteDecimal: TokenDecimal.NINE,
    tokenAuthorityOption: TokenAuthorityOption.Immutable,
    totalTokenSupply: 1_000_000_000,
    leftover: 0,
  },
  fee: {
    baseFeeParams: {
      baseFeeMode: BaseFeeMode.FeeSchedulerLinear,
      feeSchedulerParam: { startingFeeBps: 100, endingFeeBps: 100, numberOfPeriod: 0, totalDuration: 0 },
    },
    dynamicFeeEnabled: true,
    collectFeeMode: CollectFeeMode.QuoteToken,
    creatorTradingFeePercentage: 50,
    poolCreationFee: 0,
    enableFirstSwapWithMinFee: false,
  },
  migration: {
    migrationOption: MigrationOption.MET_DAMM_V2,
    migrationFeeOption: MigrationFeeOption.FixedBps200,   // option 3 (2%); Customizable needs migratedPoolFee
    migrationFee: { feePercentage: 0, creatorFeePercentage: 0 },
  },
  liquidityDistribution: {
    partnerLiquidityPercentage: 50, partnerPermanentLockedLiquidityPercentage: 5,
    creatorLiquidityPercentage: 40, creatorPermanentLockedLiquidityPercentage: 5,
  },
  lockedVesting: { totalLockedVestingAmount: 0, numberOfVestingPeriod: 0, cliffUnlockAmount: 0, totalVestingDuration: 0, cliffDurationFromMigrationTime: 0 },
  activationType: ActivationType.Timestamp,
  initialMarketCap: 20,        // in quote tokens
  migrationMarketCap: 600,
})

const config = Keypair.generate()
const tx = await client.partner.createConfig({
  config: config.publicKey,
  feeClaimer: FEE_CLAIMER, leftoverReceiver: LEFTOVER_RECEIVER,
  payer: wallet.publicKey, quoteMint: QUOTE_MINT,
  ...curveConfig,
})
await sendAndConfirmTransaction(connection, tx, [wallet, config])  // config keypair signs!
```

Note: exact enum member names matter — check `src/types.ts` if unsure. The migration fee
option enum indexes map to the studio config's `migrationFeeOption: 0..6`.

Other builders (same nested base params, different shape inputs): `buildCurve`
(`percentageSupplyOnMigration` + `migrationQuoteThreshold`), `buildCurveWithTwoSegments`,
`buildCurveWithMidPrice`, `buildCurveWithLiquidityWeights` (16 weights),
`buildCurveWithCustomSqrtPrices` (ascending `prices[]` + optional weights).

## Core flow: quote + swap on a live pool (verified)

```ts
import BN from 'bn.js'

const pool = await client.state.getPoolByBaseMint(baseMint)           // ProgramAccount | null
const virtualPoolState = await client.state.getPool(pool!.publicKey)
const poolConfigState = await client.state.getPoolConfig(virtualPoolState!.poolState.config)

// currentPoint depends on the config's activation type:
// poolConfigState.activationType === 1 (timestamp) -> block time; 0 (slot) -> slot number
const currentSlot = await connection.getSlot()
const currentTime = await connection.getBlockTime(currentSlot)

const quote = await client.pool.swapQuote({
  virtualPool: virtualPoolState!,
  config: poolConfigState,
  swapBaseForQuote: false,                 // false = buy base with quote
  amountIn: new BN(1_000_000_000),         // lamports of quote (1 SOL)
  slippageBps: 100,
  hasReferral: false,
  currentPoint: new BN(currentTime!),      // see activationType note above
  eligibleForFirstSwapWithMinFee: false,   // true ONLY for the very first swap on a pool
                                           // whose config set enableFirstSwapWithMinFee
})
// quote: { actualInputAmount, outputAmount, minimumAmountOut, nextSqrtPrice, tradingFee, protocolFee, referralFee }

const swapTx = await client.pool.swap({
  owner: wallet.publicKey, pool: pool!.publicKey,
  amountIn: new BN(1_000_000_000), minimumAmountOut: quote.minimumAmountOut,
  swapBaseForQuote: false, referralTokenAccount: null,
})
```

## Version fences — if you're writing this, your API knowledge is stale

- `new DynamicBondingCurve(...)`, `dbc.buy()/sell()/getBuyQuote()` → **never existed** (fabricated in some third-party docs). Use the service client above.
- `client.pool.createPool(...)` → moved to `client.creator.createPool` (1.5.8); config+pool combos live on `client.partner`.
- Flat `buildCurve` params (`totalTokenSupply` at top level) → nested groups since 1.5.3.
- Flat pool fields (`pool.baseMint`) → nested under `pool.poolState.baseMint` etc. (1.5.8).
- Param key `virtualPool` → renamed `pool` in migration/surplus/creator-transfer params (except `createPoolMetadata`).
- `claim*TradingFee2` = transfer-hook claims since 1.5.8; the non-hook "claim to receiver" is `claim*TradingFeeToReceiver`.
- `TokenType.SPL` → `TokenType.SPLToken`; `TokenUpdateAuthorityOption` → `TokenAuthorityOption`; `BASIS_POINT_MAX` → `MAX_BASIS_POINT`; `partnerLpPercentage` → `partnerLiquidityPercentage` (etc.).
- Base fee < 25 bps → rejected (`MIN_FEE_BPS = 25` since 1.4.6).
- Market-cap fee scheduler takes `priceMultiple` (ending/starting market-cap ratio), not `sqrtPriceStepBps` / market-cap pair (final form 1.5.8).
- `createDammV2MigrationMetadata` → removed (1.4.6); DAMM v2 migration needs no metadata step.
- `swapQuote` requires `eligibleForFirstSwapWithMinFee` and `currentPoint` — omitting them is a pre-1.5.2 signature.

## Deep links

- SDK repo `docs.md` (full per-function reference) and `scripts/*.s.ts` (~70 runnable examples, incl. `states/` queries)
- https://docs.meteora.ag/core-products/dbc/what-is-dbc.md
- https://docs.meteora.ag/developer-guides/dbc/typescript-sdk/getting-started.md
- Studio actions: `studio-actions.md` §DBC · config template: `configs/dbc_config.jsonc`
