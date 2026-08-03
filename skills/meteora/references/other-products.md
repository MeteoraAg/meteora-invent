# Other Products — Alpha Vault, Presale, Stake2Earn, Zap, Dynamic Vault, Fee Sharing, Met Lock, Pool Farms

> Compact SDK surfaces verified against the packages installed with the studio
> (read from each package's shipped `.d.ts`, 2026-08-02 → 03). Creation flows for alpha/presale
> vaults are ACT-path (`studio-actions.md`); this file covers the SDK surface — above all
> the **read/verify calls** the studio doesn't expose. All are web3.js v1.
> ⚠️ Anchor versions diverge (vault-sdk 0.28 · farming-sdk 0.28 · m3m3 0.29 · the rest 0.31) —
> never pass `Program`/`BN` objects across these SDK boundaries.

## Alpha Vault — `@meteora-ag/alpha-vault@1.1.16`

Program `vaU6kP7iNEGkbmPkLmZfGwiGxd4Mob24QQCie5R9kd2` (mainnet + devnet; **exported as a
string keyed by cluster, not PublicKey**). Enums: `PoolType { DLMM=0, DAMM=1, DAMMV2=2 }`,
`VaultMode { PRORATA=0, FCFS=1 }`, `VaultState { PREPARING..ENDED }`.

**Verify a vault (BUILD path — the ACT path is `alpha-vault-get-status`, below):**
```ts
import AlphaVault from '@meteora-ag/alpha-vault'
// Given only the POOL address there is no pure PDA derivation (the 'base' seed is the
// creator or config, not the pool). Find the vault by scanning:
const accounts = await connection.getProgramAccounts(new PublicKey(ALPHA_VAULT_PROGRAM_ID), {
  filters: [{ memcmp: { offset: 8, bytes: poolAddress.toBase58() } }],  // Vault.pool is the first field
})
const av = await AlphaVault.create(connection, accounts[0].pubkey)
// av.vault (state), av.mode (VaultMode), av.vaultState (lifecycle phase)
const escrow = await av.getEscrow(userPubkey)
const state = await av.interactionState(escrow)   // { depositInfo, claimInfo, availableQuota,
                                                  //   canDeposit, canClaim, canWithdraw, ... }
```
User ops (all → `Transaction`): `deposit(maxAmount, owner, merkleProof?)`, `withdraw`,
`withdrawRemainingQuote`, `claimToken`, `closeEscrow`. Crank: `fillVault(payer)` — loop until
it returns null. `getMerkleProofForDeposit(owner)` fetches a permissioned vault's proof from
Meteora's proof API and can return null (not on the whitelist yet, or no proof published).
Gotcha: the package bundles a second Anchor 0.28 copy for its DLMM/DAMM v1 programs.

Studio actions: `alpha-vault-*` (create + deposit/withdraw/claim/crank/status) — see
`studio-actions.md`. `alpha-vault-get-status` is now the ACT-path verification call (no
BUILD-side code needed just to check a vault's state).

## Presale Vault — `@meteora-ag/presale@0.1.1`

Program `presSVxnf9UU8jMxhgSMqaRwNiT36qeBdNeTRKjTdbj` (the src IDL in the repo shows a
different, non-deployed address — trust PRESALE_PROGRAM_ID from the package). **Pre-1.0 —
expect churn.**
Since 0.0.5 (changelog + source, verified): `presaleArgs` gained required
`disableEarlierPresaleEndOnceCapReached` (keep FCFS/fixed-price running until end time even
after the cap is hit) and `lockedVestingArgs` gained required `immediateReleaseTimestamp`
(when the immediate-release portion unlocks — the SDK's examples default it to
`presaleEndTime`); fixed-price creates take `disableWithdraw`. New helpers:
`getOnChainTimestamp(connection)`, `calculateLockAndVestDurationFromTimestamps(...)`,
`getRegistryRemainingDepositQuota` on the wrapper, and a max-presale-cap calculator;
`getPendingClaimable{Raw,Ui}Amount` now REQUIRE a `currentTimestamp` argument.

```ts
import { Presale, derivePresale } from '@meteora-ag/presale'
const presaleAddress = derivePresale(baseMint, quoteMint, base, PRESALE_PROGRAM_ID) // seeds ["presale", base, mint, quote]
const presale = await Presale.create(connection, presaleAddress)
const w = presale.getParsedPresale()          // PresaleWrapper:
// w.getPresaleProgressState()  -> NotStarted|Ongoing|Completed|Failed
// w.getPresaleProgressPercentage(), w.getTotalDepositUiAmount(), w.getAverageTokenPrice()
// w.canDeposit()/canWithdraw()/canClaim()/canCreatorWithdraw()
const escrows = await presale.getPresaleEscrowByOwner(buyer)  // per-buyer state
```
Buyer lifecycle (instance methods → `Transaction`): `createPermissionlessEscrow` →
`deposit({ owner, amount, registryIndex? })` → (after end) `claim({ owner, registryIndex })`
/ `withdrawRemainingQuote`. Creator: `creatorWithdraw`, `creatorCollectFee`,
`performUnsoldBaseTokenAction`. Gotcha: `registryIndex` is a BN serialized as **u8**.

Studio actions: `presale-vault-*` (create + full buyer/creator lifecycle + status) — see
`studio-actions.md`.

**Finding a presale:** there is no REST endpoint for presales today (unlike Pool Farms'
`amm.meteora.ag` lookup, below). ACT path: `pnpm studio presale-vault-get-status --baseMint
<mint>` — discovery mode that scans every presale and filters by base mint, printing the match
(or a `pubkey | mode | progress` list if the mint has more than one). BUILD path:
`Presale.getPresales(connection)` returns every presale account on the program (a full
`getProgramAccounts` scan — there's no memcmp/PDA shortcut from just the mint); filter the
results' `.account.baseMint` yourself.

## Stake2Earn (M3M3) — `@meteora-ag/m3m3@1.0.10`

Program `FEESngU3neckdwib9X3KWqdL7Mjmqk9XNp3uh5JbP4KP`. DAMM v1 pools only. **Anchor 0.29.**

```ts
import StakeForFee from '@meteora-ag/m3m3'
const s4f = await StakeForFee.create(connection, poolAddress)   // derives the fee vault from the pool
const { stakeEscrow, unclaimFee } = await s4f.getUserStakeAndClaimBalance(user)
// stakeEscrow.stakeAmount, .inTopList, unclaimFee.feeA/.feeB — the farm verification call
```
User ops: `initializeStakeEscrow(owner)` → `stake(maxAmount, owner)` →
`claimFee(owner, maxFee)` · `unstake(amount, unstakeKey, owner)` → `withdraw(unstakeKey, owner)`.
Admin: `StakeForFee.createFeeVault(...)` (what the studio's stake2earn actions wrap).

Studio actions: `stake2earn-*` (farm create + lock via `damm-v1-*`, full staker lifecycle +
status) — see `studio-actions.md`.

**Finding a farm:** SDK static `StakeForFee.getAllFeeVault(connection)` (verified) returns
every fee vault on the program as `{ publicKey, account }[]`, with `account.pool` and
`account.stakeMint` among the decoded fields — filter by either to find a farm, then run
`stake2earn-get-status --poolAddress <pool>`. Heuristic for which pools have one at all: M3M3
farms sit on DAMM v1 memecoin pools (`is_meme: true` in `damm-api.meteora.ag` pool search
results — see `data-and-apis.md`).

## Zap — `@meteora-ag/zap-sdk@1.3.2`

Program `zapvX9M3uf5pvy4wRPAbQgdQsM1xmuiFnkfHKPvwMiz`. Single-token in/out of DAMM v2 and DLMM
positions. `new Zap(connection, { jupiterApiUrl?, jupiterApiKey? })` — one config object (the
README's 3-arg example is stale); both fields are optional — the SDK defaults to Jupiter's own
keyless endpoint (`https://api.jup.ag`) at a shared, low rate limit, an API key
(`https://developers.jup.ag/portal`) only raises it. Two-phase: `getZapInDammV2DirectPoolParams(...)`
→ `buildZapInDammV2Transaction(...)`; same for DLMM (`...Dlmm...`); `zapOut*` variants; also
`rebalanceDlmmPosition(params)`. DLMM zap-in's own `estimateDlmmDirectSwap` unconditionally
calls Jupiter's quote API to price its rebalancing swap — DAMM v2's direct route never touches
Jupiter (see `studio-actions.md`'s Zap section for how each is verified). Build results are
**multi-transaction bundles** (`setupTransaction`, `swapTransactions[]`, `zapInTransaction`,
`cleanUpTransaction`) — send in order.
Studio actions: `zap-in-damm-v2` (direct), `zap-in-dlmm` (Jupiter-quoted), `zap-out` (direct) —
see `studio-actions.md`.

## Dynamic Vault — `@meteora-ag/vault-sdk@2.3.1`

Program `24Uqj9JCLxUeoC3hGfh5W3s9FM9uCHDS2SG3LYwBpyTi`. The yield layer under DAMM v1 pool
reserves. **Anchor 0.28, oldest stack.** `VaultImpl.create(connection, tokenMint)` (keys off
the TOKEN MINT, not a vault address) → `getUserBalance(owner)`, `getVaultSupply()`,
`getWithdrawableAmount()`; ops `deposit(owner, amount)` / `withdraw(owner, amount)`.
DAMM v1's `AmmImpl` already exposes these per-pool as `pool.vaultA` / `pool.vaultB`. Gotcha:
`withdraw`'s second parameter is misleadingly named `baseTokenAmount` in the `.d.ts` — verified
against the compiled source + vault program IDL, it actually burns **vault LP tokens**
(`unmintAmount`), not base-mint units; convert with the exported `getAmountByShare` /
`getUnmintAmount` helpers.

Studio actions: `vault-*` — see `studio-actions.md`.

## Dynamic Fee Sharing — `@meteora-ag/dynamic-fee-sharing-sdk@1.1.0`

Program `dfsdo2UqvwfN8DuUVrMRNfQe11VaiNoKcMqLHVvDPzh`. Splits fees among fixed recipients.
`new DynamicFeeSharingClient(connection, commitment)` →
`getFeeBreakdown(feeVault)` → `{ totalFundedFee, totalClaimedFee, totalUnclaimedFee, userFees[] }`;
`getRecipientDfsVault(recipient)` (reverse lookup). Create: `createFeeVault(params)`.
Funding bridges pull straight from other protocols: `fundByClaimDammV2Fee`,
`fundByClaimDbcCreatorTradingFee2` / `...PartnerTradingFee2` (use the `2` variants),
`fundByWithdrawDbcMigrationFee`. User claim: `claimUserFee2({ feeVault, user, payer, receiver })`.
Gotcha: ESM-first package (`"type": "module"` with a `.cjs` fallback).

Studio actions: `fee-sharing-*` — see `studio-actions.md`.

## Met Lock — `@meteora-ag/met-lock-sdk@1.0.1`

Program `LocpQgucEQHbqNABEYvBvwoxCPsSbG91A1QaQhQQqjn`. Standalone vesting/lock escrows for
any SPL or Token-2022 mint — not coupled to any pool. Anchor 0.31. **`docs.md` (320 ln) has
real errors — don't trust it over source/dist:** its `createVestingEscrowMetadata` "Example"
block actually calls `client.claimV2(...)` (wrong function, right-looking params), its
`createVestingEscrowV2` "Notes" require a `feeVault` signer copy-pasted from a different SDK
(met-lock has no such concept), and it documents `deriveEscrow`/`deriveEscrowMetadata` as
`async client.deriveEscrow(...)` methods when they're actually synchronous, standalone
helper functions exported from the package. Mirror the SDK repo's own
`createVestingEscrowV2.s.ts` / `claimV2.s.ts` scripts instead.

```ts
import { LockClient, deriveEscrow, calculateTotalLockedVestingAmount } from '@meteora-ag/met-lock-sdk'
const client = new LockClient(connection, commitment)  // commitment is REQUIRED, no default
const escrow = deriveEscrow(base.publicKey)             // sync PDA helper, NOT a client method
const escrowState = await client.getEscrow(escrow)      // THROWS (doesn't return null) if missing
```

`LockClient`'s full surface is 5 methods: `getRootEscrow(rootEscrow)` / `getEscrow(escrow)`
(both throw on a missing account), `createVestingEscrowMetadata(params)` (signers
`[creator, payer]`), `createVestingEscrowV2(params)` (signers `[sender, base, payer]` — `base`
is a fresh `Keypair` whose public key derives the escrow address), `claimV2(params)` (signers
`[payer, recipient]`; the program caps `maxAmount` at what has actually vested, so u64::MAX
means "claim everything"). PDA helpers are plain functions, not client methods:
`deriveEscrow(base)`, `deriveEscrowMetadata(escrow)`, `deriveRootEscrow(base, mint, version)`,
`deriveBase(rootEscrow, recipient)`. Token-2022 is detected by the caller, not the SDK: pass
the mint's actual owner program as `tokenProgram`, and import `TOKEN_2022_PROGRAM_ID` from
the same `@solana/spl-token` install the SDK resolves — `createVestingEscrowV2` branches on
it with `==` (object identity, not `.equals()`). Helper `calculateTotalLockedVestingAmount(
cliffUnlockAmount, amountPerPeriod, numberOfPeriod)` pre-checks a sender's balance before
creating an escrow. Owner→escrow listing has no SDK helper: use
`client.program.account.vestingEscrow.all()` with a memcmp filter (offset 8 = recipient,
offset 72 = creator — both verified against the SDK repo's
`sumCreatorLockVaultTotals.s.ts` script).

Studio actions: `lock-*` — see `studio-actions.md`.

## Pool Farms — `@meteora-ag/farming-sdk@1.0.18`

Program `FarmuwXPWXvefWUeqFAa5w6rifLkq5X6E8bimYvrhCB1`. DAMM v1 LP staking/reward farms —
every farm's `stakingMint` is a DAMM v1 pool's LP mint; no DAMM v2/DLMM equivalent exists.
**Anchor 0.28 pinned**, and `@solana/web3.js` pinned to `~1.78.3` — the narrowest version pin
of any Meteora SDK in this studio (verified against the installed `package.json`). Left as-is,
that pin forces an isolated, non-deduped `@solana/web3.js` install whose own `rpc-websockets`
dependency collides with the newer one the rest of the workspace hoists, crashing on the
package's very first `import` with `ERR_PACKAGE_PATH_NOT_EXPORTED` (reproduced on both Node 22
and 24) — this repo works around it with a root `pnpm.overrides` entry,
`"@meteora-ag/farming-sdk>@solana/web3.js": "^1.98.4"` (`package.json`), deduping the SDK onto
the same `@solana/web3.js` install every other SDK here already uses safely. A side effect:
`PublicKey`/`Transaction`/`BN` values now round-trip through this SDK's public API without
needing `as any` boundary casts (verified — `studio/src/lib/farming` has none).

```ts
import { PoolFarmImpl } from '@meteora-ag/farming-sdk'
const farm = await PoolFarmImpl.create(connection, farmAddress)   // no wallet — build-tx only
farm.poolState   // stakingMint, rewardAMint/rewardBMint, paused, totalStaked, rewardDuration(End), ...
```
User ops (all → a single `Transaction`, with `feePayer` and a `"finalized"`-commitment
blockhash already set by the SDK — refresh both right before sending anyway):
`deposit(owner, amount: BN)` (auto-creates the `user` account inline on first stake),
`withdraw(owner, amount: BN)`, `claim(owner)`. Static
`claimAll(connection, owner, farmAddresses, opt?)` → `Transaction[]`, chunked 2 farms per tx
(`MAX_CLAIM_ALL_ALLOWED`). Despite the parameter being named `farmMints` throughout this SDK
(`getUserBalances`, `getClaimableRewards`, `claimAll`), it is actually an array of **farm
addresses** (verified against the compiled source — it feeds straight into
`program.account.pool.fetchMultiple`), never staking-mint/LP addresses.

**Two verified read bugs — do not call either directly:**
- `getUserBalance(owner)` does `fetchNullable(pda).balanceStaked` with no null guard — throws a
  raw `TypeError` for any wallet that has never staked in the farm.
- `getUserState(owner)` derives the correct `user` PDA via its own (correct, public)
  `getUserPda(owner)` and then ignores it, fetching `owner` — the wallet address — instead. It
  reads the wrong account entirely, silently returning null/garbage even for an active staker.

Safe replacement (what every `farm-*` studio action uses): call the SDK's own `getUserPda(owner)`
yourself, then read that PDA directly off the farm's Anchor `program` — marked `private` in the
`.d.ts`, so reaching it needs an `as any` cast (same boundary-cast convention used elsewhere in
this studio for reaching across an SDK's own version/internals boundary). The static
`getClaimableRewards(owner, farmAddresses, connection)` → `Map<farmAddressB58, {rewardA,
rewardB}>` is itself null-safe for a never-staked wallet (it just omits that farm from the
returned map) and is the right way to compute claimable rewards. It deep-imports
`chunkedGetMultipleAccountInfos` from `@meteora-ag/dynamic-amm-sdk/dist/cjs/src/amm/utils` at
runtime — an undeclared peer dependency this package never lists in its own `package.json` —
but studio already depends on `@meteora-ag/dynamic-amm-sdk` directly, so it resolves (verified:
the whole package imports cleanly end to end, including this deep path).

**Caution — the REST `farming_pool` field can be stale:** `damm-api.meteora.ag/farms`'s
`farming_pool` value for a pool can point to a DIFFERENT (older) farm account than what the CLI
resolves — verified live with pool `7TY9HFLwy8BpS1sGNzYt281YY9WP4V1TzKcYbYft5SD1` (two distinct
farm accounts with different reward-end timestamps). Trust the CLI's resolution
(`farm-get-status --poolAddress ...`); treat the REST field as advisory, not authoritative.

Farm discovery: `getFarmAddressesByPoolAddress(poolAddress, cluster?)` /
`getFarmAddressesByLp(lpAddress, cluster?)` → `{farmAddress, APY, expired}[]` are **REST calls**
to `amm.meteora.ag` (mainnet) or a devnet mirror — there is no on-chain PDA derivation from just
the pool, and `FARMING_API_ENDPOINT` has no `localhost` entry at all, so these always fail on a
local validator or offline. Both THROW (never return an empty array) when the API is
unreachable or has nothing for that pool/LP — catch and degrade to asking for the farm address
directly instead of surfacing the raw exception.

Farm creation is **not wrapped by the SDK** — `initializePool` / `fund` / `authorizeFunder`
would need to be called directly off the exported `IDL`, with the `pool`/vault PDAs
self-derived (seeds aren't part of this older Anchor 0.28 IDL's client metadata — the only
reference for them is the program's Rust CLI, not this SDK or its `.d.ts`). Deliberately out
of scope here — no studio action wraps it.

Studio actions: `farm-*` (stake/unstake/claim/status) — see `studio-actions.md`.
