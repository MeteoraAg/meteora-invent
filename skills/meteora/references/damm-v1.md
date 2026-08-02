# DAMM v1 — Dynamic AMM (legacy)

> **Source of truth:** `@meteora-ag/dynamic-amm-sdk@1.4.1` (github.com/MeteoraAg/damm-v1-sdk,
> TS client in `ts-client/`) — verified against SDK source 2026-08-01. Repo is quiet
> (last change 2025-08); check npm for newer versions before trusting this pin.
> **Review by 2026-12-01:** legacy product — re-check deprecation status and whether this
> pack should shrink to lock-escrow/Stake2Earn maintenance flows only.
> Program ID: `Eo7WjKq67rjJQSZxS6z3YkapzY3eMj6Xy8X5EQVn5UaB`
> Deps: web3.js v1 (**pinned 1.98.0**), **Anchor 0.29** (not 0.31!), `@meteora-ag/vault-sdk`.
> ⚠️ **Legacy product** — don't start new projects here. Use DAMM v2 unless the user has
> existing v1 pools, needs Stake2Earn (M3M3) fee farms, or the v1 memecoin-launch flow.

## Mental model

Classic AMM with **LP tokens** (not position NFTs). Pool reserves sit inside Meteora
**Dynamic Vaults** (`vaultA`/`vaultB`), earning lending yield on top of trade fees. Pool
types: constant-product, stable (incl. LST/depeg pools needing extra accounts), and
memecoin pools (auto lock + optional M3M3 fee vault). LP can be permanently locked into a
**lock escrow** that still accrues claimable fees — the basis of "locked liquidity" launches
and Stake2Earn.

Studio actions (ACT path): `damm-v1-create-pool`, `damm-v1-lock-liquidity`,
`damm-v1-create-stake2earn-farm`, `damm-v1-lock-liquidity-stake2earn`.
Template: `configs/damm_v1_config.jsonc`. No studio swap/deposit — BUILD path.

## Client setup

```ts
import { Connection, PublicKey } from '@solana/web3.js'
import AmmImpl from '@meteora-ag/dynamic-amm-sdk'
import { BN } from 'bn.js'

const connection = new Connection(RPC_URL, 'confirmed')
const pool = await AmmImpl.create(connection, new PublicKey(POOL_ADDRESS))
// constructor is private — always the static factory. Multiple: AmmImpl.createMultiple(...)
```

Instance fields: `pool.tokenAMint` / `pool.tokenBMint` (spl `Mint` — use `.address`),
`pool.poolState`, `pool.poolInfo`, `pool.vaultA/B`; getters `pool.isStablePool`,
`pool.feeBps`, `pool.decimals`. **The repo README still shows `pool.tokenB.address` in
places — the current field is `pool.tokenBMint.address`.**

## Method map

| Category | Methods |
|---|---|
| Create (static) | `createPermissionlessConstantProductPoolWithConfig(2)` (config-based; `2` adds `activationPoint`, `stakeLiquidity`) · `createCustomizablePermissionlessConstantProductPool` (creator-set fees/activation) · `createPermissionlessPool` (legacy; `isStable` flag for stable pools) · `createPermissionlessConstantProductMemecoinPoolWithConfig` (mints token opt., locks LP, optional M3M3 vault) · `createConfig` |
| Deposit/withdraw | `getDepositQuote(tokenAIn, tokenBIn, balance, slippage)` → `deposit(owner, tokenAIn, tokenBIn, poolTokenOut)` · `getWithdrawQuote(lpAmount, slippage, tokenMint?)` → `withdraw(owner, lpAmount, tokenAOut, tokenBOut)` |
| Swap | `getSwapQuote(inTokenMint, inAmountLamport, slippage, swapInitiator?)` → `swap(owner, inTokenMint, inAmountLamport, minOutAmountLamport, referralOwner?)` · `getMaxSwapInAmount` / `getMaxSwapOutAmount` · `swapAndStakeForFee` (M3M3) |
| Lock escrow | `lockLiquidity(owner, amount, feePayer?, { stakeLiquidity? })` · `getUserLockEscrow(owner)` · `getLockedLpAmount()` · `claimLockFee2(owner, maxAmount, payer, receiver)` (**preferred**; plain `claimLockFee` needs manual temp-wSOL) · `moveLockedLP` · static `AmmImpl.getLockedLpAmountByUser(connection, user)` |
| Partner | `partnerClaimFees(partnerAddress, maxAmountA, maxAmountB)` |
| State | `updateState()` (**call before every quote**) · `getPoolTokenMint()` · `getLpSupply()` · `getUserBalance(owner)` |
| Static reads | `AmmImpl.searchPoolsByToken(connection, mint)` · `getPoolConfig` / `getFeeConfigurations` / `getPoolConfigsWithPoolCreatorAuthority` · `fetchMultipleUserBalance` |
| Standalone utils | `calculateSwapQuote`, `calculatePoolInfo`, `checkPoolExists`, `getTokensMintFromPoolAddress`, `derivePoolAddress`; deep-import `derivePoolAddressWithConfig`, `deriveLockEscrowPda` from `@meteora-ag/dynamic-amm-sdk/dist/cjs/src/amm/utils` |

## Core flow: swap (verified from SDK README + source)

```ts
await pool.updateState()                                 // refresh cached reserves/clock first

const inTokenMint = pool.tokenBMint.address              // e.g. swap B -> A
const inAmountLamport = new BN(0.1 * 10 ** pool.tokenBMint.decimals)

const { minSwapOutAmount } = pool.getSwapQuote(inTokenMint, inAmountLamport, 0.5) // slippage %
const swapTx = await pool.swap(wallet.publicKey, inTokenMint, inAmountLamport, minSwapOutAmount)
// sign + send (single Transaction)
```

## Core flow: balanced deposit / withdraw

```ts
await pool.updateState()
const inAmountA = new BN(1 * 10 ** pool.tokenAMint.decimals)

// Constant-product pools: BALANCED ONLY — quote with tokenB = 0, balance = true
const { poolTokenAmountOut, tokenAInAmount, tokenBInAmount } =
  pool.getDepositQuote(inAmountA, new BN(0), true, 0.5)
const depositTx = await pool.deposit(wallet.publicKey, tokenAInAmount, tokenBInAmount, poolTokenAmountOut)

// Withdraw (balanced; pass tokenMint for single-sided on STABLE pools only)
const lpAmount = await pool.getUserBalance(wallet.publicKey)
const q = pool.getWithdrawQuote(lpAmount, 0.5)
const withdrawTx = await pool.withdraw(wallet.publicKey, q.poolTokenAmountIn, q.minTokenAOutAmount, q.minTokenBOutAmount)
```

Imbalanced / single-side deposits are **stable-pool features** — the SDK
`invariant`-throws `'Constant product only supports balanced deposit'` otherwise.

## Version fences

- Package is `@meteora-ag/dynamic-amm-sdk` — `@mercurial-finance/dynamic-amm-sdk` is the dead pre-1.2.0 name.
- **Anchor 0.29** (`new Program(idl, programId, provider)`, `.accounts({...})`). Mixing with the Anchor-0.31 Meteora SDKs in one package causes type/BN identity conflicts — isolate dependencies if you must combine.
- No `exports` map and no `types` field in package.json: use `moduleResolution: "node"` (or path aliases); deep imports from `dist/cjs/src/amm/utils` are the documented way to reach extra derivation helpers.
- `claimLockFee2` exists only from 1.3.9+ and is the reliable fee-claim path (plain `claimLockFee` had repeated wSOL bugs).
- Pool-creation `*WithConfig*`/memecoin variants return **`Transaction[]`** — sign and send sequentially.
- Fee bps are constrained: constant-product `[25, 100, 400, 600]`, stable `[1, 4, 10, 100]`.
- LST/depeg stable pools need `getDepegAccounts(connection)` extra accounts (marinade/lido).
- Stake2Earn beyond pool-creation hooks lives in `@meteora-ag/m3m3` (program `FEESngU3neckdwib9X3KWqdL7Mjmqk9XNp3uh5JbP4KP`), not this SDK.

## Deep links

- SDK repo: `ts-client/README.md` (good recipes per pool type — but see the `tokenBMint` correction above), `ts-client/src/examples/`
- https://docs.meteora.ag/legacy-products/damm-v1/what-is-damm-v1.md
- Data API: `https://damm-api.meteora.ag` (devnet: `https://damm-api.devnet.meteora.ag`) — see `data-and-apis.md`
- Studio actions: `studio-actions.md` §DAMM v1 · config template: `configs/damm_v1_config.jsonc`
